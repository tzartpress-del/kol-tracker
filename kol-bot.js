const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const https = require("https");
const dns   = require("dns");
const { v4: uuidv4 } = require("uuid");

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
dns.setDefaultResultOrder("ipv4first");

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID          = process.env.CHAT_ID;
const HELIUS_API_KEY   = process.env.HELIUS_API_KEY;
const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;
const GMGN_API_KEY     = process.env.GMGN_API_KEY;

const MC_MIN              = 15000;
const MC_MAX              = 150000;
const POLL_INTERVAL_MS    = 60000;
const ALERT_COOLDOWN_MS   = 3600000;
const MAX_TOKEN_AGE_MS    = 24 * 60 * 60 * 1000;
const REENTRY_MIN_VOLUME  = 50000;
const PUMP_MIN_VOLUME     = 20000;
const PUMP_MIN_PROGRESS   = 60;
const PUMP_MAX_PROGRESS   = 98;
const PUMP_MIN_HOLDERS    = 100;
const ULTRA_MAX_AGE_MS    = 30 * 60 * 1000;
const ULTRA_MIN_VOLUME    = 3000;
const ULTRA_MIN_HOLDERS   = 30;
const ULTRA_MIN_BUY_RATIO = 2;
const CLAUDE_DAILY_LIMIT  = 50;

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
});
const globalAlerted      = new Set();
const alerted            = new Map();
const claudeCache        = new Map();
const performanceTracker = new Map();
const insiderBuys        = {};
const lastSig            = {};
const blacklist          = new Set();
let lastGMGNCall         = 0;
let claudeCallsToday     = 0;
let claudeResetTime      = Date.now() + 86400000;

