const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const https = require("https");
const dns = require("dns");
const { v4: uuidv4 } = require("uuid");

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
dns.setDefaultResultOrder("ipv4first");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const GMGN_API_KEY   = process.env.GMGN_API_KEY;

// ─── FILTERS ─────────────────────────────────────────────────────────────────
const MC_MIN             = 10000;
const MC_MAX             = 300000;
const POLL_INTERVAL_MS   = 60000;
const ALERT_COOLDOWN_MS  = 3600000;
const MAX_TOKEN_AGE_MS   = 24 * 60 * 60 * 1000;
const PUMP_MIN_VOLUME    = 10000;
const PUMP_MIN_PROGRESS  = 40;
const PUMP_MAX_PROGRESS  = 98;
const PUMP_MIN_HOLDERS   = 50;
const ULTRA_MAX_AGE_MS   = 30 * 60 * 1000;
const ULTRA_MIN_VOLUME   = 1000;
const ULTRA_MIN_HOLDERS  = 15;
const ULTRA_MIN_BUY_RATIO = 1.5;
const CLAUDE_DAILY_LIMIT = 50;

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const globalAlerted      = new Set();
const alerted            = new Map();
const claudeCache        = new Map();
const performanceTracker = new Map();
const insiderBuys        = {};
const lastSig            = {};
const blacklist          = new Set();
let claudeCallsToday     = 0;
let claudeResetTime      = Date.now() + 86400000;
let lastOpenAPICall      = 0;

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
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  return `${Math.floor(s/86400)}d`;
}

function getVelocity(t) {
  const v5 = t.volume_5m||0, v1 = t.volume||0;
  return parseFloat((v1>0?(v5*12)/v1:0).toFixed(2));
}

function velocityLabel(v) {
  if (v >= 2.0) return "EXPLOSIVE";
  if (v >= 1.0) return "STABLE";
  if (v <  0.5) return "DYING";
  return "MODERATE";
}

function signalLabel(s) {
  if (s>=12) return "ULTRA HIGH";
  if (s>=8)  return "HIGH";
  if (s>=5)  return "MEDIUM";
  return "LOW";
}

function hardFilter(token) {
  // Only use fields confirmed in OpenAPI response
  const liq = token.liquidity || 0;
  const vol = token.volume || 0;
  const mc  = token.market_cap || 0;
  const chg = token.price_change_percent1h || 0;

  if (liq < 3000)   return false;  // must have some liquidity
  if (vol < 1000)   return false;  // must have some volume
  if (mc < MC_MIN)  return false;  // below min market cap
  if (mc > MC_MAX)  return false;  // above max market cap
  if (chg < -80)    return false;  // dumping hard
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

// ─── CALLBACKS ────────────────────────────────────────────────────────────────
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
        `📊 *GOD MODE Stats*\n\n`+
        `KOL: ${s.kol.alerts} | 2x:${s.kol.hits2x} 5x:${s.kol.hits5x} 10x:${s.kol.hits10x}\n`+
        `Pump: ${s.pump.alerts} | 2x:${s.pump.hits2x} 5x:${s.pump.hits5x} 10x:${s.pump.hits10x}\n`+
        `Ultra: ${s.ultra.alerts} | 2x:${s.ultra.hits2x} 5x:${s.ultra.hits5x} 10x:${s.ultra.hits10x}\n`+
        `Claude: ${claudeCallsToday}/${CLAUDE_DAILY_LIMIT} | Tracking: ${performanceTracker.size}`,
        { parse_mode:"Markdown" }
      );
    }
  } catch(e) {}
});

