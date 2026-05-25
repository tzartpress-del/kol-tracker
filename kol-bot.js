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
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const GMGN_API_KEY   = process.env.GMGN_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL || "https://ksulmvlrmwpalgqzlxjt.supabase.co";
const SUPABASE_KEY   = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtzdWxtdmxybXdwYWxncXpseGp0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MzQ0NzAsImV4cCI6MjA5NTMxMDQ3MH0.lbVBCzcYrpbGp5J-m1Xz33sTf7k799A8md0pWIJfXYw";

// ─── ORIGINAL V12 FILTERS ────────────────────────────────────────────────────
const MC_MIN              = 15000;
const MC_MAX              = 150000;
const POLL_INTERVAL_MS    = 60000;
const ALERT_COOLDOWN_MS   = 3600000;
const MAX_TOKEN_AGE_MS    = 24 * 60 * 60 * 1000;
const REENTRY_MIN_VOLUME  = 50000;

// PumpFun Pre-Bond (original v12)
const PUMP_MIN_VOLUME     = 20000;
const PUMP_MIN_PROGRESS   = 60;
const PUMP_MAX_PROGRESS   = 98;
const PUMP_MIN_HOLDERS    = 100;

// Ultra Early (original v12)
const ULTRA_MAX_AGE_MS    = 30 * 60 * 1000;
const ULTRA_MIN_VOLUME    = 3000;
const ULTRA_MIN_HOLDERS   = 30;
const ULTRA_MIN_BUY_RATIO = 2;

const OPENROUTER_MODEL    = "meta-llama/llama-3.3-70b-instruct:free";
const AI_DAILY_LIMIT      = 200;
const AI_CACHE_TTL        = 1800000;

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const globalAlerted      = new Set();
const alerted            = new Map();
const aiCache            = new Map();
const performanceTracker = new Map();
const insiderBuys        = {};
const lastSig            = {};
const blacklist          = new Set();
let lastOpenAPICall      = 0;
let aiCallsToday         = 0;
let aiResetTime          = Date.now() + 86400000;
const blacklistedCreators = new Set();
const creatorCache        = new Map();

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

// ─── HARD FILTER — using confirmed fields from enrichment ────────────────────
// Confirmed in /v1/token/security: top_10_holder_rate, is_honeypot, is_blacklist
// Confirmed in /v1/market/rank: liquidity, volume, market_cap
// NOT available: bundler_trader_amount_rate, smart_degen_count, holder_count
function hardFilter(token) {
  const liq      = token.liquidity         || 0;
  const mc       = token.market_cap        || 0;
  const top10    = token.top_10_holder_rate || 0;
  const honeypot = token.is_honeypot       || false;
  const blacklisted = token.is_blacklist   || false;
  const vol      = token.volume            || 0;

  if (liq < 5000)       return false;  // no liquidity
  if (vol < 1000)       return false;  // no volume
  if (mc < MC_MIN)      return false;  // too small
  if (mc > MC_MAX)      return false;  // too large
  if (honeypot)         return false;  // honeypot
  if (blacklisted)      return false;  // blacklisted
  if (top10 > 0.50)     return false;  // too concentrated
  if (blacklist.has(token.creator||"")) return false;
  return true;
}

function calcFinalScore(token, aiConf, insiderCount) {
  let s = 0;
  // Use fields that exist in both public API and OpenAPI responses
  const smart  = token.smart_degen_count || 0;
  const kol    = token.renowned_count    || 0;
  const rug    = token.rug_ratio         || 0;
  const liq    = token.liquidity         || 0;
  const vol    = token.volume            || 0;
  const chg1h  = token.price_change_percent1h || 0;

  // Smart money signals (available from public API)
  if (smart>=3) s+=3; else if (smart>=1) s+=2;
  if (kol>=2)   s+=2; else if (kol>=1)   s+=1;

  // Liquidity signals (available in OpenAPI)
  if (liq>15000) s+=2; else if (liq>7000) s+=1;

  // Volume momentum
  if (vol>50000) s+=2; else if (vol>20000) s+=1;

  // Price momentum
  if (chg1h>50)  s+=2;
  else if (chg1h>10) s+=1;
  else if (chg1h<-50) s-=2;

  // Security signals (only if available)
  if (rug>0.20) s-=3;
  if ((token.bundler_trader_amount_rate||0)>0.25) s-=2;
  if (token.is_wash_trading) s-=3;
  if (token.creator_token_status==="sell") s-=2;
  if (token.creator_token_status==="hold") s+=1;
  if (token.renounced_mint===1) s+=1;

  // AI confidence bonus
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
        `📊 *ELITE Stats*\n\n`+
        `KOL: ${s.kol.alerts} | 2x:${s.kol.hits2x} 5x:${s.kol.hits5x} 10x:${s.kol.hits10x}\n`+
        `Pump: ${s.pump.alerts} | 2x:${s.pump.hits2x} 5x:${s.pump.hits5x} 10x:${s.pump.hits10x}\n`+
        `Ultra: ${s.ultra.alerts} | 2x:${s.ultra.hits2x} 5x:${s.ultra.hits5x} 10x:${s.ultra.hits10x}\n`+
        `AI: ${aiCallsToday}/${AI_DAILY_LIMIT} | Tracking: ${performanceTracker.size}
Blacklisted creators: ${blacklistedCreators.size}`,
        { parse_mode:"Markdown" }
      );
    }
  } catch(e) {}
});