const botStats = {
  kol:   { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
  pump:  { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
  ultra: { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function fmt(n) {
  if (!n && n !== 0) return "N/A";
  if (n >= 1000000) return `$${(n/1000000).toFixed(2)}M`;
  if (n >= 1000)    return `$${(n/1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtAge(ts) {
  if (!ts) return "N/A";
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  return `${Math.floor(s/86400)}d`;
}

function getVelocity(t) {
  const v5 = t.volume_5m||0, v1 = t.volume||0;
  return parseFloat((v1>0?(v5*12)/v1:0).toFixed(2));
}

function signalLabel(s) {
  if (s>=12) return "ULTRA HIGH";
  if (s>=8)  return "HIGH";
  if (s>=5)  return "MEDIUM";
  return "LOW";
}

function hardFilter(token) {
  if ((token.holder_count||0) < 30) return false;
  if ((token.liquidity||0) < 5000) return false;
  if ((token.rug_ratio||1) > 0.25) return false;
  if ((token.bundler_trader_amount_rate||1) > 0.40) return false;
  if ((token.smart_degen_count||0) === 0) return false;
  if ((token.top_10_holder_rate||0) > 0.40) return false;
  if (blacklist.has(token.creator||"")) return false;
  return true;
}

function calcFinalScore(token, aiConf, insiderCount) {
  let s = 0;
  const smart=token.smart_degen_count||0, kol=token.renowned_count||0;
  const rug=token.rug_ratio||1, liq=token.liquidity||0;
  const buys=token.buy_5m||token.swaps_5m||0, sells=token.sell_5m||0;
  if (smart>=3) s+=3; else if (smart>=1) s+=2;
  if (kol>=2) s+=2; else if (kol>=1) s+=1;
  if (liq>15000) s+=2;
  if (buys>sells*1.5) s+=2;
  if (token.creator_token_status==="hold") s+=1;
  if (token.renounced_mint===1) s+=1;
  if (token.is_wash_trading) s-=3;
  if (rug>0.20) s-=3;
  if ((token.bundler_trader_amount_rate||0)>0.25) s-=2;
  if ((token.holder_count||0)<50) s-=2;
  if (liq<8000) s-=2;
  if (token.creator_token_status==="sell") s-=2;
  s += Math.floor((aiConf||50)/20);
  if (getVelocity(token)>=1.5) s+=1;
  s += insiderCount;
  return s;
}

bot.on("callback_query", async (q) => {
  try {
    if (q.data?.startsWith("skip_")) {
      await bot.answerCallbackQuery(q.id, { text:"Skipped!" });
      await bot.editMessageReplyMarkup(
        { inline_keyboard:[[{text:"Skipped",callback_data:"done"}]] },
        { chat_id:q.message.chat.id, message_id:q.message.message_id }
      );
    }
    if (q.data==="stats") {
      await bot.answerCallbackQuery(q.id);
      const s=botStats;
      await bot.sendMessage(CHAT_ID,
        `*Stats*\nKOL:${s.kol.alerts} 2x:${s.kol.hits2x} 5x:${s.kol.hits5x} 10x:${s.kol.hits10x}\n`+
        `Pump:${s.pump.alerts} 2x:${s.pump.hits2x} 5x:${s.pump.hits5x} 10x:${s.pump.hits10x}\n`+
        `Ultra:${s.ultra.alerts} 2x:${s.ultra.hits2x} 5x:${s.ultra.hits5x} 10x:${s.ultra.hits10x}\n`+
        `Claude:${claudeCallsToday}/${CLAUDE_DAILY_LIMIT}`,
        { parse_mode:"Markdown" }
      );
    }
  } catch(e) {}
});

async function claudeFilter(token) {
  if (Date.now()>claudeResetTime) { claudeCallsToday=0; claudeResetTime=Date.now()+86400000; }
  const cached=claudeCache.get(token.address);
  if (cached&&Date.now()-cached.ts<1800000) return cached.result;
  const rug=token.rug_ratio||0, smart=token.smart_degen_count||0, liq=token.liquidity||0;
  if (rug>0.5)               return { decision:"REJECT", reason:"Rug>50%", risk:"VERY HIGH", confidence:99 };
  if (liq<3000)              return { decision:"REJECT", reason:"Low liq",  risk:"VERY HIGH", confidence:99 };
  if (token.is_wash_trading) return { decision:"REJECT", reason:"Wash",     risk:"VERY HIGH", confidence:99 };
  if (smart>=3&&rug<0.1) {
    const r={decision:"APPROVE",reason:"Strong smart money",risk:"LOW",confidence:92};
    claudeCache.set(token.address,{result:r,ts:Date.now()}); return r;
  }
  if (!CLAUDE_API_KEY||claudeCallsToday>=CLAUDE_DAILY_LIMIT)
    return {decision:"APPROVE",reason:"AI limit",risk:"MEDIUM",confidence:50};
  try {
    claudeCallsToday++;
    const res=await axios.post("https://api.anthropic.com/v1/messages",
      { model:"claude-haiku-4-5-20251001", max_tokens:80,
        messages:[{role:"user",content:
          `Solana memecoin. ${token.symbol} MC:$${token.market_cap} Liq:$${liq} Smart:${smart} Rug:${(rug*100).toFixed(0)}%\nREJECT only rug>40% or no liq. JSON: {"decision":"APPROVE","reason":"brief","risk":"LOW","confidence":75}`
        }]
      },
      { headers:{"x-api-key":CLAUDE_API_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}, timeout:10000 }
    );
    const r=JSON.parse((res.data?.content?.[0]?.text||"").replace(/```json|```/g,"").trim());
    claudeCache.set(token.address,{result:r,ts:Date.now()});
    return r;
  } catch(e) { return {decision:"APPROVE",reason:"AI unavailable",risk:"MEDIUM",confidence:50}; }
}

const INSIDER_WALLETS = {
  "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm": "InsiderAlpha1",
  "4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t": "InsiderAlpha2",
  "8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd": "InsiderAlpha3",
  "9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL": "9SLP_KpKS",
  "84vL38o5zTQjvA2fv7f3MgwXVBm8rBs1QBVXHtranQy5": "2snH_kKuS",
  "BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB": "Axio_TTSk",
};

async function pollInsiderWallets() {
  if (!HELIUS_API_KEY) return;
  for (const [wallet,name] of Object.entries(INSIDER_WALLETS)) {
    try {
      const res=await axios.get(
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=5&type=SWAP`,
        {timeout:8000}
      );
      const txs=res.data||[];
      if (!txs.length) continue;
      const newTxs=lastSig[wallet]?txs.filter(t=>t.signature!==lastSig[wallet]):txs.slice(0,2);
      if (newTxs.length) lastSig[wallet]=txs[0].signature;
      for (const tx of newTxs) {
        const WSOL="So11111111111111111111111111111111111111112";
        const recv=(tx.tokenTransfers||[]).find(t=>t.toUserAccount===wallet&&t.mint!==WSOL);
        if (!recv?.mint) continue;
        if (!insiderBuys[recv.mint]) insiderBuys[recv.mint]={};
        insiderBuys[recv.mint][name]=Date.now();
        log(`Insider ${name} bought ${recv.mint.slice(0,8)}`);
      }
    } catch(e) {}
    await new Promise(r=>setTimeout(r,500));
  }
  const cutoff=Date.now()-7200000;
  for (const [mint,buyers] of Object.entries(insiderBuys)) {
    for (const [k,ts] of Object.entries(buyers)) { if (ts<cutoff) delete insiderBuys[mint][k]; }
    if (!Object.keys(insiderBuys[mint]).length) delete insiderBuys[mint];
  }
}

async function getTokenPrice(mint) {
  try {
    const res=await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`,{timeout:8000});
    const pairs=(res.data?.pairs||[]).filter(p=>p.chainId==="solana");
    if (!pairs.length) return null;
    pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0));
    return {
      price:parseFloat(pairs[0].priceUsd||0),
      mc:pairs[0].fdv||0,
      liquidity:pairs[0].liquidity?.usd||0,
      sells:pairs[0].txns?.h1?.sells||0,
      buys:pairs[0].txns?.h1?.buys||0
    };
  } catch(e) { return null; }
}

async function trackPerformance(mint,alertPrice,alertMC,symbol,alertMsgId,signalType) {
  performanceTracker.set(mint,{alertPrice,alertMC,symbol,alertTime:Date.now(),alertMsgId,signalType,peakX:1,notified2x:false,notified5x:false,notified10x:false});
  const interval=setInterval(async()=>{
    const tracker=performanceTracker.get(mint);
    if (!tracker){clearInterval(interval);return;}
    if (Date.now()-tracker.alertTime>86400000) {
      const v=tracker.peakX>=10?"MOONSHOT":tracker.peakX>=5?"BANGER":tracker.peakX>=2?"WIN":"RUG";
      await bot.sendMessage(CHAT_ID,`*24hr* $${symbol} Peak:${tracker.peakX.toFixed(2)}x — ${v}`,{parse_mode:"Markdown"}).catch(()=>{});
      performanceTracker.delete(mint);clearInterval(interval);return;
    }
    const cur=await getTokenPrice(mint);
    if (!cur?.price||!alertPrice) return;
    const x=cur.price/alertPrice;
    if (x>tracker.peakX) tracker.peakX=x;
    const stats=botStats[signalType]||botStats.kol;
    if (x>=10&&!tracker.notified10x){tracker.notified10x=true;stats.hits10x++;await bot.sendMessage(CHAT_ID,`*10x!* $${symbol} ${x.toFixed(2)}x`,{parse_mode:"Markdown",reply_to_message_id:alertMsgId}).catch(()=>{});}
    else if (x>=5&&!tracker.notified5x){tracker.notified5x=true;stats.hits5x++;await bot.sendMessage(CHAT_ID,`*5x!* $${symbol} ${x.toFixed(2)}x`,{parse_mode:"Markdown",reply_to_message_id:alertMsgId}).catch(()=>{});}
    else if (x>=2&&!tracker.notified2x){tracker.notified2x=true;stats.hits2x++;await bot.sendMessage(CHAT_ID,`*2x!* $${symbol} ${x.toFixed(2)}x`,{parse_mode:"Markdown",reply_to_message_id:alertMsgId}).catch(()=>{});}
    if (cur.liquidity<2000&&tracker.peakX>1.5){
      await bot.sendMessage(CHAT_ID,`*LIQ WARNING* $${symbol} exit!`,{parse_mode:"Markdown",reply_to_message_id:alertMsgId}).catch(()=>{});
      performanceTracker.delete(mint);clearInterval(interval);
    }
  },3*60*1000);
}

// ─── GMGN FETCH ───────────────────────────────────────────────────────────────
// Standard Auth only — NO X-Signature for /v1/market/* and /v1/trenches
// Only needs: X-APIKEY header + timestamp + client_id query params
const GMGN_GAP_MS=2000;
let gmgnBlocked=false,gmgnBlockUntil=0;
const ipv4Agent=new https.Agent({family:4,keepAlive:true});
const axiosGMGN=axios.create({httpsAgent:ipv4Agent,timeout:20000,maxRedirects:2,validateStatus:()=>true});

async function fetchGMGN(subPath, params={}) {
  if (gmgnBlocked&&Date.now()<gmgnBlockUntil){
    log(`GMGN blocked ${Math.round((gmgnBlockUntil-Date.now())/1000)}s`);
    return null;
  }
  gmgnBlocked=false;
  const wait=GMGN_GAP_MS-(Date.now()-lastGMGNCall);
  if (wait>0) await new Promise(r=>setTimeout(r,wait));
  lastGMGNCall=Date.now();

  try {
    const timestamp=Math.floor(Date.now()/1000);
    const client_id=uuidv4();
    const allParams={...params, timestamp:String(timestamp), client_id};
    const qs=Object.entries(allParams).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join("&");
    const url=`https://openapi.gmgn.ai${subPath}?${qs}`;

    log(`GET ${url.slice(0,120)}`);

    const res=await axiosGMGN.get(url,{
      headers:{ "X-APIKEY":GMGN_API_KEY, "Accept":"application/json" }
    });

    if (res.status===429){log("GMGN 429");gmgnBlocked=true;gmgnBlockUntil=Date.now()+60000;return null;}
    if (res.status===403){log("GMGN 403");gmgnBlocked=true;gmgnBlockUntil=Date.now()+300000;return null;}
    if (res.status===401){log(`GMGN 401: ${JSON.stringify(res.data)?.slice(0,200)}`);return null;}
    if (res.status===404){log(`GMGN 404: ${subPath} body:${JSON.stringify(res.data)?.slice(0,200)}`);return null;}
    if (res.status===405){
      log(`GMGN 405 on ${subPath} — trying POST`);
      const res2=await axiosGMGN.post(url,{},{headers:{"X-APIKEY":GMGN_API_KEY,"Accept":"application/json","Content-Type":"application/json"}});
      if (res2.status===200&&res2.data?.code===0){log(`GMGN POST OK: ${subPath}`);return res2.data;}
      log(`GMGN POST also failed ${res2.status}: ${JSON.stringify(res2.data)?.slice(0,100)}`);return null;
    }
    if (res.status!==200){log(`GMGN ${res.status}: ${JSON.stringify(res.data)?.slice(0,100)}`);return null;}
    if (typeof res.data==="string"){log("GMGN HTML");gmgnBlocked=true;gmgnBlockUntil=Date.now()+120000;return null;}
    if (res.data?.code!==undefined&&res.data.code!==0){log(`GMGN err: ${res.data.error} ${res.data.message}`);return null;}

    log(`GMGN OK: ${subPath}`);
    return res.data;
  } catch(e){log(`GMGN fetch: ${e.message}`);return null;}
}

// ─── KOL — /v1/market/rank ────────────────────────────────────────────────────
async function getKOLSignals() {
  const seen=new Set(), results=[];
  for (const params of [
    {chain:"sol",interval:"1h",orderby:"smart_degen_count",direction:"desc",limit:"100"},
    {chain:"sol",interval:"1h",orderby:"open_timestamp",direction:"desc",limit:"100"},
  ]) {
    const data=await fetchGMGN("/v1/market/rank",params);
    if (!data) continue;
    const list=data?.data?.rank||data?.data?.tokens||data?.data||[];
    for (const t of (Array.isArray(list)?list:[])) {
      if (!t.address||seen.has(t.address)||globalAlerted.has(t.address)) continue;
      seen.add(t.address);
      const mc=t.market_cap||0;
      const tokenAge=t.open_timestamp?(Date.now()-t.open_timestamp*1000):null;
      const isNew=tokenAge!==null&&tokenAge<=MAX_TOKEN_AGE_MS;
      const isReentry=!isNew&&(t.volume||0)>=REENTRY_MIN_VOLUME&&(t.smart_degen_count||0)>=2;
      if (mc>=MC_MIN&&mc<=MC_MAX&&(t.smart_degen_count||0)>=1&&(t.renowned_count||0)>=1&&(isNew||isReentry)&&!blacklist.has(t.creator||""))
        results.push({...t,alertType:isReentry?"REENTRY":"KOL",tokenAge});
    }
  }
  return results.sort((a,b)=>(b.smart_degen_count||0)-(a.smart_degen_count||0));
}

// ─── TRENCHES — /v1/trenches (one call, returns new_creation + pump + completed)
async function getTrenchesSignals() {
  // Only chain is required per docs — no extra params
  const data=await fetchGMGN("/v1/trenches",{chain:"sol"});
  if (!data) return {pump:[],ultra:[]};

  const pumpList = data?.data?.pump        || [];
  const newList  = data?.data?.new_creation || [];
  const pump=[], ultra=[];

  for (const t of pumpList) {
    if (!t.address||globalAlerted.has(t.address)) continue;
    const progress=t.launchpad_status?.bonding_curve_percentage||t.progress||0;
    if (progress>=PUMP_MIN_PROGRESS&&progress<=PUMP_MAX_PROGRESS&&
        (t.volume||0)>=PUMP_MIN_VOLUME&&(t.holder_count||t.holders||0)>=PUMP_MIN_HOLDERS&&
        (t.rug_ratio||0)<0.3&&!t.is_wash_trading)
      pump.push({...t,alertType:"PUMP",progress});
  }

  for (const t of newList) {
    if (!t.address||globalAlerted.has(t.address)) continue;
    const ageMs=t.open_timestamp?Date.now()-t.open_timestamp*1000:null;
    if (!ageMs||ageMs>ULTRA_MAX_AGE_MS) continue;
    const progress=t.launchpad_status?.bonding_curve_percentage||t.progress||0;
    const buys=t.buy_5m||t.swaps_5m||0, sells=t.sell_5m||0;
    const buyRatio=sells>0?buys/sells:buys;
    if (progress>=3&&progress<=60&&(t.volume||t.volume_5m||0)>=ULTRA_MIN_VOLUME&&
        (t.holder_count||t.holders||0)>=ULTRA_MIN_HOLDERS&&buyRatio>=ULTRA_MIN_BUY_RATIO&&
        (t.rug_ratio||0)<0.2&&!t.is_wash_trading)
      ultra.push({...t,alertType:"ULTRA_EARLY",ageMs,progress,buys,sells,buyRatio});
  }

  return {
    pump:pump.sort((a,b)=>(b.volume||0)-(a.volume||0)).slice(0,10),
    ultra:ultra.sort((a,b)=>b.buyRatio-a.buyRatio).slice(0,5),
  };
}

function buildKeyboard(mint,isPump) {
  return {inline_keyboard:[
    [{text:"BUY 0.1 SOL via Trojan",url:`https://t.me/solana_trojanbot?start=ca_${mint}`}],
    [{text:"DexScreener",url:`https://dexscreener.com/solana/${mint}`},{text:"GMGN",url:`https://gmgn.ai/sol/token/${mint}`}],
    [{text:isPump?"PumpFun":"Axiom",url:isPump?`https://pump.fun/${mint}`:`https://axiom.trade/t/${mint}`},{text:"Stats",callback_data:"stats"}],
    [{text:"Skip",callback_data:`skip_${mint.slice(0,20)}`}],
  ]};
}

async function sendKOLAlert(token,ai) {
  const mint=token.address,sym=token.symbol||"???";
  const score=calcFinalScore(token,ai.confidence,Object.keys(insiderBuys[mint]||{}).length);
  const insiders=Object.keys(insiderBuys[mint]||{});
  const msg=
    `*${token.alertType==="REENTRY"?"RE-ENTRY":"KOL"} SIGNAL* — ${signalLabel(score)}\n`+
    `Score:${score} | ${ai.risk} ${ai.confidence}%\n\n*$${sym}*\n\`${mint}\`\n`+
    `Age:${fmtAge(token.open_timestamp?token.open_timestamp*1000:null)} | Holders:${token.holder_count||"N/A"}\n`+
    `Price:${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"} | MC:${fmt(token.market_cap||0)}\n`+
    `Vol:${fmt(token.volume||0)} | Liq:${fmt(token.liquidity||0)}\n`+
    `Smart:${token.smart_degen_count||0} | KOL:${token.renowned_count||0} | Rug:${((token.rug_ratio||0)*100).toFixed(0)}%\n`+
    (insiders.length?`Insiders: ${insiders.join(", ")}\n`:"")+`\nSnipe 0.1 SOL?`;
  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,false)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"kol");
  botStats.kol.alerts++;
  log(`KOL: $${sym} score:${score}`);
}