// ─── CLAUDE ───────────────────────────────────────────────────────────────────
async function claudeFilter(token) {
  if (Date.now()>claudeResetTime) { claudeCallsToday=0; claudeResetTime=Date.now()+86400000; }
  const cached=claudeCache.get(token.address);
  if (cached&&Date.now()-cached.ts<1800000) return cached.result;
  const rug=token.rug_ratio||0, smart=token.smart_degen_count||0, liq=token.liquidity||0;
  if (rug>0.5)               return { decision:"REJECT", reason:"Rug>50%",     risk:"VERY HIGH", confidence:99 };
  if (liq<3000)              return { decision:"REJECT", reason:"Liq too low",  risk:"VERY HIGH", confidence:99 };
  if (token.is_wash_trading) return { decision:"REJECT", reason:"Wash trading", risk:"VERY HIGH", confidence:99 };
  if (smart>=3&&rug<0.1) {
    const r={decision:"APPROVE",reason:"Strong smart money",risk:"LOW",confidence:92};
    claudeCache.set(token.address,{result:r,ts:Date.now()}); return r;
  }
  if (!CLAUDE_API_KEY||claudeCallsToday>=CLAUDE_DAILY_LIMIT)
    return {decision:"APPROVE",reason:"AI limit reached",risk:"MEDIUM",confidence:50};
  try {
    claudeCallsToday++;
    const res=await axios.post("https://api.anthropic.com/v1/messages",
      { model:"claude-haiku-4-5-20251001", max_tokens:80,
        messages:[{role:"user",content:
          `Solana memecoin filter. Be LENIENT. Only reject clear rugs.\n${token.symbol} MC:$${token.market_cap} Liq:$${liq} Smart:${smart} Rug:${(rug*100).toFixed(0)}% Holders:${token.holder_count||0}\nREJECT only rug>40% or wash trading. JSON: {"decision":"APPROVE","reason":"brief","risk":"LOW/MEDIUM/HIGH","confidence":75}`
        }]
      },
      { headers:{"x-api-key":CLAUDE_API_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"}, timeout:10000 }
    );
    const r=JSON.parse((res.data?.content?.[0]?.text||"").replace(/```json|```/g,"").trim());
    claudeCache.set(token.address,{result:r,ts:Date.now()});
    log(`Claude: $${token.symbol} → ${r.decision} ${r.risk} ${r.confidence}%`);
    return r;
  } catch(e) {
    log(`Claude error: ${e.message}`);
    return {decision:"APPROVE",reason:"AI unavailable",risk:"MEDIUM",confidence:50};
  }
}

// ─── INSIDER WALLETS ─────────────────────────────────────────────────────────
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
      const res=await axios.get(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=5&type=SWAP`,{timeout:8000});
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

// ─── PERFORMANCE TRACKER ─────────────────────────────────────────────────────
async function getTokenPrice(mint) {
  try {
    const res=await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`,{timeout:8000});
    const pairs=(res.data?.pairs||[]).filter(p=>p.chainId==="solana");
    if (!pairs.length) return null;
    pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0));
    return { price:parseFloat(pairs[0].priceUsd||0), mc:pairs[0].fdv||0, liquidity:pairs[0].liquidity?.usd||0, sells:pairs[0].txns?.h1?.sells||0, buys:pairs[0].txns?.h1?.buys||0 };
  } catch(e) { return null; }
}

async function trackPerformance(mint,alertPrice,alertMC,symbol,alertMsgId,signalType) {
  performanceTracker.set(mint,{alertPrice,alertMC,symbol,alertTime:Date.now(),alertMsgId,signalType,peakX:1,notified2x:false,notified5x:false,notified10x:false,notifiedDistrib:false});
  const interval=setInterval(async()=>{
    const tracker=performanceTracker.get(mint);
    if (!tracker){clearInterval(interval);return;}
    if (Date.now()-tracker.alertTime>86400000) {
      const v=tracker.peakX>=10?"MOONSHOT":tracker.peakX>=5?"BANGER":tracker.peakX>=2?"WIN":tracker.peakX>=1?"BREAKEVEN":"RUG";
      await bot.sendMessage(CHAT_ID,`📋 Final: $${symbol}\nPeak: ${tracker.peakX.toFixed(2)}x — ${v}`,{parse_mode:"Markdown"}).catch(()=>{});
      performanceTracker.delete(mint);clearInterval(interval);return;
    }
    const cur=await getTokenPrice(mint);
    if (!cur?.price||!alertPrice) return;
    const x=cur.price/alertPrice;
    if (x>tracker.peakX) tracker.peakX=x;
    const stats=botStats[signalType]||botStats.kol;
    if (cur.sells>cur.buys*2&&x>1.5&&!tracker.notifiedDistrib) {
      tracker.notifiedDistrib=true;
      await bot.sendMessage(CHAT_ID,`⚠️ DISTRIBUTION $${symbol} — sell pressure! ${x.toFixed(2)}x\n🚨 Consider exiting!`,{reply_to_message_id:alertMsgId}).catch(()=>{});
    }
    if (x>=10&&!tracker.notified10x){tracker.notified10x=true;stats.hits10x++;await bot.sendMessage(CHAT_ID,`🌙 10x! $${symbol} up ${x.toFixed(2)}x!\nMC:${fmt(cur.mc)}\nTake profit!`,{reply_to_message_id:alertMsgId}).catch(()=>{});}
    else if (x>=5&&!tracker.notified5x){tracker.notified5x=true;stats.hits5x++;await bot.sendMessage(CHAT_ID,`🚀 5x! $${symbol} up ${x.toFixed(2)}x!\nMC:${fmt(cur.mc)}`,{reply_to_message_id:alertMsgId}).catch(()=>{});}
    else if (x>=2&&!tracker.notified2x){tracker.notified2x=true;stats.hits2x++;await bot.sendMessage(CHAT_ID,`✅ 2x! $${symbol} up ${x.toFixed(2)}x!`,{reply_to_message_id:alertMsgId}).catch(()=>{});}
    if (cur.liquidity<2000&&tracker.peakX>1.5){
      await bot.sendMessage(CHAT_ID,`⚠️ LIQ WARNING $${symbol} — exit now!`,{reply_to_message_id:alertMsgId}).catch(()=>{});
      performanceTracker.delete(mint);clearInterval(interval);
    }
  },3*60*1000);
}