// ─── SUPABASE HELPERS ────────────────────────────────────────────────────────
async function dbInsert(table, data) {
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/${table}`,
      data,
      {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        timeout: 8000
      }
    );
  } catch(e) {
    log(`Supabase insert error: ${e.message}`);
  }
}

async function dbUpdate(table, match, data) {
  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/${table}?mint=eq.${match}`,
      data,
      {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        timeout: 8000
      }
    );
  } catch(e) {
    log(`Supabase update error: ${e.message}`);
  }
}

// ─── CREATOR RUG CHECK ───────────────────────────────────────────────────────
const PF_API = "https://frontend-api-v3.pump.fun";

async function fetchCreatorProfile(wallet) {
  if (creatorCache.has(wallet)) return creatorCache.get(wallet);
  try {
    const res = await axios.get(
      `${PF_API}/coins?creator=${wallet}&limit=50&offset=0&includeNsfw=true`,
      { timeout:10000, headers:{"Accept":"application/json"} }
    );
    const profile = { wallet, totalLaunches:0, scamEstimate:0, rugRate:0 };
    if (Array.isArray(res.data)) {
      const coins = res.data;
      profile.totalLaunches = coins.length;
      profile.scamEstimate  = coins.filter(c => !Boolean(c.complete) && Number(c.usd_market_cap||0) < 500).length;
      profile.rugRate       = coins.length > 0 ? profile.scamEstimate / coins.length : 0;
      if (profile.rugRate > 0.5 && profile.totalLaunches >= 3) {
        blacklistedCreators.add(wallet);
        log(`Blacklisted creator ${wallet.slice(0,8)} — rug rate ${(profile.rugRate*100).toFixed(0)}%`);
      }
    }
    creatorCache.set(wallet, profile);
    setTimeout(() => creatorCache.delete(wallet), 120000);
    return profile;
  } catch(e) {
    return { wallet, totalLaunches:0, scamEstimate:0, rugRate:0 };
  }
}