async function sendPumpAlert(token,ai) {
  const mint=token.address,sym=token.symbol||"???";
  const progress=token.progress||0;
  const bar="X".repeat(Math.floor(progress/10))+".".repeat(10-Math.floor(progress/10));
  const msg=
    `*PUMPFUN PRE-BOND* — ${progress>=90?"MIGRATING SOON":progress>=75?"FILLING FAST":"EARLY"}\n`+
    `${ai.risk} ${ai.confidence}%\n\n*$${sym}*\n\`${mint}\`\n`+
    `[${bar}] ${progress.toFixed(1)}%\n`+
    `Price:${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"} | MC:${fmt(token.market_cap||0)} | Vol:${fmt(token.volume||0)}\n`+
    `Smart:${token.smart_degen_count||0} | KOL:${token.renowned_count||0}\nBuy before Raydium migration!`;
  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,true)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"pump");
  botStats.pump.alerts++;
  log(`Pump: $${sym} ${progress.toFixed(0)}%`);
}

async function sendUltraAlert(token,ai) {
  const mint=token.address,sym=token.symbol||"???";
  const ageMin=Math.floor((token.ageMs||0)/60000);
  const progress=token.progress||0;
  const bar="X".repeat(Math.floor(progress/10))+".".repeat(10-Math.floor(progress/10));
  const msg=
    `*ULTRA EARLY* — ${token.buyRatio>=10?"INSANE":token.buyRatio>=5?"VERY HIGH":"HIGH"}\n`+
    `${ai.risk} ${ai.confidence}%\n\n*$${sym}*\n\`${mint}\`\n`+
    `Age:${ageMin}m | Holders:${token.holder_count||"N/A"}\n`+
    `[${bar}] ${progress.toFixed(1)}%\n`+
    `Vol:${fmt(token.volume||token.volume_5m||0)} | B/S:${token.buyRatio?token.buyRatio.toFixed(1):"N/A"}:1\n`+
    `Price:${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"} | MC:${fmt(token.market_cap||0)}\nAlways DYOR`;
  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,true)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"ultra");
  botStats.ultra.alerts++;
  log(`Ultra: $${sym} age:${ageMin}m`);
}