// ─── FETCHERS ─────────────────────────────────────────────────────────────────
// Method 1: Original public web API (no auth needed, may get Cloudflare blocked)
const browserHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json",
  "Referer": "https://gmgn.ai/",
  "Origin": "https://gmgn.ai",
};

async function fetchPublic(url) {
  try {
    const res=await axios.get(url,{headers:browserHeaders,timeout:12000});
    if (res.status===200&&res.data) return res.data;
    log(`Public fetch ${res.status}: ${url.slice(0,60)}`);
    return null;
  } catch(e) {
    log(`Public fetch error: ${e.message} — ${url.slice(0,60)}`);
    return null;
  }
}

// Method 2: OpenAPI (confirmed working — /v1/market/rank GET, /v1/trenches POST)
const ipv4Agent=new https.Agent({family:4,keepAlive:true});
const axiosAPI=axios.create({httpsAgent:ipv4Agent,timeout:20000,validateStatus:()=>true});

async function fetchOpenAPI(subPath, params={}, method="GET") {
  const wait=2000-(Date.now()-lastOpenAPICall);
  if (wait>0) await new Promise(r=>setTimeout(r,wait));
  lastOpenAPICall=Date.now();
  try {
    const ts=Math.floor(Date.now()/1000);
    const cid=uuidv4();
    // For GET: params go in query string
    // For POST: auth params go in query string, data params go in body
    const authParams={timestamp:String(ts),client_id:cid};
    const qs=Object.entries(authParams).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join("&");
    const url=`https://openapi.gmgn.ai${subPath}?${qs}`;
    const headers={"X-APIKEY":GMGN_API_KEY,"Accept":"application/json","Content-Type":"application/json"};

    let res;
    if (method==="POST") {
      // For POST: chain goes in BOTH query string and body
      // Auth params (timestamp, client_id) in query string
      // Data params in JSON body
      // chain must also be in query string per API requirements
      const chain = params.chain || "sol";
      const postQs = `${qs}&chain=${chain}`;
      const postUrl = `https://openapi.gmgn.ai${subPath}?${postQs}`;
      log(`POST ${postUrl.slice(0,100)} body:${JSON.stringify(params)}`);
      res=await axiosAPI.post(postUrl, params, {headers});
    } else {
      // Send params as query string for GET
      const allParams={...params,...authParams};
      const fullQs=Object.entries(allParams).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join("&");
      const getUrl=`https://openapi.gmgn.ai${subPath}?${fullQs}`;
      res=await axiosAPI.get(getUrl,{headers});
    }

    if (res.status===405&&method==="GET") return fetchOpenAPI(subPath,params,"POST");
    if (res.status!==200||typeof res.data==="string") {
      log(`OpenAPI ${res.status}: ${JSON.stringify(res.data)?.slice(0,100)}`);
      return null;
    }
    if (res.data?.code!==0) { log(`OpenAPI err: ${res.data?.error} ${res.data?.message}`); return null; }
    log(`OpenAPI OK: ${subPath}`);
    return res.data;
  } catch(e) { log(`OpenAPI error: ${e.message}`); return null; }
}

