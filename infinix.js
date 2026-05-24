/**
 * ██╗███╗   ██╗███████╗██╗███╗   ██╗██╗██╗  ██╗
 * ██║████╗  ██║██╔════╝██║████╗  ██║██║╚██╗██╔╝
 * ██║██╔██╗ ██║█████╗  ██║██╔██╗ ██║██║ ╚███╔╝
 * ██║██║╚██╗██║██╔══╝  ██║██║╚██╗██║██║ ██╔██╗
 * ██║██║ ╚████║██║     ██║██║ ╚████║██║██╔╝ ██╗
 * ╚═╝╚═╝  ╚═══╝╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝╚═╝  ╚═╝
 * Infinix — Solana Alpha Bot
 * Signals: KOL + PumpFun Pre-Bond + Ultra Early (PumpPortal WS)
 * AI: OpenRouter (Llama 3.3 70B free)
 * Features: Creator rug check, copycat detection, CTO events,
 *           whale tracking, DEX promo, milestone alerts
 */

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const https = require("https");
const dns = require("dns");
const { v4: uuidv4 } = require("uuid");

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
dns.setDefaultResultOrder("ipv4first");

// ─── ENV ──────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID          = process.env.CHAT_ID;
const GMGN_API_KEY     = process.env.GMGN_API_KEY;
const HELIUS_API_KEY   = process.env.HELIUS_API_KEY;
const OPENROUTER_KEY   = process.env.OPENROUTER_KEY;

// ─── FILTERS (confirmed correct values) ──────────────────────────────────────
const MC_MIN              = 15000;
const MC_MAX              = 150000;
const POLL_INTERVAL_MS    = 60000;
const ALERT_COOLDOWN_MS   = 3600000;
const MAX_TOKEN_AGE_MS    = 24 * 60 * 60 * 1000;

// KOL hardFilter — only confirmed fields from /v1/market/rank + /v1/token/security
const KOL_MIN_LIQ         = 5000;
const KOL_MIN_VOL         = 1000;
const KOL_MAX_TOP10       = 0.50;
const KOL_MAX_PRICE_DROP  = -90;  // price_change_percent1h

// Pump Pre-Bond — confirmed trenches fields
const PUMP_MIN_VOLUME     = 20000;
const PUMP_MIN_PROGRESS   = 60;
const PUMP_MAX_PROGRESS   = 98;
const PUMP_MIN_HOLDERS    = 100;
const PUMP_MAX_RUG        = 0.3;
const PUMP_MAX_BUNDLE     = 0.4;

// Ultra Early — confirmed trenches + PumpPortal fields
const ULTRA_MAX_AGE_MS    = 30 * 60 * 1000;
const ULTRA_MIN_VOLUME    = 3000;
const ULTRA_MIN_HOLDERS   = 30;
const ULTRA_MIN_BUY_RATIO = 2;
const ULTRA_MAX_RUG       = 0.15;
const ULTRA_MAX_BUNDLE    = 0.3;
const ULTRA_MAX_TOP10     = 0.5;
const ULTRA_MAX_DEV_BAL   = 0.2;

// Creator rug check — pump.fun API
const CREATOR_MAX_RUG_RATE = 0.5;   // block if >50% of launches rugged
const CREATOR_MIN_MC_ALIVE = 500;   // USD — below this = dead/rug token

// Whale threshold
const WHALE_SOL_THRESHOLD = 5;

// OpenRouter
const OPENROUTER_MODEL    = "meta-llama/llama-3.3-70b-instruct:free";
const OPENROUTER_FALLBACK = "openrouter/free";
const AI_DAILY_LIMIT      = 150;
const AI_CACHE_TTL        = 1800000; // 30 min

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot              = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const globalAlerted    = new Set();
const alerted          = new Map();
const aiCache          = new Map();
const performanceTracker = new Map();
const blacklistedCreators = new Set();
const creatorCache     = new Map(); // creator wallet → profile
const insiderBuys      = {};
const lastSig          = {};
let lastOpenAPICall    = 0;
let aiCallsToday       = 0;
let aiResetTime        = Date.now() + 86400000;

// PumpPortal WebSocket state
let ppWs               = null;
let ppReconnectTimer   = null;
const ppUltraQueue     = new Map(); // mint → token data from PumpPortal
const creatorMap       = new Map(); // mint → creator (for CTO detection)

const botStats = {
  kol:   { alerts:0, hits2x:0, hits5x:0, hits10x:0 },
  pump:  { alerts:0, hits2x:0, hits5x:0, hits10x:0 },
  ultra: { alerts:0, hits2x:0, hits5x:0, hits10x:0 },
  cto:   { alerts:0 },
};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function fmt(n) {
  if (!n && n !== 0) return "N/A";
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1000) return `$${(n/1000).toFixed(1)}K`;
  return `$${Number(n).toFixed(2)}`;
}

function fmtAge(ts) {
  if (!ts) return "N/A";
  const s = Math.floor((Date.now()-ts*1000)/1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m`;
  return `${Math.floor(s/3600)}h`;
}

function fmtAgeMs(ms) {
  if (!ms) return "N/A";
  const s = Math.floor(ms/1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m`;
  return `${Math.floor(s/3600)}h`;
}

function getDexPromo(t) {
  const parts = [];
  if (t.dexscr_ad === 1 || t.dexscr_ad === true)             parts.push("Ad");
  if (t.dexscr_trending_bar === 1 || t.dexscr_trending_bar)  parts.push("Trending");
  if (parseFloat(t.dexscr_boost_fee||0) > 0)                 parts.push(`Boost`);
  if (t.dexscr_update_link === 1 || t.dexscr_update_link)    parts.push("Links");
  return parts.length ? `✅ ${parts.join(" + ")}` : "❌ None";
}

// ─── INSIDER WALLETS ──────────────────────────────────────────────────────────
const INSIDER_WALLETS = {
  "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm": "InsiderAlpha1",
  "4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t": "InsiderAlpha2",
  "8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd": "InsiderAlpha3",
  "9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL": "9SLP_KpKS",
  "84vL38o5zTQjvA2fv7f3MgwXVBm8rBs1QBVXHtranQy5": "2snH_kKuS",
  "BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB": "Axio_TTSk",
};

// ─── HTTP CLIENTS ─────────────────────────────────────────────────────────────
const ipv4Agent = new https.Agent({ family:4, keepAlive:true });
const axiosAPI  = axios.create({ httpsAgent:ipv4Agent, timeout:20000, validateStatus:()=>true });

const browserHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json",
  "Referer": "https://gmgn.ai/",
  "Origin": "https://gmgn.ai",
};