async function scan() {
  log("Scanning...");
  pollInsiderWallets().catch(()=>{});
  const kolTokens=await getKOLSignals();
  const {pump:pumpTokens,ultra:ultraTokens}=await getTrenchesSignals();
  log(`KOL:${kolTokens.length} Pump:${pumpTokens.length} Ultra:${ultraTokens.length}`);

  const allTokens=[
    ...ultraTokens.map(t=>({...t,_type:"ultra"})),
    ...kolTokens.map(t=>({...t,_type:"kol"})),
    ...pumpTokens.map(t=>({...t,_type:"pump"})),
  ];
  const filtered=allTokens.filter(t=>t._type==="ultra"||t._type==="pump"||hardFilter(t));
  const aiResults=await Promise.all(filtered.map(t=>claudeFilter(t)));
  const scored=filtered
    .map((t,i)=>({...t,_ai:aiResults[i],_score:calcFinalScore(t,aiResults[i].confidence,Object.keys(insiderBuys[t.address]||{}).length)}))
    .filter((t,i)=>aiResults[i]?.decision!=="REJECT")
    .sort((a,b)=>b._score-a._score);

  let sent=0;
  for (const token of scored) {
    if (sent>=3) break;
    const mint=token.address;
    if (globalAlerted.has(mint)) continue;
    if (alerted.has(mint)&&Date.now()-alerted.get(mint)<ALERT_COOLDOWN_MS) continue;
    globalAlerted.add(mint);alerted.set(mint,Date.now());
    try {
      if (token._type==="ultra") await sendUltraAlert(token,token._ai);
      else if (token._type==="pump") await sendPumpAlert(token,token._ai);
      else await sendKOLAlert(token,token._ai);
      sent++;
    } catch(e){log(`Alert error: ${e.message}`);}
    await new Promise(r=>setTimeout(r,3000));
  }

  if (globalAlerted.size>500) [...globalAlerted].slice(0,100).forEach(m=>globalAlerted.delete(m));
  const now=Date.now();
  for (const [k,v] of claudeCache.entries()){if(now-v.ts>1800000)claudeCache.delete(k);}
  for (const [k,ts] of alerted.entries()){if(now-ts>ALERT_COOLDOWN_MS)alerted.delete(k);}
}

async function main() {
  log("KOL Tracker v17 — /v1/market/rank + /v1/trenches fixed 405");
  try { const r=await axios.get("https://api.ipify.org?format=json",{timeout:5000}); log(`Railway IP: ${r.data.ip}`); } catch(e){}
  log(`GMGN_API_KEY: ${GMGN_API_KEY?"SET":"MISSING"}`);

  await bot.sendMessage(CHAT_ID,
    `*KOL Tracker v17 Online*\n\nEndpoints:\n/v1/market/rank ✅\n/v1/trenches (405 fix)\n\nScan: 60s`,
    {parse_mode:"Markdown"}
  );

  await scan();
  setInterval(scan,POLL_INTERVAL_MS);
}

main().catch(e=>{log(`Fatal: ${e.message}`);process.exit(1);});