async function checkCopycat(name, symbol, excludeMint) {
  try {
    const q = encodeURIComponent(symbol||name);
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${q}`, { timeout:8000 });
    const pairs = res.data?.pairs || [];
    const nameLower = (name||"").toLowerCase();
    const symLower  = (symbol||"").toLowerCase();
    return pairs.filter(p => {
      if (p.chainId !== "solana") return false;
      const b = p.baseToken || {};
      if ((b.address||"").toLowerCase() === excludeMint?.toLowerCase()) return false;
      return (b.name||"").toLowerCase()===nameLower || (b.symbol||"").toLowerCase()===symLower;
    }).length;
  } catch(e) { return 0; }
}

// ─── AI FILTER (OpenRouter) ───────────────────────────────────────────────────
async function claudeFilter(token) {
  if (Date.now()>aiResetTime) { aiCallsToday=0; aiResetTime=Date.now()+86400000; }
  const cached=aiCache.get(token.address);
  if (cached&&Date.now()-cached.ts<AI_CACHE_TTL) return cached.result;

  const rug=token.rug_ratio||0, smart=token.smart_degen_count||0, liq=token.liquidity||0;
  if (rug>0.5)               return cacheAI(token.address, { decision:"REJECT", reason:"Rug>50%", risk:"VERY HIGH", confidence:99 });
  if (liq<3000)              return cacheAI(token.address, { decision:"REJECT", reason:"No liquidity", risk:"VERY HIGH", confidence:99 });
  if (token.is_wash_trading) return cacheAI(token.address, { decision:"REJECT", reason:"Wash trading", risk:"VERY HIGH", confidence:99 });
  if (token.is_honeypot)     return cacheAI(token.address, { decision:"REJECT", reason:"Honeypot", risk:"VERY HIGH", confidence:99 });
  if (smart>=3&&rug<0.1) {
    return cacheAI(token.address, {decision:"APPROVE",reason:"Strong smart money",risk:"LOW",confidence:92});
  }
  if (!OPENROUTER_KEY||aiCallsToday>=AI_DAILY_LIMIT)
    return {decision:"APPROVE",reason:"AI limit",risk:"MEDIUM",confidence:50};
  try {
    aiCallsToday++;
    const res=await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: OPENROUTER_MODEL,
        max_tokens: 80,
        messages:[{role:"user",content:
          `Solana memecoin. Be LENIENT. Only reject clear rugs.\n$${token.symbol} MC:$${Math.round(token.market_cap||0)} Liq:$${Math.round(liq)} Smart:${smart} Rug:${(rug*100).toFixed(0)}%\nREJECT only rug>40% or wash trading. JSON only: {"decision":"APPROVE","reason":"brief","risk":"LOW","confidence":75}`
        }]
      },
      {
        headers:{
          "Authorization":`Bearer ${OPENROUTER_KEY}`,
          "Content-Type":"application/json",
          "HTTP-Referer":"https://apex-bot.railway.app",
          "X-Title":"Apex Alpha Bot"
        },
        timeout:15000
      }
    );
    const text=res.data?.choices?.[0]?.message?.content||"{}";
    const r=JSON.parse(text.replace(/```json|```/g,"").trim());
    log(`AI: $${token.symbol} → ${r.decision} ${r.risk} ${r.confidence}%`);
    return cacheAI(token.address, r);
  } catch(e) {
    return {decision:"APPROVE",reason:"AI unavailable",risk:"MEDIUM",confidence:50};
  }
}

function cacheAI(addr, result) {
  aiCache.set(addr, { result, ts:Date.now() });
  return result;
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
      const v=tracker.peakX>=10?"🌙 MOONSHOT":tracker.peakX>=5?"🔥 BANGER":tracker.peakX>=2?"✅ WIN":tracker.peakX>=1?"🟡 BREAKEVEN":"🔴 RUG";
      await bot.sendMessage(CHAT_ID,`📋 *24hr* $${symbol}\nPeak: ${tracker.peakX.toFixed(2)}x — ${v}`,{parse_mode:"Markdown"}).catch(()=>{});
      // Save outcome to Supabase
      dbInsert("outcomes", {
        mint, symbol, signal_type:tracker.signalType,
        peak_x: tracker.peakX,
        result: v.replace(/[^a-zA-Z0-9 ]/g,"").trim(),
        alert_price: tracker.alertPrice,
      }).catch(()=>{});
      performanceTracker.delete(mint);clearInterval(interval);return;
    }
    const cur=await getTokenPrice(mint);
    if (!cur?.price||!alertPrice) return;
    const x=cur.price/alertPrice;
    if (x>tracker.peakX) tracker.peakX=x;
    const stats=botStats[signalType]||botStats.kol;
    if (cur.sells>cur.buys*2&&x>1.5&&!tracker.notifiedDistrib) {
      tracker.notifiedDistrib=true;
      await bot.sendMessage(CHAT_ID,`⚠️ *DISTRIBUTION* $${symbol} — sell pressure! ${x.toFixed(2)}x\n🚨 Consider exiting!`,{parse_mode:"Markdown",reply_to_message_id:alertMsgId}).catch(()=>{});
    }
    if (x>=10&&!tracker.notified10x){tracker.notified10x=true;stats.hits10x++;await bot.sendMessage(CHAT_ID,`🌙🌙🌙 *10x!* $${symbol} up *${x.toFixed(2)}x*!\n🏆 Take profit!`,{parse_mode:"Markdown",reply_to_message_id:alertMsgId}).catch(()=>{});}
    else if (x>=5&&!tracker.notified5x){tracker.notified5x=true;stats.hits5x++;await bot.sendMessage(CHAT_ID,`🚀🚀 *5x!* $${symbol} up *${x.toFixed(2)}x*!`,{parse_mode:"Markdown",reply_to_message_id:alertMsgId}).catch(()=>{});}
    else if (x>=2&&!tracker.notified2x){tracker.notified2x=true;stats.hits2x++;await bot.sendMessage(CHAT_ID,`✅ *2x!* $${symbol} up *${x.toFixed(2)}x*!`,{parse_mode:"Markdown",reply_to_message_id:alertMsgId}).catch(()=>{});}
    if (cur.liquidity<2000&&tracker.peakX>1.5){
      await bot.sendMessage(CHAT_ID,`⚠️ *LIQ WARNING* $${symbol} — exit now!`,{parse_mode:"Markdown",reply_to_message_id:alertMsgId}).catch(()=>{});
      performanceTracker.delete(mint);clearInterval(interval);
    }
  },3*60*1000);
}

// ─── GMGN FETCHERS ────────────────────────────────────────────────────────────
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
    return null;
  } catch(e) { return null; }
}

const ipv4Agent=new https.Agent({family:4,keepAlive:true});
const axiosAPI=axios.create({httpsAgent:ipv4Agent,timeout:20000,validateStatus:()=>true});

// SOL launchpad platforms + quote address types from official GMGN client
// All launchpad platforms — bonding curve only (no DEX pools)
const SOL_LAUNCHPAD_PLATFORMS = [
  // Pump.fun family
  "Pump.fun","pump_mayhem","pump_mayhem_agent","pump_agent",
  // letsbonk family
  "letsbonk","bonkers","bags",
  // Other launchpads
  "memoo","liquid","bankr","zora","surge","anoncoin",
  "moonshot_app","wendotdev","heaven","sugar","token_mill",
  "believe","trendsfun","trends_fun","jup_studio","Moonshot",
  "boop","xstocks",
  // DEX pools included for completed tokens only
  "ray_launchpad","meteora_virtual_curve",
  "pool_ray","pool_meteora","pool_pump_amm","pool_orca",
];
const SOL_QUOTE_ADDRESS_TYPES = [4,5,3,1,13,0];

function buildTrenchesBody(types, limit=80) {
  const section = {
    filters: ["offchain","onchain"],
    launchpad_platform: SOL_LAUNCHPAD_PLATFORMS,
    quote_address_type: SOL_QUOTE_ADDRESS_TYPES,
    launchpad_platform_v2: true,
    limit,
  };
  const body = { version: "v2" };
  for (const type of types) body[type] = { ...section };
  return body;
}

async function fetchOpenAPI(subPath, params={}, method="GET") {
  const wait=2000-(Date.now()-lastOpenAPICall);
  if (wait>0) await new Promise(r=>setTimeout(r,wait));
  lastOpenAPICall=Date.now();
  try {
    const ts=Math.floor(Date.now()/1000);
    const cid=uuidv4();
    const headers={"X-APIKEY":GMGN_API_KEY,"Accept":"application/json","Content-Type":"application/json"};
    let res;
    if (method==="POST") {
      const chain=params.chain||"sol";
      const qs=`chain=${chain}&timestamp=${ts}&client_id=${cid}`;
      const url=`https://openapi.gmgn.ai${subPath}?${qs}`;
      const body=params.body||params;
      res=await axiosAPI.post(url,body,{headers});
    } else {
      const allParams={...params,timestamp:String(ts),client_id:cid};
      const qs=Object.entries(allParams).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join("&");
      const url=`https://openapi.gmgn.ai${subPath}?${qs}`;
      res=await axiosAPI.get(url,{headers});
    }
    if (res.status===405&&method==="GET") return fetchOpenAPI(subPath,params,"POST");
    if (res.status!==200||typeof res.data==="string") { log(`OpenAPI ${res.status}: ${JSON.stringify(res.data)?.slice(0,100)}`); return null; }
    if (res.data?.code!==0) { log(`OpenAPI err: ${res.data?.error} ${res.data?.message}`); return null; }
    log(`OpenAPI OK: ${subPath}`);
    return res.data;
  } catch(e) { log(`OpenAPI error: ${e.message}`); return null; }
}