// Extract token list from any response shape
function extractList(data) {
  if (!data) return [];
  const d=data.data||data;
  if (Array.isArray(d.rank))   return d.rank;
  if (Array.isArray(d.tokens)) return d.tokens;
  if (Array.isArray(d.list))   return d.list;
  if (Array.isArray(d.data))   return d.data;
  if (Array.isArray(d))        return d;
  return [];
}

// ─── KOL SIGNALS — tries public API first, falls back to OpenAPI ──────────────
async function getKOLSignals() {
  const seen=new Set(), results=[];

  // Try public web API first (original working method)
  const publicURLs=[
    `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=smart_degen_count&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=100`,
    `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
  ];
  let publicWorked=false;
  const pubResponses=await Promise.allSettled(publicURLs.map(u=>fetchPublic(u)));
  for (const r of pubResponses) {
    if (r.status!=="fulfilled"||!r.value) continue;
    const list=r.value?.data?.rank||[];
    if (list.length>0) { publicWorked=true; processKOLList(list,seen,results); }
  }

  // Fall back to OpenAPI if public failed
  if (!publicWorked) {
    log("Public KOL API failed — using OpenAPI fallback");
    for (const params of [
      {chain:"sol",interval:"1h",orderby:"smart_degen_count",direction:"desc",limit:"100"},
      {chain:"sol",interval:"1h",orderby:"open_timestamp",direction:"desc",limit:"100"},
    ]) {
      const data=await fetchOpenAPI("/v1/market/rank",params);
      if (!data) continue;
      processKOLList(extractList(data),seen,results);
    }
  }

  return results.sort((a,b)=>(b.smart_degen_count||0)-(a.smart_degen_count||0));
}

function processKOLList(list, seen, results) {
  if (list.length > 0) log(`KOL sample fields: ${JSON.stringify(Object.keys(list[0])).slice(0,200)}`);
  for (const t of list) {
    if (!t.address||seen.has(t.address)||globalAlerted.has(t.address)) continue;
    seen.add(t.address);
    const mc=t.market_cap||0;
    const tokenAge=t.open_timestamp?(Date.now()-t.open_timestamp*1000):null;
    const isNew=tokenAge!==null&&tokenAge<=MAX_TOKEN_AGE_MS;
    const isReentry=!isNew&&(t.volume||0)>=25000&&(t.smart_degen_count||0)>=2;
    if (mc>=MC_MIN&&mc<=MC_MAX&&(t.smart_degen_count||0)>=1&&(t.renowned_count||0)>=1&&(isNew||isReentry)&&!blacklist.has(t.creator||""))
      results.push({...t,alertType:isReentry?"REENTRY":"KOL",tokenAge});
  }
}

// ─── PUMP SIGNALS — tries public API first, falls back to OpenAPI ─────────────
async function getPumpSignals() {
  const seen=new Set(), results=[];

  // Try public API first
  const publicURLs=[
    `https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=volume&direction=desc&filters[]=not_honeypot&limit=100`,
    `https://gmgn.ai/api/v1/mutil_window_token_list/sol?type=near_completion&orderby=volume&direction=desc&limit=50`,
  ];
  let publicWorked=false;
  const pubResponses=await Promise.allSettled(publicURLs.map(u=>fetchPublic(u)));
  for (const r of pubResponses) {
    if (r.status!=="fulfilled"||!r.value) continue;
    const list=r.value?.data?.rank||r.value?.data?.token_list||r.value?.data||[];
    if (!Array.isArray(list)||!list.length) continue;
    publicWorked=true;
    processPumpList(list,seen,results);
  }

  // Fall back to OpenAPI — POST with correct body
  if (!publicWorked) {
    log("Public Pump API failed — using OpenAPI fallback");
    const data=await fetchOpenAPI("/v1/trenches",{chain:"sol",limit:80},"POST");
    if (data) {
      log(`Trenches ALL keys: ${JSON.stringify(Object.keys(data?.data||{}))}`);
      const pumpList=data?.data?.pump||data?.data?.near_completion||data?.data?.completing||[];
      log(`Trenches pump list length: ${pumpList.length}`);
      processPumpList(pumpList,seen,results);
    }
  }

  return results.sort((a,b)=>(b.volume_1h||b.volume||0)-(a.volume_1h||a.volume||0)).slice(0,10);
}