async function fetchPublic(url) {
  try {
    const res = await axios.get(url, { headers:browserHeaders, timeout:12000 });
    if (res.status === 200 && res.data) return res.data;
    return null;
  } catch(e) { return null; }
}

// ─── PUMP.FUN PUBLIC API ──────────────────────────────────────────────────────
const PF_API = "https://frontend-api-v3.pump.fun";

async function fetchCreatorProfile(wallet) {
  if (creatorCache.has(wallet)) return creatorCache.get(wallet);
  try {
    const [userRes, coinsRes] = await Promise.allSettled([
      axios.get(`${PF_API}/users/${wallet}`, { timeout:8000, headers:{"Accept":"application/json"} }),
      axios.get(`${PF_API}/coins?creator=${wallet}&limit=50&offset=0&includeNsfw=true`, { timeout:10000, headers:{"Accept":"application/json"} }),
    ]);

    const profile = { wallet, username:"", totalLaunches:0, scamEstimate:0, rugRate:0, recentCoins:[] };

    if (userRes.status==="fulfilled" && userRes.value?.data) {
      const u = userRes.value.data;
      profile.username = u.username || "";
    }

    if (coinsRes.status==="fulfilled" && Array.isArray(coinsRes.value?.data)) {
      const coins = coinsRes.value.data;
      profile.totalLaunches = coins.length;
      profile.scamEstimate  = coins.filter(c => !Boolean(c.complete) && Number(c.usd_market_cap||0) < CREATOR_MIN_MC_ALIVE).length;
      profile.rugRate       = coins.length > 0 ? profile.scamEstimate / coins.length : 0;
      profile.recentCoins   = coins.slice(0,3).map(c => ({
        symbol: c.symbol||"?", complete: Boolean(c.complete), mc: Number(c.usd_market_cap||0)
      }));
    }

    // Blacklist serial ruggers
    if (profile.rugRate > CREATOR_MAX_RUG_RATE && profile.totalLaunches >= 3) {
      blacklistedCreators.add(wallet);
      log(`Blacklisted creator ${wallet.slice(0,8)} — rug rate ${(profile.rugRate*100).toFixed(0)}%`);
    }

    creatorCache.set(wallet, profile);
    setTimeout(() => creatorCache.delete(wallet), 120000); // 2 min cache
    return profile;
  } catch(e) {
    return { wallet, username:"", totalLaunches:0, scamEstimate:0, rugRate:0, recentCoins:[] };
  }
}

async function checkCopycat(name, symbol, excludeMint) {
  try {
    const q = encodeURIComponent(symbol||name);
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${q}`, { timeout:8000 });
    const pairs = res.data?.pairs || [];
    const nameLower = (name||"").toLowerCase();
    const symLower  = (symbol||"").toLowerCase();
    const matches = pairs.filter(p => {
      if (p.chainId !== "solana") return false;
      const b = p.baseToken || {};
      const pName = (b.name||"").toLowerCase();
      const pSym  = (b.symbol||"").toLowerCase();
      const pMint = (b.address||"").toLowerCase();
      if (pMint === excludeMint?.toLowerCase()) return false;
      return pName === nameLower || pSym === symLower;
    });
    return matches.length;
  } catch(e) { return 0; }
}

// ─── GMGN API ─────────────────────────────────────────────────────────────────
const SOL_LAUNCHPAD_PLATFORMS = [
  "Pump.fun","pump_mayhem","pump_mayhem_agent","pump_agent",
  "letsbonk","bonkers","bags","memoo","liquid","bankr","zora",
  "surge","anoncoin","moonshot_app","wendotdev","heaven","sugar",
  "token_mill","believe","trendsfun","trends_fun","jup_studio",
  "Moonshot","boop","xstocks","ray_launchpad","meteora_virtual_curve",
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
  const body = { version:"v2" };
  for (const t of types) body[t] = { ...section };
  return body;
}

async function fetchOpenAPI(subPath, params={}, method="GET") {
  const wait = 2000-(Date.now()-lastOpenAPICall);
  if (wait > 0) await new Promise(r=>setTimeout(r,wait));
  lastOpenAPICall = Date.now();
  try {
    const ts  = Math.floor(Date.now()/1000);
    const cid = uuidv4();
    const headers = { "X-APIKEY":GMGN_API_KEY, "Accept":"application/json", "Content-Type":"application/json" };
    let res;
    if (method === "POST") {
      const chain = params.chain || "sol";
      const qs    = `chain=${chain}&timestamp=${ts}&client_id=${cid}`;
      const url   = `https://openapi.gmgn.ai${subPath}?${qs}`;
      const body  = params.body || params;
      res = await axiosAPI.post(url, body, { headers });
    } else {
      const allParams = { ...params, timestamp:String(ts), client_id:cid };
      const qs  = Object.entries(allParams).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join("&");
      const url = `https://openapi.gmgn.ai${subPath}?${qs}`;
      res = await axiosAPI.get(url, { headers });
    }
    if (res.status !== 200 || typeof res.data === "string") { log(`OpenAPI ${res.status}: ${JSON.stringify(res.data)?.slice(0,100)}`); return null; }
    if (res.data?.code !== 0) { log(`OpenAPI err: ${res.data?.error} ${res.data?.message}`); return null; }
    return res.data;
  } catch(e) { log(`OpenAPI error: ${e.message}`); return null; }
}

// Enrich KOL token with security fields from /v1/token/security
// Confirmed fields: top_10_holder_rate, burn_status, is_honeypot, is_blacklist
async function enrichToken(token) {
  try {
    const data = await fetchOpenAPI("/v1/token/security", { chain:"sol", address:token.address });
    if (!data?.data) return token;
    const s = data.data;
    return {
      ...token,
      top_10_holder_rate: s.top_10_holder_rate ?? token.top_10_holder_rate,
      burn_status:        s.burn_status        ?? token.burn_status,
      is_honeypot:        s.is_honeypot        ?? false,
      is_blacklist:       s.is_blacklist        ?? false,
    };
  } catch(e) { return token; }
}