// ─── TOKEN ENRICHMENT — fetch security fields for KOL tokens ─────────────────
async function enrichToken(token) {
  try {
    const data = await fetchOpenAPI("/v1/token/security", {
      chain: "sol",
      address: token.address
    });
    if (!data?.data) return token;
    const s = data.data;
    // Correct field names from actual /v1/token/security response:
    // top_10_holder_rate, burn_ratio, burn_status, is_honeypot,
    // open_source, is_blacklist, dev_token_burn_ratio
    // NOTE: rug_ratio, smart_degen_count, bundler_trader_amount_rate
    // are NOT in this endpoint — use token_info instead
    return {
      ...token,
      top_10_holder_rate:   s.top_10_holder_rate   ?? token.top_10_holder_rate,
      burn_ratio:           s.burn_ratio            ?? 0,
      burn_status:          s.burn_status           ?? token.burn_status,
      is_honeypot:          s.is_honeypot           ?? false,
      open_source:          s.open_source           ?? token.open_source,
      is_blacklist:         s.is_blacklist          ?? false,
      dev_token_burn_ratio: s.dev_token_burn_ratio  ?? 0,
      // rug_ratio not in security endpoint — keep existing value
      rug_ratio:            token.rug_ratio         ?? 0,
    };
  } catch(e) {
    log(`Enrich error for ${token.address?.slice(0,8)}: ${e.message}`);
    return token;
  }
}