function processPumpList(list, seen, results) {
  for (const t of list) {
    if (!t.address||seen.has(t.address)||globalAlerted.has(t.address)) continue;
    seen.add(t.address);
    // Trenches uses different field names per docs
    const progress=t.launchpad_status?.bonding_curve_percentage||t.graduation_progress||t.progress||0;
    const volume=t.volume_1h||t.volume_24h||t.volume||0;
    const holders=t.holder_count||0;
    const mc=t.usd_market_cap||t.market_cap||0;
    if (progress>=PUMP_MIN_PROGRESS&&progress<=PUMP_MAX_PROGRESS&&
        volume>=PUMP_MIN_VOLUME&&holders>=PUMP_MIN_HOLDERS&&
        (t.rug_ratio||0)<0.3&&!t.is_wash_trading)
      results.push({...t,alertType:"PUMP",progress,market_cap:mc,volume:volume});
  }
}

// ─── ULTRA SIGNALS — tries public API first, falls back to OpenAPI ────────────
async function getUltraSignals() {
  const seen=new Set(), results=[];

  // Try public API first
  const publicURLs=[
    `https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
    `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/5m?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
  ];
  let publicWorked=false;
  const pubResponses=await Promise.allSettled(publicURLs.map(u=>fetchPublic(u)));
  for (const r of pubResponses) {
    if (r.status!=="fulfilled"||!r.value) continue;
    const list=r.value?.data?.rank||r.value?.data?.token_list||r.value?.data||[];
    if (!Array.isArray(list)||!list.length) continue;
    publicWorked=true;
    processUltraList(list,seen,results);
  }

  // Fall back to OpenAPI — POST with correct body
  if (!publicWorked) {
    log("Public Ultra API failed — using OpenAPI fallback");
    const data=await fetchOpenAPI("/v1/trenches",{chain:"sol",limit:80},"POST");
    if (data) {
      log(`Trenches ALL keys (ultra): ${JSON.stringify(Object.keys(data?.data||{}))}`);
      const newList=data?.data?.new_creation||data?.data?.new||data?.data?.newCreation||[];
      log(`Trenches new_creation list length: ${newList.length}`);
      processUltraList(newList,seen,results);
    }
  }

  return results.sort((a,b)=>b.buyRatio-a.buyRatio).slice(0,5);
}

function processUltraList(list, seen, results) {
  for (const t of list) {
    if (!t.address||seen.has(t.address)||globalAlerted.has(t.address)) continue;
    seen.add(t.address);
    // Trenches uses created_timestamp, not open_timestamp
    const ageMs=t.created_timestamp?(Date.now()-t.created_timestamp*1000):
                t.open_timestamp?(Date.now()-t.open_timestamp*1000):null;
    if (!ageMs||ageMs>ULTRA_MAX_AGE_MS) continue;
    const progress=t.launchpad_status?.bonding_curve_percentage||t.progress||0;
    const volume=t.volume_1h||t.volume_24h||t.volume||t.volume_5m||0;
    const holders=t.holder_count||0;
    const buys=t.buys_24h||t.buy_5m||t.swaps_5m||0;
    const sells=t.sells_24h||t.sell_5m||0;
    const buyRatio=sells>0?buys/sells:buys;
    const mc=t.usd_market_cap||t.market_cap||0;
    if (progress>=3&&progress<=60&&
        volume>=ULTRA_MIN_VOLUME&&holders>=ULTRA_MIN_HOLDERS&&
        buyRatio>=ULTRA_MIN_BUY_RATIO&&
        (t.rug_ratio||0)<0.2&&!t.is_wash_trading)
      results.push({...t,alertType:"ULTRA_EARLY",ageMs,progress,buys,sells,buyRatio,market_cap:mc,volume:volume});
  }
}