// ─── AI FILTER (OpenRouter) ───────────────────────────────────────────────────
async function aiFilter(token) {
  if (Date.now() > aiResetTime) { aiCallsToday=0; aiResetTime=Date.now()+86400000; }
  const cached = aiCache.get(token.address);
  if (cached && Date.now()-cached.ts < AI_CACHE_TTL) return cached.result;

  // Fast pre-checks — no API call needed
  const rug   = token.rug_ratio || 0;
  const smart = token.smart_degen_count || 0;
  const liq   = token.liquidity || 0;
  if (rug > 0.5)               return cache(token.address, { decision:"REJECT", reason:"Rug>50%", risk:"VERY HIGH", confidence:99 });
  if (liq < 2000)              return cache(token.address, { decision:"REJECT", reason:"No liquidity", risk:"VERY HIGH", confidence:99 });
  if (token.is_wash_trading)   return cache(token.address, { decision:"REJECT", reason:"Wash trading", risk:"VERY HIGH", confidence:99 });
  if (token.is_honeypot)       return cache(token.address, { decision:"REJECT", reason:"Honeypot", risk:"VERY HIGH", confidence:99 });
  if (token.is_blacklist)      return cache(token.address, { decision:"REJECT", reason:"Blacklisted", risk:"VERY HIGH", confidence:99 });
  if (smart >= 3 && rug < 0.1) return cache(token.address, { decision:"APPROVE", reason:"Strong smart money", risk:"LOW", confidence:90 });

  if (!OPENROUTER_KEY || aiCallsToday >= AI_DAILY_LIMIT)
    return { decision:"APPROVE", reason:"AI limit", risk:"MEDIUM", confidence:50 };

  try {
    aiCallsToday++;
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: OPENROUTER_MODEL,
        max_tokens: 80,
        messages: [{
          role: "user",
          content: `Solana memecoin signal. Be LENIENT — only reject clear rugs or scams.\n` +
                   `Token: $${token.symbol} MC:$${Math.round(token.market_cap||0)} ` +
                   `Liq:$${Math.round(token.liquidity||0)} Smart:${token.smart_degen_count||0} ` +
                   `Rug:${((token.rug_ratio||0)*100).toFixed(0)}% Top10:${((token.top_10_holder_rate||0)*100).toFixed(0)}%\n` +
                   `REJECT only rug>40%, wash trading, or honeypot. ` +
                   `Respond ONLY with JSON: {"decision":"APPROVE","reason":"brief","risk":"LOW","confidence":75}`
        }]
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://infinix-bot.railway.app",
          "X-Title": "Infinix Alpha Bot"
        },
        timeout: 15000
      }
    );
    const text = res.data?.choices?.[0]?.message?.content || "{}";
    const r = JSON.parse(text.replace(/```json|```/g,"").trim());
    log(`AI: $${token.symbol} → ${r.decision} ${r.risk} ${r.confidence}%`);
    return cache(token.address, r);
  } catch(e) {
    log(`AI error: ${e.message}`);
    return { decision:"APPROVE", reason:"AI unavailable", risk:"MEDIUM", confidence:50 };
  }
}

function cache(addr, result) {
  aiCache.set(addr, { result, ts:Date.now() });
  return result;
}

// ─── PUMPPORTAL WEBSOCKET (Ultra Early real-time) ─────────────────────────────
function connectPumpPortal() {
  if (ppReconnectTimer) { clearTimeout(ppReconnectTimer); ppReconnectTimer=null; }
  try {
    const WebSocket = require("ws");
    ppWs = new WebSocket("wss://pumpportal.fun/api/data");

    ppWs.on("open", () => {
      log("PumpPortal WS connected ✅");
      ppWs.send(JSON.stringify({ method:"subscribeNewToken" }));
      ppWs.send(JSON.stringify({ method:"subscribeTokenTrade", keys:["all"] }));
    });

    ppWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await handlePumpPortalEvent(msg);
      } catch(e) {}
    });

    ppWs.on("close", () => {
      log("PumpPortal WS disconnected — reconnecting in 5s");
      ppWs = null;
      ppReconnectTimer = setTimeout(connectPumpPortal, 5000);
    });

    ppWs.on("error", (e) => {
      log(`PumpPortal WS error: ${e.message}`);
    });
  } catch(e) {
    log(`PumpPortal WS failed: ${e.message} — retrying in 10s`);
    ppReconnectTimer = setTimeout(connectPumpPortal, 10000);
  }
}

async function handlePumpPortalEvent(msg) {
  if (!msg || !msg.mint) return;
  const txType = (msg.txType||"").toLowerCase();

  // Normalize SOL amount
  let solAmt = msg.solAmount || 0;
  if (solAmt > 1e6) solAmt = solAmt / 1e9; // convert lamports to SOL

  // Track creator for CTO detection
  if (txType === "create" && msg.traderPublicKey) {
    creatorMap.set(msg.mint, msg.traderPublicKey);
    if (creatorMap.size > 10000) {
      const first = creatorMap.keys().next().value;
      creatorMap.delete(first);
    }
  }

  // CTO detection — creator sells their own token
  if (txType === "sell") {
    const creator = creatorMap.get(msg.mint);
    if (creator && msg.traderPublicKey === creator && solAmt >= 0.5) {
      await sendCTOAlert(msg, solAmt);
      return;
    }
  }

  // Whale detection
  if ((txType === "buy" || txType === "sell") && solAmt >= WHALE_SOL_THRESHOLD) {
    await sendWhaleAlert(msg, txType, solAmt);
    return;
  }

  // New token launch — queue for Ultra Early processing
  if (txType === "create" || (!msg.txType && msg.name)) {
    const tokenData = {
      address:          msg.mint,
      symbol:           msg.symbol || "???",
      name:             msg.name || "Unknown",
      creator:          msg.traderPublicKey || "",
      created_timestamp: Math.floor(Date.now()/1000),
      market_cap:       msg.marketCapSol ? msg.marketCapSol * 170 : 0, // rough USD estimate
      usd_market_cap:   msg.marketCapSol ? msg.marketCapSol * 170 : 0,
      volume:           0,
      holder_count:     0,
      rug_ratio:        0,
      bundler_trader_amount_rate: 0,
      top_10_holder_rate: 0,
      alertType:        "ULTRA_EARLY",
      fromWS:           true,
      _ageMs:           0,
    };
    ppUltraQueue.set(msg.mint, tokenData);
    // Process after 2 minutes to get some trading data
    setTimeout(() => processWSUltraToken(msg.mint), 120000);
  }
}