// ─── KOL SIGNALS ─────────────────────────────────────────────────────────────
async function getKOLSignals() {
  const seen=new Set(), results=[];
  // Try public API first
  const pubResponses=await Promise.allSettled([
    fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=smart_degen_count&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=100`),
    fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`),
  ]);
  let publicWorked=false;
  for (const r of pubResponses) {
    if (r.status!=="fulfilled"||!r.value) continue;
    const list=r.value?.data?.rank||[];
    if (list.length>0) { publicWorked=true; processKOLList(list,seen,results); }
  }
  if (!publicWorked) {
    log("Public KOL failed — using OpenAPI");
    for (const params of [
      {chain:"sol",interval:"1h",orderby:"smart_degen_count",direction:"desc",limit:"100"},
      {chain:"sol",interval:"1h",orderby:"open_timestamp",direction:"desc",limit:"100"},
    ]) {
      const data=await fetchOpenAPI("/v1/market/rank",params);
      if (data) processKOLList(extractList(data),seen,results);
    }
  }
  // Enrich top 15 results with security fields
  const sorted = results.sort((a,b)=>(b.smart_degen_count||0)-(a.smart_degen_count||0));
  const top = sorted.slice(0, 15);
  log(`Enriching ${top.length} KOL tokens with security data...`);
  const enriched = await Promise.all(top.map(t => enrichToken(t)));
  // Log first enriched token to verify fields
  if (enriched.length > 0) {
    log(`Enriched token sample - top10:${enriched[0].top_10_holder_rate} honeypot:${enriched[0].is_honeypot} blacklist:${enriched[0].is_blacklist} burn:${enriched[0].burn_status}`);
  }
  return enriched;
}

function extractList(data) {
  if (!data) return [];
  const d=data.data||data;
  if (Array.isArray(d.rank))   return d.rank;
  if (Array.isArray(d.tokens)) return d.tokens;
  if (Array.isArray(d.list))   return d.list;
  if (Array.isArray(d))        return d;
  return [];
}