// ─── KEYBOARD ─────────────────────────────────────────────────────────────────
function buildKeyboard(mint,isPump) {
  return {inline_keyboard:[
    [{text:"🚀 BUY 0.1 SOL via Trojan",url:`https://t.me/solana_trojanbot?start=ca_${mint}`}],
    [{text:"📊 DexScreener",url:`https://dexscreener.com/solana/${mint}`},{text:"🔍 GMGN",url:`https://gmgn.ai/sol/token/${mint}`}],
    [{text:isPump?"🎯 PumpFun":"⚡ Axiom",url:isPump?`https://pump.fun/${mint}`:`https://axiom.trade/t/${mint}`},{text:"📈 Stats",callback_data:"stats"}],
    [{text:"❌ Skip",callback_data:`skip_${mint.slice(0,20)}`}],
  ]};
}

// ─── ALERTS ───────────────────────────────────────────────────────────────────
async function sendKOLAlert(token,ai) {
  const mint=token.address, sym=token.symbol||"???";
  const score=calcFinalScore(token,ai.confidence,Object.keys(insiderBuys[mint]||{}).length);
  const insiders=Object.keys(insiderBuys[mint]||{});
  const isReentry=token.alertType==="REENTRY";
  const riskEmoji=ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";
  const devStatus=token.creator_token_status==="sell"?"Sold":token.creator_token_status==="hold"?"Holding":"N/A";
  const mintR=token.renounced_mint===1?"Yes":"No";
  const vel=getVelocity(token);
  const netflow=(token.buy_5m||0)>(token.sell_5m||0)?"Accumulating":"Selling";
  const change1h=token.price_change_percent1h||0;
  const insiderStr=insiders.length>0?`\nInsiders: ${insiders.join(", ")}`:"";

  const msg=
    `${isReentry?"🔄 REENTRY SIGNAL":"🚨 KOL SIGNAL"} — ${signalLabel(score)}\n`+
    `Score: ${score} | AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%\n\n`+
    `*$${sym}*\n\`${mint}\`\n`+
    `Age: ${fmtAge(token.open_timestamp?token.open_timestamp*1000:null)} | Holders: ${token.holder_count||"N/A"}\n\n`+
    `📊 *Token Details*\n`+
    `├ PRICE:    ${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"}\n`+
    `├ MC:       ${fmt(token.market_cap||0)}\n`+
    `├ Vol 1h:   ${fmt(token.volume||0)}\n`+
    `├ Liq:      ${fmt(token.liquidity||0)}\n`+
    `├ 1h Chg:   ${change1h>0?"+":""}${typeof change1h==="number"?change1h.toFixed(1):change1h}%\n`+
    `└ Velocity: ${vel}x ${velocityLabel(vel)}\n\n`+
    `🧠 *Smart Signals*\n`+
    `├ Smart Money: ${token.smart_degen_count||0}\n`+
    `├ KOL Holders: ${token.renowned_count||0}\n`+
    `└ Netflow: ${netflow}${insiderStr}\n\n`+
    `🔒 *Security*\n`+
    `├ Dev: ${devStatus} | Mint: ${mintR}\n`+
    `└ Rug: ${((token.rug_ratio||0)*100).toFixed(0)}%\n\n`+
    `💰 Snipe 0.1 SOL?`;

  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,false)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"kol");
  botStats.kol.alerts++;
  log(`KOL: $${sym} score:${score} smart:${token.smart_degen_count||0} kol:${token.renowned_count||0}`);
}

async function sendPumpAlert(token,ai) {
  const mint=token.address, sym=token.symbol||"???";
  const progress=token.progress||0;
  const bar="█".repeat(Math.floor(progress/10))+"░".repeat(10-Math.floor(progress/10));
  const urgency=progress>=90?"MIGRATING SOON":progress>=75?"FILLING FAST":"EARLY";
  const riskEmoji=ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";

  const msg=
    `🎯 *PUMPFUN PRE-BOND* — ${urgency}\n`+
    `AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%\n\n`+
    `*$${sym}*\n\`${mint}\`\n`+
    `Age: ${fmtAge(token.open_timestamp?token.open_timestamp*1000:null)} | Holders: ${token.holder_count||token.holders||"N/A"}\n\n`+
    `[${bar}] ${progress.toFixed(1)}%\n\n`+
    `Price: ${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"} | MC: ${fmt(token.market_cap||0)}\n`+
    `Vol: ${fmt(token.volume||0)} | Smart: ${token.smart_degen_count||0}\n\n`+
    `⚡ Buy before Raydium migration!\n💰 Snipe 0.1 SOL?`;

  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,true)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"pump");
  botStats.pump.alerts++;
  log(`Pump: $${sym} ${progress.toFixed(0)}%`);
}