async function processWSUltraToken(mint) {
  if (!ppUltraQueue.has(mint)) return;
  const token = ppUltraQueue.get(mint);
  ppUltraQueue.delete(mint);

  if (globalAlerted.has(mint)) return;
  const ageMs = Date.now() - token.created_timestamp * 1000;
  if (ageMs > ULTRA_MAX_AGE_MS) return;

  // Check creator rug rate
  if (token.creator && blacklistedCreators.has(token.creator)) {
    log(`WS Ultra: blocked blacklisted creator ${token.creator.slice(0,8)}`);
    return;
  }

  token._ageMs = ageMs;
  const ai = await aiFilter(token);
  if (ai.decision === "REJECT") return;

  globalAlerted.add(mint);
  alerted.set(mint, Date.now());
  await sendUltraAlert(token, ai);
}

// ─── KOL SIGNALS ─────────────────────────────────────────────────────────────
async function getKOLSignals() {
  const seen = new Set(), results = [];

  // Try public API first
  const pubResponses = await Promise.allSettled([
    fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=smart_degen_count&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=100`),
    fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`),
  ]);

  let publicWorked = false;
  for (const r of pubResponses) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const list = r.value?.data?.rank || [];
    if (list.length > 0) { publicWorked = true; processKOLList(list, seen, results); }
  }

  if (!publicWorked) {
    for (const params of [
      { chain:"sol", interval:"1h", orderby:"smart_degen_count", direction:"desc", limit:"100" },
    ]) {
      const data = await fetchOpenAPI("/v1/market/rank", params);
      if (data) processKOLList(extractList(data), seen, results);
    }
  }

  // Enrich top 15 with security fields
  const sorted = results.sort((a,b)=>(b.smart_degen_count||0)-(a.smart_degen_count||0)).slice(0,15);
  const enriched = await Promise.all(sorted.map(t => enrichToken(t)));
  return enriched;
}

function extractList(data) {
  if (!data) return [];
  const d = data.data || data;
  if (Array.isArray(d.rank))   return d.rank;
  if (Array.isArray(d.tokens)) return d.tokens;
  if (Array.isArray(d.list))   return d.list;
  if (Array.isArray(d))        return d;
  return [];
}

function processKOLList(list, seen, results) {
  for (const t of list) {
    if (!t.address || seen.has(t.address) || globalAlerted.has(t.address)) continue;
    seen.add(t.address);
    const mc  = t.market_cap || 0;
    const age = t.open_timestamp ? (Date.now() - t.open_timestamp*1000) : null;
    const isNew = age !== null && age <= MAX_TOKEN_AGE_MS;
    if (mc >= MC_MIN && mc <= MC_MAX && (t.smart_degen_count||0) >= 1 && isNew)
      results.push({ ...t, alertType:"KOL" });
  }
}

// KOL hardFilter — ONLY confirmed fields from /v1/market/rank + /v1/token/security
function hardFilter(token) {
  const liq   = token.liquidity || 0;
  const vol   = token.volume    || 0;
  const mc    = token.market_cap || 0;
  const chg   = token.price_change_percent1h || 0;
  const top10 = token.top_10_holder_rate || 0;
  const honey = token.is_honeypot || false;
  const black = token.is_blacklist || false;

  if (liq   <  KOL_MIN_LIQ)        return false;
  if (vol   <  KOL_MIN_VOL)        return false;
  if (mc    <  MC_MIN)             return false;
  if (mc    >  MC_MAX)             return false;
  if (chg   <  KOL_MAX_PRICE_DROP) return false;
  if (top10 >  KOL_MAX_TOP10)      return false;
  if (honey)                        return false;
  if (black)                        return false;
  return true;
}