function processKOLList(list, seen, results) {
  if (list.length>0) log(`KOL sample fields: ${JSON.stringify(Object.keys(list[0])).slice(0,150)}`);
  for (const t of list) {
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

// ─── PUMP SIGNALS ─────────────────────────────────────────────────────────────
async function getPumpSignals() {
  const seen=new Set(), results=[];
  const pubResponses=await Promise.allSettled([
    fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=volume&direction=desc&filters[]=not_honeypot&limit=100`),
  ]);
  let publicWorked=false;
  for (const r of pubResponses) {
    if (r.status!=="fulfilled"||!r.value) continue;
    const list=r.value?.data?.rank||r.value?.data?.token_list||[];
    if (Array.isArray(list)&&list.length>0) { publicWorked=true; processPumpList(list,seen,results); }
  }
  if (!publicWorked) {
    log("Public Pump failed — using OpenAPI");
    const body=buildTrenchesBody(["near_completion"]);
    const data=await fetchOpenAPI("/v1/trenches",{chain:"sol",body},"POST");
    if (data) processPumpList(data?.data?.pump||[],seen,results);
  }
  return results.sort((a,b)=>(b.volume_1h||b.volume||0)-(a.volume_1h||a.volume||0)).slice(0,10);
}

function processPumpList(list, seen, results) {
  for (const t of list) {
    if (!t.address||seen.has(t.address)||globalAlerted.has(t.address)) continue;
    seen.add(t.address);
    const progress = t.launchpad_status?.bonding_curve_percentage||t.graduation_progress||t.progress||0;
    const volume   = t.volume_1h||t.volume_24h||t.volume||0;
    const holders  = t.holder_count||0;
    const mc       = t.usd_market_cap||t.market_cap||0;
    const rug      = t.rug_ratio||0;
    const bundle   = t.bundler_trader_amount_rate||0;
    const wash     = t.is_wash_trading||false;
    if (
      progress >= PUMP_MIN_PROGRESS &&
      progress <= PUMP_MAX_PROGRESS &&
      volume   >= PUMP_MIN_VOLUME   &&
      holders  >= PUMP_MIN_HOLDERS  &&
      rug      <  0.3               &&
      bundle   <  0.4               &&
      !wash
    ) results.push({...t,alertType:"PUMP",progress,market_cap:mc,volume});
  }
}

// ─── ULTRA SIGNALS ────────────────────────────────────────────────────────────
async function getUltraSignals() {
  const seen=new Set(), results=[];
  const pubResponses=await Promise.allSettled([
    fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`),
    fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/5m?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`),
  ]);
  let publicWorked=false;
  for (const r of pubResponses) {
    if (r.status!=="fulfilled"||!r.value) continue;
    const list=r.value?.data?.rank||r.value?.data?.token_list||[];
    if (Array.isArray(list)&&list.length>0) { publicWorked=true; processUltraList(list,seen,results); }
  }
  if (!publicWorked) {
    log("Public Ultra failed — using OpenAPI");
    const body=buildTrenchesBody(["new_creation"]);
    const data=await fetchOpenAPI("/v1/trenches",{chain:"sol",body},"POST");
    if (data) processUltraList(data?.data?.new_creation||[],seen,results);
  }
  return results.sort((a,b)=>b.buyRatio-a.buyRatio).slice(0,5);
}

function processUltraList(list, seen, results) {
  for (const t of list) {
    if (!t.address||seen.has(t.address)||globalAlerted.has(t.address)) continue;
    seen.add(t.address);
    const ageMs   = t.created_timestamp?(Date.now()-t.created_timestamp*1000)
                  : t.open_timestamp?(Date.now()-t.open_timestamp*1000):null;
    if (!ageMs||ageMs>ULTRA_MAX_AGE_MS) continue;
    const progress = t.launchpad_status?.bonding_curve_percentage||t.progress||0;
    const volume   = t.volume_1h||t.volume_24h||t.volume||0;
    const holders  = t.holder_count||0;
    const buys     = t.buys_24h||t.buys||0;
    const sells    = t.sells_24h||t.sells||0;
    const buyRatio = sells>0?buys/sells:buys>0?buys:0;
    const mc       = t.usd_market_cap||t.market_cap||0;
    const rug      = t.rug_ratio||0;
    const bundle   = t.bundler_trader_amount_rate||0;
    const top10    = t.top_10_holder_rate||0;
    const buyTax   = parseFloat(t.buy_tax||0);
    const burned   = t.burn_status==="burn";
    const smart    = t.smart_degen_count||0;
    const devBal   = t.creator_balance_rate||0;
    const wash     = t.is_wash_trading||false;
    if (
      volume   >= ULTRA_MIN_VOLUME    &&
      holders  >= ULTRA_MIN_HOLDERS   &&
      buyRatio >= ULTRA_MIN_BUY_RATIO &&
      rug      <  0.15                &&
      !wash                           &&
      bundle   <  0.3                 &&
      top10    <  0.5                 &&
      buyTax   == 0                   &&
      devBal   <  0.2                 &&
      (burned||smart>=1)
    ) results.push({...t,alertType:"ULTRA_EARLY",_ageMs:ageMs,progress,buys,sells,buyRatio,market_cap:mc,volume});
  }
}

// ─── SOCIALS HELPER ──────────────────────────────────────────────────────────
function getSocials(token) {
  const parts = [];
  const tw = token.twitter || token.twitter_username;
  const tg = token.telegram;
  const web = token.website;

  if (tw)  parts.push(`[X](${tw.startsWith("http") ? tw : "https://x.com/"+tw})`);
  if (tg)  parts.push(`[TG](${tg.startsWith("http") ? tg : "https://t.me/"+tg})`);
  if (web) parts.push(`[Web](${web})`);

  if (parts.length === 0) return "No socials ⚠️";
  return parts.join(" | ");
}

// ─── DEX PROMOTION HELPER ────────────────────────────────────────────────────
function getDexPromo(token) {
  const ad      = token.dexscr_ad          === 1 || token.dexscr_ad      === true;
  const trending = token.dexscr_trending_bar === 1 || token.dexscr_trending_bar === true;
  const boost   = parseFloat(token.dexscr_boost_fee || 0) > 0;
  const updated = token.dexscr_update_link  === 1 || token.dexscr_update_link  === true;

  const promos = [];
  if (ad)       promos.push("Ad");
  if (trending) promos.push("Trending Bar");
  if (boost)    promos.push(`Boost $${token.dexscr_boost_fee}`);
  if (updated)  promos.push("Links Updated");

  if (promos.length === 0) return "❌ No paid promotion";
  return `✅ ${promos.join(" + ")}`;
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
  const devStatus=token.creator_token_status==="sell"?"🔴 Sold":token.creator_token_status==="hold"?"🟢 Holding":"🟡 N/A";
  const vel=getVelocity(token);
  const netflow=(token.buy_5m||0)>(token.sell_5m||0)?"🟢 Accumulating":"🔴 Selling";
  const change1h=token.price_change_percent1h||0;
  const insiderStr=insiders.length>0?`\n└ 👛 ${insiders.join(", ")}`:"";
  const msg=
    `${isReentry?"🔄 *RE-ENTRY SIGNAL*":"🚨 *KOL SIGNAL*"} — ${signalLabel(score)}\n`+
    `Score: ${score} | AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%\n`+
    `${token._copycatWarning?token._copycatWarning+"\n":""}\n`+
    `*$${sym}*\n\`${mint}\`\n`+
    `└ ⏱ ${fmtAge(token.open_timestamp?token.open_timestamp*1000:null)} | 👁 ${token.holder_count||"N/A"} holders\n\n`+
    `📊 *Token Details*\n`+
    `├ PRICE:    ${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"}\n`+
    `├ MC:       ${fmt(token.market_cap||0)}\n`+
    `├ Vol 1h:   ${fmt(token.volume||0)}\n`+
    `├ Liq:      ${fmt(token.liquidity||0)}\n`+
    `├ 1h Chg:   ${change1h>0?"+":""}${typeof change1h==="number"?change1h.toFixed(1):change1h}%\n`+
    `└ Velocity: ${vel}x ${velocityLabel(vel)}\n\n`+
    `🧠 *Smart Signals*\n`+
    `├ Smart Money: ${token.smart_degen_count||0} 🤖\n`+
    `├ KOL Holders: ${token.renowned_count||0} 👑\n`+
    `└ Netflow: ${netflow}${insiderStr}\n\n`+
    `🔒 *Security*\n`+
    `├ Dev: ${devStatus} | Mint: ${token.renounced_mint===1?"🟢 Yes":"🔴 No"}\n`+
    `├ Rug: ${((token.rug_ratio||0)*100).toFixed(0)}%\n`+
    `├ 📢 DEX: ${getDexPromo(token)}\n`+
    `└ 🌐 ${getSocials(token)}\n\n`+
    `💰 *Snipe 0.1 SOL?*`;
  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,false)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"kol");
  botStats.kol.alerts++;
  log(`KOL: $${sym} score:${score} smart:${token.smart_degen_count||0} kol:${token.renowned_count||0}`);
  // Save to Supabase
  dbInsert("signals", {
    mint, symbol:sym, signal_type:"KOL",
    alert_price: token.price ? parseFloat(token.price) : null,
    alert_mc: token.market_cap || null,
    smart_degen_count: token.smart_degen_count || 0,
    rug_ratio: token.rug_ratio || 0,
    ai_decision: ai.decision,
    ai_confidence: ai.confidence || 0,
    has_socials: !!(token.twitter||token.telegram||token.website),
  }).catch(()=>{});
}

async function sendPumpAlert(token,ai) {
  const mint=token.address, sym=token.symbol||"???";
  const progress=token.progress||0;
  const bar="█".repeat(Math.floor(progress/10))+"░".repeat(10-Math.floor(progress/10));
  const urgency=progress>=90?"🔴 MIGRATING SOON":progress>=75?"🟡 FILLING FAST":"🟢 EARLY";
  const riskEmoji=ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";
  const msg=
    `🎯 *PUMPFUN PRE-BOND* — ${urgency}\n`+
    `AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%\n\n`+
    `*$${sym}*\n\`${mint}\`\n`+
    `└ ⏱ ${fmtAge(token.open_timestamp?token.open_timestamp*1000:null)} | 👁 ${token.holder_count||"N/A"} holders\n\n`+
    `🏦 *Bonding Curve*\n[${bar}] ${progress.toFixed(1)}%\n\n`+
    `📊 Price: ${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"} | MC: ${fmt(token.market_cap||0)}\n`+
    `Vol: ${fmt(token.volume||0)} | Smart: ${token.smart_degen_count||0} 🤖 | KOL: ${token.renowned_count||0} 👑\n`+
    `📢 DEX: ${getDexPromo(token)}\n`+
    `🌐 ${getSocials(token)}\n\n`+
    `⚡ Buy before Raydium migration!\n💰 *Snipe 0.1 SOL?*`;
  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,true)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"pump");
  botStats.pump.alerts++;
  log(`Pump: $${sym} ${progress.toFixed(0)}%`);
  dbInsert("signals", {
    mint, symbol:sym, signal_type:"PUMP",
    alert_price: token.price ? parseFloat(token.price) : null,
    alert_mc: token.market_cap || null,
    smart_degen_count: token.smart_degen_count || 0,
    rug_ratio: token.rug_ratio || 0,
    ai_decision: ai.decision,
    ai_confidence: ai.confidence || 0,
    has_socials: !!(token.twitter||token.telegram||token.website),
  }).catch(()=>{});
}