async function sendUltraAlert(token,ai) {
  const mint=token.address, sym=token.symbol||"???";
  const ageMin=Math.floor((token.ageMs||0)/60000);
  const progress=token.progress||0;
  const bar="█".repeat(Math.floor(progress/10))+"░".repeat(10-Math.floor(progress/10));
  const momentum=token.buyRatio>=10?"INSANE":token.buyRatio>=5?"VERY HIGH":"HIGH";
  const riskEmoji=ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";

  const msg=
    `🚀 *ULTRA EARLY* — ${momentum} MOMENTUM\n`+
    `AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%\n\n`+
    `*$${sym}*\n\`${mint}\`\n`+
    `Age: ${ageMin}m | Holders: ${token.holder_count||token.holders||"N/A"}\n\n`+
    `[${bar}] ${progress.toFixed(1)}%\n\n`+
    `Price: ${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"} | MC: ${fmt(token.market_cap||0)}\n`+
    `Vol 5m: ${fmt(token.volume||token.volume_5m||0)}\n`+
    `Buys: ${token.buys||0} | Sells: ${token.sells||0} | B/S: ${token.buyRatio?token.buyRatio.toFixed(1):"N/A"}:1\n\n`+
    `💰 Snipe 0.1 SOL? — Always DYOR`;

  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,true)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"ultra");
  botStats.ultra.alerts++;
  log(`Ultra: $${sym} age:${ageMin}m ratio:${token.buyRatio?.toFixed(1)}`);
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scan() {
  log("Scanning...");
  pollInsiderWallets().catch(()=>{});

  const [kolTokens,pumpTokens,ultraTokens]=await Promise.all([
    getKOLSignals(), getPumpSignals(), getUltraSignals()
  ]);
  log(`KOL:${kolTokens.length} Pump:${pumpTokens.length} Ultra:${ultraTokens.length}`);

  const allTokens=[
    ...ultraTokens.map(t=>({...t,_type:"ultra"})),
    ...kolTokens.map(t=>({...t,_type:"kol"})),
    ...pumpTokens.map(t=>({...t,_type:"pump"})),
  ];
  const filtered=allTokens.filter(t=>t._type==="ultra"||t._type==="pump"||hardFilter(t));
  log(`Tokens after filter: ${filtered.length}`);
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
    await new Promise(r=>setTimeout(r,1500));
  }

  if (globalAlerted.size>500) [...globalAlerted].slice(0,100).forEach(m=>globalAlerted.delete(m));
  const now=Date.now();
  for (const [k,v] of claudeCache.entries()){if(now-v.ts>1800000)claudeCache.delete(k);}
  for (const [k,ts] of alerted.entries()){if(now-ts>ALERT_COOLDOWN_MS)alerted.delete(k);}
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("KOL Tracker TEST v5 — No type filter, log all trenches keys");
  try { const r=await axios.get("https://api.ipify.org?format=json",{timeout:5000}); log(`Railway IP: ${r.data.ip}`); } catch(e){}

  await bot.sendMessage(CHAT_ID,
    `🧪 *KOL Tracker TEST v5 Online*\n\n`+
    `📡 Dual source: Public API + OpenAPI fallback\n`+
    `🎯 3 Signal types: KOL + PumpFun + Ultra Early\n`+
    `🤖 Claude AI filter active\n`+
    `👛 6 Insider wallets tracked\n`+
    `📊 2x/5x/10x milestone alerts\n\n`+
    `Scanning every 60s 🔥`,
    {parse_mode:"Markdown"}
  );

  await scan();
  setInterval(scan,POLL_INTERVAL_MS);
}

main().catch(e=>{log(`Fatal: ${e.message}`);process.exit(1);});