// ─── PUMP SIGNALS ─────────────────────────────────────────────────────────────
async function getPumpSignals() {
  const seen = new Set(), results = [];

  // Try public API
  const pubRes = await fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=volume&direction=desc&filters[]=not_honeypot&limit=100`);
  if (pubRes) {
    const list = pubRes?.data?.rank || pubRes?.data?.token_list || [];
    if (Array.isArray(list) && list.length > 0) { processPumpList(list, seen, results); }
  }

  if (results.length === 0) {
    const body = buildTrenchesBody(["near_completion"]);
    const data = await fetchOpenAPI("/v1/trenches", { chain:"sol", body }, "POST");
    if (data) processPumpList(data?.data?.pump || [], seen, results);
  }

  return results.sort((a,b)=>(b.volume_1h||b.volume||0)-(a.volume_1h||a.volume||0)).slice(0,10);
}

function processPumpList(list, seen, results) {
  for (const t of list) {
    if (!t.address || seen.has(t.address) || globalAlerted.has(t.address)) continue;
    seen.add(t.address);
    const progress = t.launchpad_status?.bonding_curve_percentage || t.graduation_progress || t.progress || 0;
    const volume   = t.volume_1h || t.volume_24h || t.volume || 0;
    const holders  = t.holder_count || 0;
    const mc       = t.usd_market_cap || t.market_cap || 0;
    const rug      = t.rug_ratio || 0;
    const bundle   = t.bundler_trader_amount_rate || 0;
    const wash     = t.is_wash_trading || false;
    const creator  = t.creator || "";

    if (blacklistedCreators.has(creator)) continue;
    if (progress >= PUMP_MIN_PROGRESS && progress <= PUMP_MAX_PROGRESS &&
        volume   >= PUMP_MIN_VOLUME   &&
        holders  >= PUMP_MIN_HOLDERS  &&
        rug      <  PUMP_MAX_RUG      &&
        bundle   <  PUMP_MAX_BUNDLE   &&
        !wash)
      results.push({ ...t, alertType:"PUMP", progress, market_cap:mc, volume });
  }
}

// ─── ULTRA SIGNALS (GMGN fallback) ───────────────────────────────────────────
async function getUltraSignals() {
  const seen = new Set(), results = [];

  // Try public API
  const pubResponses = await Promise.allSettled([
    fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`),
    fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/5m?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`),
  ]);

  let publicWorked = false;
  for (const r of pubResponses) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const list = r.value?.data?.rank || r.value?.data?.token_list || [];
    if (Array.isArray(list) && list.length > 0) { publicWorked = true; processUltraList(list, seen, results); }
  }

  if (!publicWorked) {
    const body = buildTrenchesBody(["new_creation"]);
    const data = await fetchOpenAPI("/v1/trenches", { chain:"sol", body }, "POST");
    if (data) processUltraList(data?.data?.new_creation || [], seen, results);
  }

  return results.sort((a,b)=>b.buyRatio-a.buyRatio).slice(0,5);
}

function processUltraList(list, seen, results) {
  for (const t of list) {
    if (!t.address || seen.has(t.address) || globalAlerted.has(t.address)) continue;
    seen.add(t.address);

    const ageMs  = t.created_timestamp ? (Date.now()-t.created_timestamp*1000)
                 : t.open_timestamp    ? (Date.now()-t.open_timestamp*1000) : null;
    if (!ageMs || ageMs > ULTRA_MAX_AGE_MS) continue;

    // All confirmed fields from trenches response
    const volume  = t.volume_1h || t.volume_24h || t.volume || 0;
    const holders = t.holder_count || 0;
    const buys    = t.buys_24h || t.buys || 0;
    const sells   = t.sells_24h || t.sells || 0;
    const buyRatio= sells > 0 ? buys/sells : buys > 0 ? buys : 0;
    const mc      = t.usd_market_cap || t.market_cap || 0;
    const rug     = t.rug_ratio || 0;
    const bundle  = t.bundler_trader_amount_rate || 0;
    const top10   = t.top_10_holder_rate || 0;
    const buyTax  = parseFloat(t.buy_tax || 0);
    const devBal  = t.creator_balance_rate || 0;
    const wash    = t.is_wash_trading || false;
    const burned  = t.burn_status === "burn";
    const smart   = t.smart_degen_count || 0;
    const creator = t.creator || "";

    if (blacklistedCreators.has(creator)) continue;

    if (volume   >= ULTRA_MIN_VOLUME    &&
        holders  >= ULTRA_MIN_HOLDERS   &&
        buyRatio >= ULTRA_MIN_BUY_RATIO &&
        rug      <  ULTRA_MAX_RUG       &&
        bundle   <  ULTRA_MAX_BUNDLE    &&
        top10    <  ULTRA_MAX_TOP10     &&
        buyTax   === 0                  &&
        devBal   <  ULTRA_MAX_DEV_BAL   &&
        !wash                           &&
        (burned || smart >= 1))
      results.push({ ...t, alertType:"ULTRA_EARLY", _ageMs:ageMs, buys, sells, buyRatio, market_cap:mc, volume });
  }
}

// ─── PERFORMANCE TRACKER ─────────────────────────────────────────────────────
async function getTokenPrice(mint) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout:8000 });
    const pairs = (res.data?.pairs||[]).filter(p=>p.chainId==="solana");
    if (!pairs.length) return null;
    pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0));
    return {
      price:     parseFloat(pairs[0].priceUsd||0),
      mc:        pairs[0].fdv||0,
      liquidity: pairs[0].liquidity?.usd||0,
      sells:     pairs[0].txns?.h1?.sells||0,
      buys:      pairs[0].txns?.h1?.buys||0,
    };
  } catch(e) { return null; }
}

async function trackPerformance(mint, alertPrice, alertMC, symbol, msgId, sigType) {
  performanceTracker.set(mint, {
    alertPrice, alertMC, symbol, alertTime:Date.now(), msgId, sigType,
    peakX:1, notified2x:false, notified5x:false, notified10x:false, notifiedDistrib:false
  });

  const interval = setInterval(async () => {
    const tr = performanceTracker.get(mint);
    if (!tr) { clearInterval(interval); return; }
    if (Date.now()-tr.alertTime > 86400000) {
      const v = tr.peakX>=10?"🌙 MOONSHOT":tr.peakX>=5?"🔥 BANGER":tr.peakX>=2?"✅ WIN":"🔴 MISS";
      await bot.sendMessage(CHAT_ID,`📋 *24h Report* $${symbol}\nPeak: ${tr.peakX.toFixed(2)}x ${v}`,{parse_mode:"Markdown"}).catch(()=>{});
      performanceTracker.delete(mint); clearInterval(interval); return;
    }
    const cur = await getTokenPrice(mint);
    if (!cur?.price || !alertPrice) return;
    const x = cur.price / alertPrice;
    if (x > tr.peakX) tr.peakX = x;
    const stats = botStats[sigType] || botStats.kol;
    if (cur.sells>cur.buys*2&&x>1.5&&!tr.notifiedDistrib) {
      tr.notifiedDistrib = true;
      await bot.sendMessage(CHAT_ID,`⚠️ *DISTRIBUTION* $${symbol} ${x.toFixed(2)}x — Sell pressure!`,{parse_mode:"Markdown",reply_to_message_id:msgId}).catch(()=>{});
    }
    if (x>=10&&!tr.notified10x){tr.notified10x=true;stats.hits10x++;await bot.sendMessage(CHAT_ID,`🌙🌙🌙 *10x!* $${symbol} up *${x.toFixed(2)}x*!`,{parse_mode:"Markdown",reply_to_message_id:msgId}).catch(()=>{});}
    else if (x>=5&&!tr.notified5x){tr.notified5x=true;stats.hits5x++;await bot.sendMessage(CHAT_ID,`🚀🚀 *5x!* $${symbol} up *${x.toFixed(2)}x*!`,{parse_mode:"Markdown",reply_to_message_id:msgId}).catch(()=>{});}
    else if (x>=2&&!tr.notified2x){tr.notified2x=true;stats.hits2x++;await bot.sendMessage(CHAT_ID,`✅ *2x!* $${symbol} up *${x.toFixed(2)}x*!`,{parse_mode:"Markdown",reply_to_message_id:msgId}).catch(()=>{});}
    if (cur.liquidity<2000&&tr.peakX>1.5){
      await bot.sendMessage(CHAT_ID,`⚠️ *LIQ WARNING* $${symbol} — exit now!`,{parse_mode:"Markdown",reply_to_message_id:msgId}).catch(()=>{});
      performanceTracker.delete(mint); clearInterval(interval);
    }
  }, 3*60*1000);
}

// ─── INSIDER WALLETS ──────────────────────────────────────────────────────────
async function pollInsiderWallets() {
  if (!HELIUS_API_KEY) return;
  const WSOL = "So11111111111111111111111111111111111111112";
  for (const [wallet,name] of Object.entries(INSIDER_WALLETS)) {
    try {
      const res = await axios.get(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=5&type=SWAP`,{timeout:8000});
      const txs = res.data||[];
      if (!txs.length) continue;
      const newTxs = lastSig[wallet] ? txs.filter(t=>t.signature!==lastSig[wallet]) : txs.slice(0,2);
      if (newTxs.length) lastSig[wallet]=txs[0].signature;
      for (const tx of newTxs) {
        const recv=(tx.tokenTransfers||[]).find(t=>t.toUserAccount===wallet&&t.mint!==WSOL);
        if (!recv?.mint) continue;
        if (!insiderBuys[recv.mint]) insiderBuys[recv.mint]={};
        insiderBuys[recv.mint][name]=Date.now();
      }
    } catch(e) {}
    await new Promise(r=>setTimeout(r,500));
  }
  // Clean stale insider buys
  const cutoff = Date.now()-7200000;
  for (const [mint,buyers] of Object.entries(insiderBuys)) {
    for (const [k,ts] of Object.entries(buyers)) { if(ts<cutoff) delete insiderBuys[mint][k]; }
    if (!Object.keys(insiderBuys[mint]).length) delete insiderBuys[mint];
  }
}