async function sendUltraAlert(token,ai) {
  const mint=token.address, sym=token.symbol||"???";
  const ageMin=Math.floor((token._ageMs||token.ageMs||0)/60000);
  const progress=token.progress||0;
  const bar="█".repeat(Math.floor(progress/10))+"░".repeat(10-Math.floor(progress/10));
  const momentum=token.buyRatio>=10?"🔥🔥🔥 INSANE":token.buyRatio>=5?"🔥🔥 VERY HIGH":"🔥 HIGH";
  const riskEmoji=ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";
  const msg=
    `🚀 *ULTRA EARLY LAUNCH* — ${momentum}\n`+
    `AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%\n\n`+
    `*$${sym}*\n\`${mint}\`\n`+
    `└ ⏱ ${ageMin}m | 👁 ${token.holder_count||"N/A"} holders\n\n`+
    `📈 *Bonding Curve*\n[${bar}] ${progress.toFixed(1)}%\n\n`+
    `⚡ *Momentum*\n`+
    `├ Vol:  ${fmt(token.volume||0)}\n`+
    `├ Buys: ${token.buys||0} | Sells: ${token.sells||0}\n`+
    `└ B/S:  ${token.buyRatio?token.buyRatio.toFixed(1):"N/A"}:1\n\n`+
    `📊 Price: ${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"} | MC: ${fmt(token.market_cap||0)}\n`+
    `Smart: ${token.smart_degen_count||0} 🤖 | Rug: ${((token.rug_ratio||0)*100).toFixed(0)}%\n`+
    `📢 DEX: ${getDexPromo(token)}\n`+
    `🌐 ${getSocials(token)}\n\n`+
    `💰 *Snipe 0.1 SOL?* — Always DYOR`;
  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,true)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"ultra");
  botStats.ultra.alerts++;
  log(`Ultra: $${sym} age:${ageMin}m ratio:${token.buyRatio?.toFixed(1)}`);
  dbInsert("signals", {
    mint, symbol:sym, signal_type:"ULTRA",
    alert_price: token.price ? parseFloat(token.price) : null,
    alert_mc: token.market_cap || null,
    smart_degen_count: token.smart_degen_count || 0,
    rug_ratio: token.rug_ratio || 0,
    ai_decision: ai.decision,
    ai_confidence: ai.confidence || 0,
    has_socials: !!(token.twitter||token.telegram||token.website),
  }).catch(()=>{});
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

  // Apply original v12 hardFilter to KOL only
  const filtered=allTokens.filter(t=>t._type==="ultra"||t._type==="pump"||hardFilter(t));
  log(`After hardFilter: ${filtered.length}`);

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
    // Creator rug check
    const creator = token.creator || token.creator_address || "";
    if (creator && blacklistedCreators.has(creator)) { log(`Blocked blacklisted creator: ${creator.slice(0,8)}`); continue; }
    if (creator) {
      await fetchCreatorProfile(creator);
      if (blacklistedCreators.has(creator)) { log(`Blocked after check: ${creator.slice(0,8)}`); continue; }
    }

    // Copycat detection — warn only, never block
    const copycats = await checkCopycat(token.name||"", token.symbol||"", mint);
    if (copycats > 0) token._copycatWarning = `⚠️ ${copycats+1} tokens named $${token.symbol||"?"}`;

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
  for (const [k,v] of aiCache.entries()){if(now-v.ts>AI_CACHE_TTL)aiCache.delete(k);}
  for (const [k,ts] of alerted.entries()){if(now-ts>ALERT_COOLDOWN_MS)alerted.delete(k);}
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("⚡ Apex v3 — Supabase signal tracking");
  try { const r=await axios.get("https://api.ipify.org?format=json",{timeout:5000}); log(`Railway IP: ${r.data.ip}`); } catch(e){}
  log(`GMGN_API_KEY: ${GMGN_API_KEY?"SET":"MISSING"}`);
  log(`OPENROUTER_KEY: ${OPENROUTER_KEY?"SET":"MISSING"}`);

  await bot.sendMessage(CHAT_ID,
    `⚡ *Apex v3 Online*\n\n`+
    `📡 All platforms: Pump.fun + letsbonk + bonkers + more\n`+
    `🎯 3 Signals: KOL + Pump + Ultra Early\n`+
    `🤖 AI: OpenRouter Llama 3.3 70B (200/day)\n`+
    `🌐 Social warnings on all alerts\n`+
    `💾 Supabase signal tracking enabled\n`+
    `👤 Creator rug rate check\n`+
    `🔍 Copycat detection\n`+
    `👛 6 Insider wallets tracked\n`+
    `📊 2x/5x/10x milestone alerts\n\n`+
    `Scanning every 60s 🔥`,
    {parse_mode:"Markdown"}
  );

  await scan();
  setInterval(scan,POLL_INTERVAL_MS);
}

main().catch(e=>{log(`Fatal: ${e.message}`);process.exit(1);});