// ─── KEYBOARD ─────────────────────────────────────────────────────────────────
function buildKeyboard(mint, isPump) {
  return { inline_keyboard:[
    [{text:"🚀 BUY 0.1 SOL via Trojan", url:`https://t.me/solana_trojanbot?start=ca_${mint}`}],
    [{text:"📊 DexScreener", url:`https://dexscreener.com/solana/${mint}`},{text:"🔍 GMGN", url:`https://gmgn.ai/sol/token/${mint}`}],
    [{text:isPump?"🎯 PumpFun":"⚡ Axiom", url:isPump?`https://pump.fun/${mint}`:`https://axiom.trade/t/${mint}`},{text:"📈 Stats", callback_data:"stats"}],
    [{text:"❌ Skip", callback_data:`skip_${mint.slice(0,20)}`}],
  ]};
}

// ─── ALERTS ───────────────────────────────────────────────────────────────────
async function sendKOLAlert(token, ai, creatorProfile, copycatCount) {
  const mint   = token.address;
  const sym    = token.symbol || "???";
  const riskEmoji = ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";
  const insiders  = Object.keys(insiderBuys[mint]||{});
  const insiderStr = insiders.length > 0 ? `\n└ 👛 ${insiders.join(", ")}` : "";
  const copyStr    = copycatCount > 0 ? `\n⚠️ COPYCAT RISK — ${copycatCount+1} tokens named $${sym}` : "";
  const creatorStr = creatorProfile.totalLaunches > 0
    ? `\n└ 👤 ${creatorProfile.username||"Unknown"} | Launches:${creatorProfile.totalLaunches} Rugs:${creatorProfile.scamEstimate}`
    : "";

  const msg =
    `🚨 *KOL SIGNAL* — Infinix\n` +
    `AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%${copyStr}\n\n` +
    `*$${sym}*\n\`${mint}\`\n` +
    `└ ⏱ ${fmtAge(token.open_timestamp)} | 👁 ${token.holder_count||"N/A"} holders\n\n` +
    `📊 *Token Details*\n` +
    `├ PRICE:  ${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"}\n` +
    `├ MC:     ${fmt(token.market_cap||0)}\n` +
    `├ Vol 1h: ${fmt(token.volume||0)}\n` +
    `├ Liq:    ${fmt(token.liquidity||0)}\n` +
    `└ 1h Chg: ${(token.price_change_percent1h||0)>0?"+":""}${(token.price_change_percent1h||0).toFixed(1)}%\n\n` +
    `🧠 *Smart Signals*\n` +
    `├ Smart Money: ${token.smart_degen_count||0} 🤖\n` +
    `├ KOL Holders: ${token.renowned_count||0} 👑\n` +
    `└ Netflow: ${(token.buy_5m||0)>(token.sell_5m||0)?"🟢 Accumulating":"🔴 Selling"}${insiderStr}\n\n` +
    `🔒 *Security*\n` +
    `├ Top10: ${((token.top_10_holder_rate||0)*100).toFixed(0)}% | Burn: ${token.burn_status||"N/A"}\n` +
    `├ Honeypot: ${token.is_honeypot?"🔴 YES":"🟢 No"}\n` +
    `└ 📢 DEX: ${getDexPromo(token)}\n` +
    `${creatorStr}\n\n` +
    `💰 *Snipe 0.1 SOL?*`;

  const sent = await bot.sendMessage(CHAT_ID, msg, { parse_mode:"Markdown", disable_web_page_preview:true, reply_markup:buildKeyboard(mint,false) });
  if (token.price) await trackPerformance(mint, parseFloat(token.price), token.market_cap||0, sym, sent.message_id, "kol");
  botStats.kol.alerts++;
  log(`KOL: $${sym} smart:${token.smart_degen_count||0} kol:${token.renowned_count||0}`);
}

async function sendPumpAlert(token, ai, creatorProfile, copycatCount) {
  const mint   = token.address;
  const sym    = token.symbol || "???";
  const prog   = token.progress || 0;
  const bar    = "█".repeat(Math.floor(prog/10)) + "░".repeat(10-Math.floor(prog/10));
  const urgency = prog>=90?"🔴 MIGRATING SOON":prog>=75?"🟡 FILLING FAST":"🟢 EARLY";
  const riskEmoji = ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";
  const copyStr   = copycatCount > 0 ? `⚠️ COPYCAT RISK — ${copycatCount+1} same name\n` : "";
  const creatorStr = creatorProfile.totalLaunches > 0
    ? `👤 ${creatorProfile.username||"Unknown"} | ${creatorProfile.totalLaunches} launches | ${creatorProfile.scamEstimate} rugs\n`
    : "";

  const msg =
    `🎯 *PUMP PRE-BOND* — ${urgency}\n` +
    `AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%\n` +
    `${copyStr}${creatorStr}\n` +
    `*$${sym}*\n\`${mint}\`\n\n` +
    `🏦 *Bonding Curve*\n[${bar}] ${prog.toFixed(1)}%\n\n` +
    `📊 MC: ${fmt(token.market_cap||0)} | Vol: ${fmt(token.volume||0)}\n` +
    `👁 ${token.holder_count||"N/A"} holders | Smart: ${token.smart_degen_count||0} 🤖\n` +
    `📢 DEX: ${getDexPromo(token)}\n\n` +
    `⚡ Buy before Raydium migration!\n💰 *Snipe 0.1 SOL?*`;

  const sent = await bot.sendMessage(CHAT_ID, msg, { parse_mode:"Markdown", disable_web_page_preview:true, reply_markup:buildKeyboard(mint,true) });
  if (token.price) await trackPerformance(mint, parseFloat(token.price), token.market_cap||0, sym, sent.message_id, "pump");
  botStats.pump.alerts++;
  log(`Pump: $${sym} ${prog.toFixed(0)}%`);
}

async function sendUltraAlert(token, ai) {
  const mint   = token.address;
  const sym    = token.symbol || "???";
  const ageMin = Math.floor((token._ageMs||0)/60000);
  const prog   = token.progress || 0;
  const bar    = "█".repeat(Math.floor(prog/10)) + "░".repeat(10-Math.floor(prog/10));
  const momentum = (token.buyRatio||0)>=10?"🔥🔥🔥 INSANE":(token.buyRatio||0)>=5?"🔥🔥 VERY HIGH":"🔥 HIGH";
  const riskEmoji = ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";
  const wsTag  = token.fromWS ? "⚡ REAL-TIME" : "📡 GMGN";

  const msg =
    `🚀 *ULTRA EARLY* — ${momentum} ${wsTag}\n` +
    `AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%\n\n` +
    `*$${sym}*\n\`${mint}\`\n` +
    `└ ⏱ ${ageMin}m old | 👁 ${token.holder_count||"N/A"} holders\n\n` +
    `📈 *Curve*\n[${bar}] ${prog.toFixed(1)}%\n\n` +
    `⚡ *Momentum*\n` +
    `├ Vol:  ${fmt(token.volume||0)}\n` +
    `├ Buys: ${token.buys||0} | Sells: ${token.sells||0}\n` +
    `└ B/S:  ${(token.buyRatio||0).toFixed(1)}:1\n\n` +
    `📊 MC: ${fmt(token.market_cap||0)} | Smart: ${token.smart_degen_count||0} 🤖\n` +
    `Rug: ${((token.rug_ratio||0)*100).toFixed(0)}% | Bundle: ${((token.bundler_trader_amount_rate||0)*100).toFixed(0)}%\n\n` +
    `💰 *Snipe 0.1 SOL?* — Always DYOR`;

  const sent = await bot.sendMessage(CHAT_ID, msg, { parse_mode:"Markdown", disable_web_page_preview:true, reply_markup:buildKeyboard(mint,true) });
  if (token.price) await trackPerformance(mint, parseFloat(token.price), token.market_cap||0, sym, sent.message_id, "ultra");
  botStats.ultra.alerts++;
  log(`Ultra: $${sym} age:${ageMin}m ratio:${(token.buyRatio||0).toFixed(1)} source:${token.fromWS?"WS":"GMGN"}`);
}

async function sendCTOAlert(msg, solAmt) {
  const mint = msg.mint;
  if (globalAlerted.has(`cto_${mint}`)) return;
  globalAlerted.add(`cto_${mint}`);
  botStats.cto.alerts++;

  const text =
    `👑 *CTO EVENT* — Creator Sold!\n\n` +
    `*$${msg.symbol||"???"}*\n\`${mint}\`\n\n` +
    `Creator sold ${solAmt.toFixed(2)} SOL worth\n` +
    `Community can now take over!\n\n` +
    `📊 [DexScreener](https://dexscreener.com/solana/${mint}) | [GMGN](https://gmgn.ai/sol/token/${mint})`;

  await bot.sendMessage(CHAT_ID, text, { parse_mode:"Markdown", disable_web_page_preview:true }).catch(()=>{});
  log(`CTO: $${msg.symbol||"?"} creator sold ${solAmt.toFixed(2)} SOL`);
}

async function sendWhaleAlert(msg, txType, solAmt) {
  const mint = msg.mint;
  const key  = `whale_${mint}_${Math.floor(Date.now()/60000)}`; // dedupe per minute
  if (globalAlerted.has(key)) return;
  globalAlerted.add(key);

  const emoji = txType === "buy" ? "🐋🟢" : "🐋🔴";
  const text  =
    `${emoji} *WHALE ${txType.toUpperCase()}*\n\n` +
    `*$${msg.symbol||"???"}*\n\`${mint}\`\n\n` +
    `Amount: ${solAmt.toFixed(2)} SOL\n` +
    `[DexScreener](https://dexscreener.com/solana/${mint})`;

  await bot.sendMessage(CHAT_ID, text, { parse_mode:"Markdown", disable_web_page_preview:true }).catch(()=>{});
  log(`Whale: ${txType} $${msg.symbol||"?"} ${solAmt.toFixed(2)} SOL`);
}

// ─── TELEGRAM CALLBACKS ───────────────────────────────────────────────────────
bot.on("callback_query", async (q) => {
  try {
    if (q.data?.startsWith("skip_")) {
      await bot.answerCallbackQuery(q.id, { text:"Skipped!" });
      await bot.editMessageReplyMarkup(
        { inline_keyboard:[[{text:"⏭ Skipped",callback_data:"done"}]] },
        { chat_id:q.message.chat.id, message_id:q.message.message_id }
      );
    }
    if (q.data === "stats") {
      await bot.answerCallbackQuery(q.id);
      const s = botStats;
      await bot.sendMessage(CHAT_ID,
        `📊 *Infinix Stats*\n\n` +
        `KOL:   ${s.kol.alerts} alerts | 2x:${s.kol.hits2x} 5x:${s.kol.hits5x} 10x:${s.kol.hits10x}\n` +
        `Pump:  ${s.pump.alerts} alerts | 2x:${s.pump.hits2x} 5x:${s.pump.hits5x} 10x:${s.pump.hits10x}\n` +
        `Ultra: ${s.ultra.alerts} alerts | 2x:${s.ultra.hits2x} 5x:${s.ultra.hits5x} 10x:${s.ultra.hits10x}\n` +
        `CTO:   ${s.cto.alerts} events\n` +
        `AI calls: ${aiCallsToday}/${AI_DAILY_LIMIT}\n` +
        `Tracking: ${performanceTracker.size} tokens\n` +
        `Blacklisted creators: ${blacklistedCreators.size}`,
        { parse_mode:"Markdown" }
      );
    }
  } catch(e) {}
});

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scan() {
  log("Scanning...");
  pollInsiderWallets().catch(()=>{});

  const [kolTokens, pumpTokens, ultraTokens] = await Promise.all([
    getKOLSignals(), getPumpSignals(), getUltraSignals()
  ]);

  log(`KOL:${kolTokens.length} Pump:${pumpTokens.length} Ultra:${ultraTokens.length}`);

  // Apply hardFilter to KOL only (pump/ultra already filtered in their functions)
  const filteredKOL  = kolTokens.filter(t => hardFilter(t));
  const allTokens    = [
    ...ultraTokens.map(t=>({...t,_type:"ultra"})),
    ...filteredKOL.map(t=>({...t,_type:"kol"})),
    ...pumpTokens.map(t=>({...t,_type:"pump"})),
  ];

  log(`After hardFilter: ${filteredKOL.length} KOL | Processing ${allTokens.length} total`);

  let sent = 0;
  for (const token of allTokens) {
    if (sent >= 3) break;
    const mint = token.address;
    if (globalAlerted.has(mint)) continue;
    if (alerted.has(mint) && Date.now()-alerted.get(mint) < ALERT_COOLDOWN_MS) continue;

    // AI filter
    const ai = await aiFilter(token);
    if (ai.decision === "REJECT") { log(`AI rejected: $${token.symbol} — ${ai.reason}`); continue; }

    // Creator rug check (async, non-blocking for speed)
    let creatorProfile = { wallet:"", totalLaunches:0, scamEstimate:0, rugRate:0, recentCoins:[], username:"" };
    const creator = token.creator || token.creator_address || "";
    if (creator) {
      if (blacklistedCreators.has(creator)) { log(`Blocked blacklisted creator: ${creator.slice(0,8)}`); continue; }
      creatorProfile = await fetchCreatorProfile(creator);
      if (blacklistedCreators.has(creator)) continue; // re-check after fetch
    }

    // Copycat detection
    const copycatCount = await checkCopycat(token.name||"", token.symbol||"", mint);
    if (copycatCount > 3) { log(`Skipping $${token.symbol} — ${copycatCount+1} copycats`); continue; }

    globalAlerted.add(mint);
    alerted.set(mint, Date.now());

    try {
      if (token._type === "ultra")     await sendUltraAlert(token, ai);
      else if (token._type === "pump") await sendPumpAlert(token, ai, creatorProfile, copycatCount);
      else                             await sendKOLAlert(token, ai, creatorProfile, copycatCount);
      sent++;
    } catch(e) { log(`Alert error: ${e.message}`); }

    await new Promise(r=>setTimeout(r,1500));
  }

  // Cleanup
  if (globalAlerted.size > 500) [...globalAlerted].slice(0,100).forEach(m=>globalAlerted.delete(m));
  const now = Date.now();
  for (const [k,v] of aiCache.entries())  { if(now-v.ts>AI_CACHE_TTL) aiCache.delete(k); }
  for (const [k,ts] of alerted.entries()) { if(now-ts>ALERT_COOLDOWN_MS) alerted.delete(k); }
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  log("🚀 Infinix Alpha Bot — Starting...");

  // Check env vars
  const missing = ["TELEGRAM_TOKEN","CHAT_ID","GMGN_API_KEY","OPENROUTER_KEY"].filter(k=>!process.env[k]);
  if (missing.length) { log(`⚠️ Missing env vars: ${missing.join(", ")}`); }

  try {
    const r = await axios.get("https://api.ipify.org?format=json",{timeout:5000});
    log(`Railway IP: ${r.data.ip}`);
  } catch(e) {}

  // Connect PumpPortal WebSocket for real-time Ultra Early
  connectPumpPortal();

  await bot.sendMessage(CHAT_ID,
    `⚡ *Infinix Alpha Bot Online*\n\n` +
    `🎯 3 Signal Types:\n` +
    `├ 🚨 KOL — Smart money signals\n` +
    `├ 🎯 Pump — Pre-bond near graduation\n` +
    `└ 🚀 Ultra Early — Real-time via PumpPortal WS\n\n` +
    `🛡️ Intelligence:\n` +
    `├ 👤 Creator rug rate check\n` +
    `├ 🔍 Copycat detection\n` +
    `├ 👑 CTO event alerts\n` +
    `├ 🐋 Whale trade alerts\n` +
    `├ 🤖 AI filter (OpenRouter Llama 3.3 70B)\n` +
    `└ 📊 2x/5x/10x milestone tracking\n\n` +
    `Scanning every 60s | WS real-time 🔥`,
    { parse_mode:"Markdown" }
  );

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
