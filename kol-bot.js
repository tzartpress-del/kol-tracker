const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const https = require("https");
const dns = require("dns");
const crypto = require("crypto");
const express = require("express");
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

// ─── WEBHOOK CONFIG ──────────────────────────────────────────────────────────
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "bcbf41cc-88ad-4f45-8e41-2ac7043f4f4c";
const WEBHOOK_PORT   = parseInt(process.env.PORT) || 3000;

// ─── ORIGINAL V12 FILTERS ────────────────────────────────────────────────────
const MC_MIN              = 15000;
const MC_MAX              = 150000;
const POLL_INTERVAL_MS    = 60000;
const ALERT_COOLDOWN_MS   = 3600000;
const MAX_TOKEN_AGE_MS    = 24 * 60 * 60 * 1000;
const REENTRY_MIN_VOLUME  = 50000;

// PumpFun Pre-Bond
const PUMP_MIN_VOLUME     = 20000;
const PUMP_MIN_PROGRESS   = 60;
const PUMP_MAX_PROGRESS   = 98;
const PUMP_MIN_HOLDERS    = 100;

// Ultra Early
const ULTRA_MAX_AGE_MS    = 30 * 60 * 1000;
const ULTRA_MIN_VOLUME    = 3000;
const ULTRA_MIN_HOLDERS   = 30;
const ULTRA_MIN_BUY_RATIO = 2;

// KOL Early (v6)
const KOLE_MIN_RENOWNED   = 2;
const KOLE_MAX_MC         = 100000;
const KOLE_MAX_AGE_MS     = 60 * 60 * 1000;
const KOLE_MAX_BUNDLE     = 0.4;
const KOLE_MAX_RUG        = 0.3;

// ─── STABLE GEM CONFIG (v7) ───────────────────────────────────────────────────
const STABLE_GEM_INTERVAL_MS      = 10 * 60 * 1000;
const STABLE_GEM_MC_MIN           = 500_000;
const STABLE_GEM_MC_MAX           = 1_000_000;
const STABLE_GEM_VOLATILITY_MAX   = 0.35;
const STABLE_GEM_PRICE_CHANGE_MIN = -20;
const STABLE_GEM_PRICE_CHANGE_MAX = 50;
const STABLE_GEM_VOLUME_MIN       = 50_000;
const STABLE_GEM_HOLDER_MIN       = 200;
const STABLE_GEM_BUY_RATIO_MIN    = 1.2;
const STABLE_GEM_MAX_AGE_DAYS     = 30;
const STABLE_GEM_COOLDOWN_MS      = 24 * 60 * 60 * 1000;

// ─── V12 ELITE FILTER VALUES (v7.3) ───────────────────────────────────────────
// Ported from v12 "elite" code to cut the breakeven flood. Applied in hardFilter.
const ELITE_MIN_HOLDERS   = 40;
const ELITE_MIN_LIQ       = 7000;
const ELITE_MAX_RUG       = 0.18;
const ELITE_MAX_BUNDLE    = 0.25;
const ELITE_MIN_SMART     = 1;
const ELITE_MAX_TOP10     = 0.35;
const ANTIFARM_HOLDERS    = 500;    // > this holders
const ANTIFARM_MIN_VOL    = 10000;  // with < this volume = farm, reject

const OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const AI_DAILY_LIMIT   = 200;
const AI_CACHE_TTL     = 1800000;

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
const devWalletCache      = new Map();
const trustedDevs         = new Map();
const stableGemAlerted   = new Map();

const botStats = {
  kol:        { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
  pump:       { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
  ultra:      { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
  kolEarly:   { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
  stableGem:  { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
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

// ─── HARD FILTER (v7.3 — v12 ELITE values + anti-farm) ───────────────────────
// Applied to KOL signals. Stricter than v7.2 to cut the breakeven flood.
// Ultra/Pump/KOL-Early have their own dedicated filters and bypass this.
function hardFilter(token) {
  const liq      = token.liquidity          || 0;
  const mc       = token.market_cap         || 0;
  const top10    = token.top_10_holder_rate || 0;
  const honeypot = token.is_honeypot        || false;
  const blacklisted = token.is_blacklist    || false;
  const vol      = token.volume             || 0;
  const holders  = token.holder_count       || 0;
  const rug      = token.rug_ratio          || 0;
  const bundle   = token.bundler_trader_amount_rate || 0;
  const smart    = token.smart_degen_count  || 0;

  // Base safety
  if (mc < MC_MIN)      return false;
  if (mc > MC_MAX)      return false;
  if (honeypot)         return false;
  if (blacklisted)      return false;
  if (blacklist.has(token.creator||"")) return false;

  // v12 ELITE filter — stricter, cuts breakevens
  if (holders < ELITE_MIN_HOLDERS) return false;  // was: not checked
  if (liq < ELITE_MIN_LIQ)         return false;  // was: 5000
  if (rug > ELITE_MAX_RUG)         return false;  // was: AI only
  if (bundle > ELITE_MAX_BUNDLE)   return false;  // was: not checked
  if (smart < ELITE_MIN_SMART)     return false;  // was: not checked
  if (top10 > ELITE_MAX_TOP10)     return false;  // was: 0.50

  // ANTI-FARM (v12) — many holders but no real volume = fake/airdropped
  if (holders > ANTIFARM_HOLDERS && vol < ANTIFARM_MIN_VOL) return false;

  return true;
}

function calcFinalScore(token, aiConf, insiderCount) {
  let s = 0;
  const smart  = token.smart_degen_count || 0;
  const kol    = token.renowned_count    || 0;
  const rug    = token.rug_ratio         || 0;
  const liq    = token.liquidity         || 0;
  const vol    = token.volume            || 0;
  const chg1h  = token.price_change_percent1h || 0;

  if (smart>=3) s+=3; else if (smart>=1) s+=2;
  if (kol>=2)   s+=2; else if (kol>=1)   s+=1;
  if (liq>15000) s+=2; else if (liq>7000) s+=1;
  if (vol>50000) s+=2; else if (vol>20000) s+=1;
  if (chg1h>50)  s+=2;
  else if (chg1h>10) s+=1;
  else if (chg1h<-50) s-=2;
  if (rug>0.20) s-=3;
  if ((token.bundler_trader_amount_rate||0)>0.25) s-=2;
  if (token.is_wash_trading) s-=3;
  if (token.creator_token_status==="sell") s-=2;
  if (token.creator_token_status==="hold") s+=1;
  if (token.renounced_mint===1) s+=1;
  s += Math.floor((aiConf||50)/20);
  if (getVelocity(token)>=1.5) s+=1;
  s += insiderCount;
  if (token._devBestATH >= 1000000) s+=2;
  else if (token._devBestATH >= 100000) s+=1;
  if (token._isTrustedDev) s+=5;
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
        `📊 *Apex v7.4 Stats*\n\n`+
        `KOL: ${s.kol.alerts} | 2x:${s.kol.hits2x} 5x:${s.kol.hits5x} 10x:${s.kol.hits10x}\n`+
        `Pump: ${s.pump.alerts} | 2x:${s.pump.hits2x} 5x:${s.pump.hits5x} 10x:${s.pump.hits10x}\n`+
        `Ultra: ${s.ultra.alerts} | 2x:${s.ultra.hits2x} 5x:${s.ultra.hits5x} 10x:${s.ultra.hits10x}\n`+
        `KOL Early: ${s.kolEarly.alerts} | 2x:${s.kolEarly.hits2x} 5x:${s.kolEarly.hits5x} 10x:${s.kolEarly.hits10x}\n`+
        `Stable Gem: ${s.stableGem.alerts} | 2x:${s.stableGem.hits2x} 5x:${s.stableGem.hits5x} 10x:${s.stableGem.hits10x}\n\n`+
        `AI: ${aiCallsToday}/${AI_DAILY_LIMIT} | Tracking: ${performanceTracker.size}\n`+
        `Blacklisted creators: ${blacklistedCreators.size}`,
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

// ─── TRUSTED DEVS ────────────────────────────────────────────────────────────
async function loadTrustedDevs() {
  try {
    const res = await axios.get(
      `${SUPABASE_URL}/rest/v1/trusted_devs?select=*`,
      { headers:{ "apikey":SUPABASE_KEY, "Authorization":`Bearer ${SUPABASE_KEY}` }, timeout:8000 }
    );
    if (Array.isArray(res.data)) {
      for (const d of res.data) {
        trustedDevs.set(d.dev_wallet, { best_x:d.best_x, symbol:d.token_symbol });
      }
      log(`Loaded ${trustedDevs.size} trusted 10x devs from Supabase`);
    }
  } catch(e) { log(`loadTrustedDevs error: ${e.message}`); }
}

async function addTrustedDev(wallet, bestX, symbol, mint) {
  if (!wallet || trustedDevs.has(wallet)) return;
  trustedDevs.set(wallet, { best_x:bestX, symbol });
  log(`🌟 NEW TRUSTED DEV: ${wallet.slice(0,8)} made ${bestX.toFixed(1)}x with $${symbol}`);
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/trusted_devs`,
      { dev_wallet:wallet, best_x:bestX, token_symbol:symbol, token_mint:mint },
      { headers:{
          "apikey":SUPABASE_KEY, "Authorization":`Bearer ${SUPABASE_KEY}`,
          "Content-Type":"application/json", "Prefer":"resolution=merge-duplicates"
        }, timeout:8000 }
    );
  } catch(e) { log(`addTrustedDev error: ${e.message}`); }
  await bot.sendMessage(CHAT_ID,
    `🌟 *NEW TRUSTED DEV ADDED*\n\n`+
    `Dev made *${bestX.toFixed(1)}x* with $${symbol}\n`+
    `\`${wallet}\`\n\n`+
    `Future tokens from this dev get priority! 🚀`,
    { parse_mode:"Markdown" }
  ).catch(()=>{});
}

// ─── CREATOR RUG CHECK ────────────────────────────────────────────────────────
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

// ─── GMGN DEV WALLET ATH CHECK ───────────────────────────────────────────────
async function fetchDevWalletQuality(wallet) {
  if (!wallet) return { bestATH:0, gradCount:0, totalTokens:0, gradRate:0 };
  if (devWalletCache.has(wallet)) return devWalletCache.get(wallet);

  const result = { bestATH:0, gradCount:0, totalTokens:0, gradRate:0 };
  try {
    const data = await fetchOpenAPI("/v1/wallet/created_tokens", {
      chain: "sol",
      wallet: wallet,
      limit: "50"
    });
    const tokens = extractList(data);
    if (tokens.length > 0) {
      result.totalTokens = tokens.length;
      for (const t of tokens) {
        const ath = t.ath_market_cap || t.max_market_cap || t.usd_market_cap || 0;
        if (ath > result.bestATH) result.bestATH = ath;
        if (t.complete || t.is_graduated || t.graduated) result.gradCount++;
      }
      result.gradRate = result.totalTokens > 0 ? result.gradCount / result.totalTokens : 0;
    }
  } catch(e) {
    log(`Dev wallet quality error ${wallet.slice(0,8)}: ${e.message}`);
  }

  devWalletCache.set(wallet, result);
  setTimeout(() => devWalletCache.delete(wallet), 300000);
  return result;
}

function fmtDevQuality(q) {
  if (!q || q.totalTokens === 0) return "🆕 New dev (no history)";
  const athStr = q.bestATH >= 1000000 ? `$${(q.bestATH/1000000).toFixed(1)}M`
               : q.bestATH >= 1000 ? `$${(q.bestATH/1000).toFixed(0)}K`
               : `$${q.bestATH.toFixed(0)}`;
  let badge = "";
  if (q.bestATH >= 1000000)      badge = "🏆 PROVEN";
  else if (q.bestATH >= 100000)  badge = "✅ Decent";
  else if (q.gradCount > 0)      badge = "🟡 Some grads";
  else                            badge = "⚠️ No grads";
  return `${badge} | Best ATH: ${athStr} | ${q.gradCount}/${q.totalTokens} grad`;
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

// ─── AI FILTER ────────────────────────────────────────────────────────────────
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

// ─── WEBHOOK SERVER ──────────────────────────────────────────────────────────
function startWebhookServer() {
  const app = express();
  app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
  }));
  app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));
  app.post("/webhook", (req, res) => {
    try {
      if (WEBHOOK_SECRET) {
        const sig = req.headers["authorization"] || req.headers["x-helius-signature"] || "";
        if (sig && sig !== WEBHOOK_SECRET) {
          log(`[Webhook] Invalid signature — rejected`);
          return res.status(401).json({ error: "unauthorized" });
        }
      }
      res.status(200).json({ ok: true });
      const events = Array.isArray(req.body) ? req.body : [req.body];
      for (const event of events) {
        processWebhookEvent(event).catch(e => log(`[Webhook] processEvent error: ${e.message}`));
      }
    } catch(e) {
      log(`[Webhook] handler error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });
  app.listen(WEBHOOK_PORT, () => {
    log(`[Webhook] Server listening on port ${WEBHOOK_PORT}`);
  });
}

async function processWebhookEvent(event) {
  const WSOL = "So11111111111111111111111111111111111111112";
  const txType   = event.type || event.transactionType || "";
  const accounts = event.accountData || [];
  const transfers = event.tokenTransfers || [];
  const feePayer  = event.feePayer || "";

  const walletName = INSIDER_WALLETS[feePayer];
  if (!walletName) {
    const involved = accounts.map(a => a.account).filter(a => INSIDER_WALLETS[a]);
    if (!involved.length) return;
    for (const wallet of involved) {
      await processInsiderTransfers(wallet, INSIDER_WALLETS[wallet], transfers, WSOL);
    }
    return;
  }
  await processInsiderTransfers(feePayer, walletName, transfers, WSOL);
}

async function processInsiderTransfers(wallet, name, transfers, WSOL) {
  const bought = transfers.filter(t =>
    t.toUserAccount === wallet &&
    t.mint !== WSOL &&
    t.mint
  );
  for (const recv of bought) {
    if (!insiderBuys[recv.mint]) insiderBuys[recv.mint] = {};
    insiderBuys[recv.mint][name] = Date.now();
    log(`[Webhook] ⚡ REAL-TIME: ${name} bought ${recv.mint.slice(0,8)}`);
    await bot.sendMessage(CHAT_ID,
      `⚡ *Insider Buy Detected*\n` +
      `👛 ${name}\n` +
      `🪙 \`${recv.mint}\`\n` +
      `💰 Amount: ${recv.tokenAmount ? recv.tokenAmount.toLocaleString() : "N/A"}\n\n` +
      `_Bot will alert if this token qualifies in next scan_`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  }
  const sold = transfers.filter(t =>
    t.fromUserAccount === wallet &&
    t.mint !== WSOL &&
    t.mint
  );
  for (const send of sold) {
    log(`[Webhook] 📤 ${name} sold/sent ${send.mint.slice(0,8)}`);
    if (insiderBuys[send.mint]?.[name]) {
      delete insiderBuys[send.mint][name];
      log(`[Webhook] Removed ${name} buy for ${send.mint.slice(0,8)} (sold)`);
    }
  }
}

// ─── HELIUS DAS: KOL HOLDER VERIFICATION ─────────────────────────────────────
async function verifyKOLsStillHolding(tokenMint, expectedKolCount) {
  if (!HELIUS_API_KEY || expectedKolCount === 0) return { verified: false, stillHolding: 0, label: "" };
  try {
    const holdersData = await fetchOpenAPI("/v1/token/holders", {
      chain: "sol",
      address: tokenMint,
      limit: "50"
    });
    const holders = extractList(holdersData);
    if (!holders.length) return { verified: false, stillHolding: 0, label: "⚠️ Holders N/A" };

    const kolWallets = holders
      .filter(h => h.is_renowned || h.is_smart_degen || h.tag === "kol" || h.wallet_tag === "kol")
      .map(h => h.address || h.wallet)
      .filter(Boolean)
      .slice(0, 10);

    if (!kolWallets.length) return { verified: false, stillHolding: 0, label: "⚠️ KOL wallets not identified" };

    let stillHolding = 0;
    const walletsToCheck = kolWallets.slice(0, 5);
    for (const wallet of walletsToCheck) {
      try {
        const r = await axios.post(
          `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
          {
            jsonrpc: "2.0", id: "kol-bal",
            method: "getTokenAccountsByOwner",
            params: [wallet, { mint: tokenMint }, { encoding: "jsonParsed" }]
          },
          { timeout: 5000 }
        );
        const accounts = r.data?.result?.value || [];
        const balance = accounts.reduce((sum, a) =>
          sum + parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
        if (balance > 0) stillHolding++;
      } catch(e) {}
      await new Promise(r => setTimeout(r, 300));
    }

    const pct = walletsToCheck.length > 0 ? Math.round((stillHolding / walletsToCheck.length) * 100) : 0;
    let label;
    if (stillHolding === 0)           label = `⚠️ KOLs may have exited (0/${walletsToCheck.length} holding)`;
    else if (pct >= 80)               label = `✅ KOLs holding (${stillHolding}/${walletsToCheck.length} confirmed)`;
    else                              label = `🟡 KOLs partial (${stillHolding}/${walletsToCheck.length} still in)`;

    log(`[KOL Check] ${tokenMint.slice(0,8)}: ${stillHolding}/${walletsToCheck.length} KOLs still holding`);
    return { verified: true, stillHolding, total: walletsToCheck.length, label };
  } catch(e) {
    log(`[KOL Check] error: ${e.message}`);
    return { verified: false, stillHolding: 0, label: "" };
  }
}

function cleanupInsiderBuys() {
  const cutoff = Date.now() - 7200000;
  for (const [mint, buyers] of Object.entries(insiderBuys)) {
    for (const [k, ts] of Object.entries(buyers)) { if (ts < cutoff) delete insiderBuys[mint][k]; }
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

async function trackPerformance(mint,alertPrice,alertMC,symbol,alertMsgId,signalType,devWallet) {
  performanceTracker.set(mint,{alertPrice,alertMC,symbol,alertTime:Date.now(),alertMsgId,signalType,devWallet,peakX:1,notified2x:false,notified5x:false,notified10x:false,notifiedDistrib:false});
  const interval=setInterval(async()=>{
    const tracker=performanceTracker.get(mint);
    if (!tracker){clearInterval(interval);return;}
    if (Date.now()-tracker.alertTime>86400000) {
      const v=tracker.peakX>=10?"🌙 MOONSHOT":tracker.peakX>=5?"🔥 BANGER":tracker.peakX>=2?"✅ WIN":tracker.peakX>=1?"🟡 BREAKEVEN":"🔴 RUG";
      await bot.sendMessage(CHAT_ID,`📋 *24hr* $${symbol}\nPeak: ${tracker.peakX.toFixed(2)}x — ${v}`,{parse_mode:"Markdown"}).catch(()=>{});
      dbInsert("outcomes", {
        mint, symbol, signal_type:tracker.signalType,
        peak_x: tracker.peakX,
        result: v.replace(/[^a-zA-Z0-9 ]/g,"").trim(),
        alert_price: tracker.alertPrice,
        dev_wallet: tracker.devWallet || null,
      }).catch(()=>{});
      if (tracker.peakX >= 10 && tracker.devWallet) addTrustedDev(tracker.devWallet, tracker.peakX, symbol, mint).catch(()=>{});
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
    if (x>=10&&!tracker.notified10x){tracker.notified10x=true;stats.hits10x++;await bot.sendMessage(CHAT_ID,`🌙🌙🌙 *10x!* $${symbol} up *${x.toFixed(2)}x*!\n🏆 Take profit!`,{parse_mode:"Markdown",reply_to_message_id:alertMsgId}).catch(()=>{});
      if (tracker.devWallet) addTrustedDev(tracker.devWallet, x, symbol, mint).catch(()=>{});
    }
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

const SOL_LAUNCHPAD_PLATFORMS = [
  "Pump.fun","pump_mayhem","pump_mayhem_agent","pump_agent",
  "letsbonk","bonkers","bags",
  "memoo","liquid","bankr","zora","surge","anoncoin",
  "moonshot_app","wendotdev","heaven","sugar","token_mill",
  "believe","trendsfun","trends_fun","jup_studio","Moonshot",
  "boop","xstocks",
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

async function enrichToken(token) {
  try {
    const data = await fetchOpenAPI("/v1/token/security", {
      chain: "sol",
      address: token.address
    });
    if (!data?.data) return token;
    const s = data.data;
    return {
      ...token,
      top_10_holder_rate:   s.top_10_holder_rate   ?? token.top_10_holder_rate,
      burn_ratio:           s.burn_ratio            ?? 0,
      burn_status:          s.burn_status           ?? token.burn_status,
      is_honeypot:          s.is_honeypot           ?? false,
      open_source:          s.open_source           ?? token.open_source,
      is_blacklist:         s.is_blacklist          ?? false,
      dev_token_burn_ratio: s.dev_token_burn_ratio  ?? 0,
      rug_ratio:            token.rug_ratio         ?? 0,
      // v7.4 insider fields (from GMGN security endpoint)
      bundler_trader_amount_rate: s.bundler_trader_amount_rate ?? token.bundler_trader_amount_rate,
      rat_trader_amount_rate:     s.rat_trader_amount_rate     ?? token.rat_trader_amount_rate,
      sniper_count:               s.sniper_count               ?? token.sniper_count,
      is_wash_trading:            s.is_wash_trading            ?? token.is_wash_trading,
    };
  } catch(e) {
    log(`Enrich error for ${token.address?.slice(0,8)}: ${e.message}`);
    return token;
  }
}

// ─── KOL SIGNALS ─────────────────────────────────────────────────────────────
async function getKOLSignals() {
  const seen=new Set(), results=[];
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
  const sorted = results.sort((a,b)=>(b.smart_degen_count||0)-(a.smart_degen_count||0));
  const top = sorted.slice(0, 15);
  log(`Enriching ${top.length} KOL tokens with security data...`);
  const enriched = await Promise.all(top.map(t => enrichToken(t)));
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

// ─── KOL EARLY SIGNALS (v6) ───────────────────────────────────────────────────
async function getKOLEarlySignals() {
  const seen=new Set(), results=[];
  const body=buildTrenchesBody(["new_creation"]);
  const data=await fetchOpenAPI("/v1/trenches",{chain:"sol",body},"POST");
  if (data) processKOLEarlyList(data?.data?.new_creation||[],seen,results);
  if (results.length===0) {
    const pub=await fetchPublic(`https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/5m?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`);
    const list=pub?.data?.rank||pub?.data?.token_list||[];
    if (Array.isArray(list)&&list.length>0) processKOLEarlyList(list,seen,results);
  }
  return results.sort((a,b)=>{
    const kolDiff=(b.renowned_count||0)-(a.renowned_count||0);
    if (kolDiff!==0) return kolDiff;
    return (b.smart_degen_count||0)-(a.smart_degen_count||0);
  }).slice(0,5);
}

function processKOLEarlyList(list, seen, results) {
  for (const t of list) {
    if (!t.address||seen.has(t.address)||globalAlerted.has(t.address)) continue;
    seen.add(t.address);
    const ageMs   = t.created_timestamp?(Date.now()-t.created_timestamp*1000)
                  : t.open_timestamp?(Date.now()-t.open_timestamp*1000):null;
    if (!ageMs||ageMs>KOLE_MAX_AGE_MS) continue;
    const mc       = t.usd_market_cap||t.market_cap||0;
    const kol      = t.renowned_count||0;
    const rug      = t.rug_ratio||0;
    const bundle   = t.bundler_trader_amount_rate||0;
    const wash     = t.is_wash_trading||false;
    const honeypot = t.is_honeypot||false;
    const top10    = t.top_10_holder_rate||0;
    const volume   = t.volume_1h||t.volume_24h||t.volume||0;
    const buys     = t.buys_24h||t.buys||0;
    const sells    = t.sells_24h||t.sells||0;
    const buyRatio = sells>0?buys/sells:buys>0?buys:0;
    const progress = t.launchpad_status?.bonding_curve_percentage||t.progress||0;
    if (
      kol      >= KOLE_MIN_RENOWNED &&
      mc       <= KOLE_MAX_MC       &&
      mc       >  0                 &&
      rug      <  KOLE_MAX_RUG      &&
      bundle   <  KOLE_MAX_BUNDLE   &&
      top10    <  0.6               &&
      !wash                         &&
      !honeypot
    ) results.push({...t,alertType:"KOL_EARLY",_ageMs:ageMs,progress,buys,sells,buyRatio,market_cap:mc,volume});
  }
}

// ─── STABLE GEM SIGNAL (v7) ───────────────────────────────────────────────────
async function fetchStableGemCandidates() {
  const url = `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/24h?orderby=marketcap&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=100`;
  try {
    const data = await fetchPublic(url);
    const list = data?.data?.rank || [];
    if (!list.length) {
      log("[StableGem] Public failed — trying OpenAPI");
      const apiData = await fetchOpenAPI("/v1/market/rank", {
        chain:"sol", interval:"24h", orderby:"marketcap", direction:"desc", limit:"100"
      });
      return extractList(apiData);
    }
    return list;
  } catch(e) {
    log(`[StableGem] fetchCandidates error: ${e.message}`);
    return [];
  }
}

async function fetchTokenKlineVolatility(address) {
  try {
    const to   = Math.floor(Date.now() / 1000);
    const from = to - (6 * 4 * 3600);
    const url  = `https://gmgn.ai/defi/quotation/v1/tokens/kline/sol/${address}?resolution=4h&from=${from}&to=${to}`;
    const data = await fetchPublic(url);
    const candles = data?.data?.list || data?.data?.ohlcv || data?.data || [];
    if (!Array.isArray(candles) || candles.length < 3) return null;
    const highs = candles.map(c => parseFloat(c.high || c[2] || 0));
    const lows  = candles.map(c => parseFloat(c.low  || c[3] || 0));
    const overallHigh = Math.max(...highs);
    const overallLow  = Math.min(...lows.filter(l => l > 0));
    if (!overallLow || overallLow === 0) return null;
    return (overallHigh - overallLow) / overallLow;
  } catch(e) {
    log(`[StableGem] kline error ${address?.slice(0,8)}: ${e.message}`);
    return null;
  }
}

async function runStableGemScan() {
  log("[StableGem] Scanning...");
  try {
    const allCandidates = await fetchStableGemCandidates();
    const filtered = allCandidates.filter(t => {
      const mc         = t.market_cap || t.usd_market_cap || 0;
      const vol        = t.volume || t.volume_24h || 0;
      const holders    = t.holder_count || 0;
      const priceChg   = t.price_change_percent24h ?? t.price_change_percent1h ?? null;
      const wash       = t.is_wash_trading || false;
      const honeypot   = t.is_honeypot || false;
      const frozen      = t.is_freeze_authority || t.freeze_authority || t.token_frozen || false;
      const blacklisted = t.is_blacklist || t.blacklist || false;
      if (frozen || blacklisted) return false;
      if (mc < STABLE_GEM_MC_MIN || mc > STABLE_GEM_MC_MAX) return false;
      if (vol < STABLE_GEM_VOLUME_MIN)   return false;
      if (holders < STABLE_GEM_HOLDER_MIN) return false;
      if (wash || honeypot)              return false;
      const tokenAgeMs = t.open_timestamp ? (Date.now() - t.open_timestamp * 1000) : null;
      if (tokenAgeMs && tokenAgeMs > STABLE_GEM_MAX_AGE_DAYS * 86400000) return false;
      const recentVol = t.volume_1h || t.volume_5m || 0;
      if (recentVol === 0) return false;
      if (priceChg !== null) {
        if (priceChg < STABLE_GEM_PRICE_CHANGE_MIN) return false;
        if (priceChg > STABLE_GEM_PRICE_CHANGE_MAX) return false;
      }
      if (stableGemAlerted.has(t.address) &&
          Date.now() - stableGemAlerted.get(t.address) < STABLE_GEM_COOLDOWN_MS) return false;
      return true;
    });

    log(`[StableGem] ${filtered.length} candidates after MC/vol filter`);
    if (!filtered.length) return;

    const gems = [];
    for (const token of filtered.slice(0, 25)) {
      await new Promise(r => setTimeout(r, 2000));
      const volatility = await fetchTokenKlineVolatility(token.address);
      if (volatility === null) continue;
      if (volatility > STABLE_GEM_VOLATILITY_MAX) continue;
      const buyVol  = token.buy_volume_24h  || token.buy_volume  || 0;
      const sellVol = token.sell_volume_24h || token.sell_volume || 0;
      const buySellRatio = sellVol > 0 ? buyVol / sellVol : buyVol > 0 ? 2 : null;
      if (!buySellRatio || buySellRatio < STABLE_GEM_BUY_RATIO_MIN) continue;
      gems.push({ token, volatility, buySellRatio });
      log(`[StableGem] ✅ ${token.symbol} MC:${fmt(token.market_cap)} vol:${(volatility*100).toFixed(1)}%`);
    }

    gems.sort((a, b) => a.volatility - b.volatility);

    for (const { token, volatility, buySellRatio } of gems.slice(0, 2)) {
      stableGemAlerted.set(token.address, Date.now());
      await sendStableGemAlert(token, volatility, buySellRatio);
      await new Promise(r => setTimeout(r, 1500));
    }

    const now = Date.now();
    for (const [k, ts] of stableGemAlerted.entries()) {
      if (now - ts > STABLE_GEM_COOLDOWN_MS) stableGemAlerted.delete(k);
    }
  } catch(e) {
    log(`[StableGem] scan error: ${e.message}`);
  }
}

async function sendStableGemAlert(token, volatility, buySellRatio) {
  const mint    = token.address;
  const sym     = token.symbol || "???";
  const mc      = token.market_cap || token.usd_market_cap || 0;
  const vol     = token.volume || token.volume_24h || 0;
  const holders = token.holder_count || 0;
  const priceChg = token.price_change_percent24h ?? token.price_change_percent1h ?? null;
  const stability = Math.round((1 - volatility) * 100);
  const bsLabel   = buySellRatio ? buySellRatio.toFixed(2) : "N/A";
  const chgStr    = priceChg !== null ? `${priceChg > 0 ? "+" : ""}${priceChg.toFixed(1)}%` : "N/A";
  const smart     = token.smart_degen_count || 0;
  const kol       = token.renowned_count || 0;

  let tierLabel;
  if (volatility <= 0.10)      tierLabel = "🧊 ULTRA STABLE";
  else if (volatility <= 0.20) tierLabel = "💎 VERY STABLE";
  else                          tierLabel = "📊 STABLE";

  const creator = token.creator || token.creator_address || "";
  let trustedBadge = "";
  let devQualityStr = "";
  if (creator) {
    if (trustedDevs.has(creator)) {
      const info = trustedDevs.get(creator);
      trustedBadge = `🌟 *TRUSTED 10x DEV* (made ${(info.best_x||0).toFixed(1)}x before!)\n`;
    }
    const devQ = await fetchDevWalletQuality(creator).catch(() => null);
    if (devQ) devQualityStr = `\n└ 🧑‍💻 ${fmtDevQuality(devQ)}`;
  }

  const dexUrl  = `https://dexscreener.com/solana/${mint}`;
  const gmgnUrl = `https://gmgn.ai/sol/token/${mint}`;

  const msg =
    `📊 *STABLE GEM* — ${tierLabel}\n` +
    `${trustedBadge}` +
    `\n*$${sym}*\n\`${mint}\`\n` +
    `└ ⏱ ${fmtAge(token.open_timestamp ? token.open_timestamp*1000 : null)} | 👁 ${holders.toLocaleString()} holders\n\n` +
    `💰 *Metrics*\n` +
    `├ MC:         ${fmt(mc)}\n` +
    `├ Vol 24h:    ${fmt(vol)}\n` +
    `├ 24h Change: ${chgStr}\n` +
    `├ B/S Ratio:  ${bsLabel}\n` +
    `├ Smart $:    ${smart} 🤖 | KOL: ${kol} 👑\n` +
    `└ Rug:        ${((token.rug_ratio||0)*100).toFixed(0)}%\n\n` +
    `🧘 *Stability*\n` +
    `├ Score:  ${stability}% stable\n` +
    `└ Range:  ±${(volatility*100).toFixed(1)}% over 24h (4h candles)\n\n` +
    `🌐 ${getSocials(token)}${devQualityStr}\n\n` +
    `[DexScreener](${dexUrl}) • [GMGN](${gmgnUrl})\n\n` +
    `💡 *Accumulation zone — watch for KOL entry or volume spike*`;

  const keyboard = {
    inline_keyboard: [
      [{text:"🚀 BUY via Trojan", url:`https://t.me/solana_trojanbot?start=ca_${mint}`}],
      [{text:"📊 DexScreener", url:`https://dexscreener.com/solana/${mint}`}, {text:"🔍 GMGN", url:`https://gmgn.ai/sol/token/${mint}`}],
      [{text:"⚡ Axiom", url:`https://axiom.trade/t/${mint}`}, {text:"📈 Stats", callback_data:"stats"}],
      [{text:"❌ Skip", callback_data:`skip_${mint.slice(0,20)}`}],
    ]
  };

  const sent = await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });

  if (token.price) {
    await trackPerformance(mint, parseFloat(token.price), mc, sym, sent.message_id, "stableGem", creator);
  }

  botStats.stableGem.alerts++;
  log(`[StableGem] Alert: $${sym} MC:${fmt(mc)} stability:${stability}% range:${(volatility*100).toFixed(1)}%`);

  dbInsert("signals", {
    mint,
    symbol: sym,
    signal_type: "STABLE_GEM",
    alert_price: token.price ? parseFloat(token.price) : null,
    alert_mc: mc || null,
    smart_degen_count: smart,
    rug_ratio: token.rug_ratio || 0,
    ai_decision: "APPROVED",
    ai_confidence: stability,
    has_socials: !!(token.twitter||token.telegram||token.website),
    dev_wallet: creator || null,
  }).catch(()=>{});
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

// ─── INSIDER ANALYSIS (v7.4) ─────────────────────────────────────────────────
// Surfaces the GMGN insider/manipulation fields we already fetch but never showed.
// Confirmed field names from GMGNAI/gmgn-skills repo:
//   bundler_trader_amount_rate — % volume from bot-bundled launch buys
//   rat_trader_amount_rate     — % volume from insider/sneak wallets
//   sniper_count               — wallets that bought at exact launch moment
//   is_wash_trading            — coordinated fake volume flag
// GMGN's official manipulation threshold: any rate > 0.30 = high risk.
function getInsiderAnalysis(token) {
  const bundler = token.bundler_trader_amount_rate ?? token.bundler_rate ?? null;
  const rat     = token.rat_trader_amount_rate ?? null;
  const snipers = token.sniper_count ?? null;
  const wash    = token.is_wash_trading || false;
  const top10   = token.top_10_holder_rate ?? null;

  // Build a risk score from the available signals (GMGN threshold: >0.3 = high)
  let riskPoints = 0;
  const lines = [];

  if (bundler !== null) {
    const pct = (bundler * 100).toFixed(0);
    const flag = bundler > 0.3 ? "🔴" : bundler > 0.15 ? "🟡" : "🟢";
    lines.push(`├ Bundlers: ${pct}% ${flag}`);
    if (bundler > 0.3) riskPoints += 2; else if (bundler > 0.15) riskPoints += 1;
  }
  if (rat !== null) {
    const pct = (rat * 100).toFixed(0);
    const flag = rat > 0.3 ? "🔴" : rat > 0.15 ? "🟡" : "🟢";
    lines.push(`├ Insider/rat: ${pct}% ${flag}`);
    if (rat > 0.3) riskPoints += 2; else if (rat > 0.15) riskPoints += 1;
  }
  if (snipers !== null) {
    const flag = snipers > 15 ? "🔴" : snipers > 5 ? "🟡" : "🟢";
    lines.push(`├ Snipers: ${snipers} wallets ${flag}`);
    if (snipers > 15) riskPoints += 2; else if (snipers > 5) riskPoints += 1;
  }
  if (top10 !== null) {
    const pct = (top10 * 100).toFixed(0);
    const flag = top10 > 0.4 ? "🔴" : top10 > 0.25 ? "🟡" : "🟢";
    lines.push(`├ Top 10 hold: ${pct}% ${flag}`);
    if (top10 > 0.4) riskPoints += 2; else if (top10 > 0.25) riskPoints += 1;
  }
  if (wash) { lines.push(`├ ⚠️ Wash trading detected`); riskPoints += 3; }

  // If GMGN gave us none of these fields, say so honestly rather than fake a score
  if (lines.length === 0) return "🕵️ Insider data: N/A (check Bubblemaps)";

  // Overall risk label
  let riskLabel;
  if (riskPoints >= 5)      riskLabel = "🔴 HIGH insider risk";
  else if (riskPoints >= 2) riskLabel = "🟡 MEDIUM insider risk";
  else                       riskLabel = "🟢 LOW insider risk";

  // Replace last line's ├ with └ for clean formatting
  lines[lines.length-1] = lines[lines.length-1].replace("├", "└");

  return `🕵️ *Insider Analysis* — ${riskLabel}\n${lines.join("\n")}`;
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
  const devQualityStr = token._devQuality ? `\n└ 🧑‍💻 ${fmtDevQuality(token._devQuality)}` : "";
  const trustedBadge = token._isTrustedDev ? `🌟 *TRUSTED 10x DEV* (made ${(token._trustedDevInfo?.best_x||0).toFixed(1)}x before!)\n` : "";
  const kolCheck = await verifyKOLsStillHolding(mint, token.renowned_count||0);
  const kolHoldStr = kolCheck.label ? `\n└ ${kolCheck.label}` : '';
  const msg=
    `${isReentry?"🔄 *RE-ENTRY SIGNAL*":"🚨 *KOL SIGNAL*"} — ${signalLabel(score)}\n`+
    `${trustedBadge}`+
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
    `├ KOL Holders: ${token.renowned_count||0} 👑${kolHoldStr}\n`+
    `└ Netflow: ${netflow}${insiderStr}\n\n`+
    `🔒 *Security*\n`+
    `├ Dev: ${devStatus} | Mint: ${token.renounced_mint===1?"🟢 Yes":"🔴 No"}\n`+
    `├ Rug: ${((token.rug_ratio||0)*100).toFixed(0)}%\n`+
    `├ 📢 DEX: ${getDexPromo(token)}\n`+
    `└ 🌐 ${getSocials(token)}${devQualityStr}\n\n`+
    `${getInsiderAnalysis(token)}\n\n`+
    `💰 *Snipe 0.1 SOL?*`;
  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,false)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"kol",token.creator||token.creator_address||"");
  botStats.kol.alerts++;
  log(`KOL: $${sym} score:${score} smart:${token.smart_degen_count||0} kol:${token.renowned_count||0}`);
  dbInsert("signals", {
    mint, symbol:sym, signal_type:"KOL",
    alert_price: token.price ? parseFloat(token.price) : null,
    alert_mc: token.market_cap || null,
    smart_degen_count: token.smart_degen_count || 0,
    rug_ratio: token.rug_ratio || 0,
    ai_decision: ai.decision,
    ai_confidence: ai.confidence || 0,
    has_socials: !!(token.twitter||token.telegram||token.website),
    dev_wallet: token.creator || token.creator_address || null,
  }).catch(()=>{});
}

async function sendPumpAlert(token,ai) {
  const mint=token.address, sym=token.symbol||"???";
  const progress=token.progress||0;
  const bar="█".repeat(Math.floor(progress/10))+"░".repeat(10-Math.floor(progress/10));
  const urgency=progress>=90?"🔴 MIGRATING SOON":progress>=75?"🟡 FILLING FAST":"🟢 EARLY";
  const riskEmoji=ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";
  const devQualityStr = token._devQuality ? `🧑‍💻 ${fmtDevQuality(token._devQuality)}\n` : "";
  const trustedBadge = token._isTrustedDev ? `🌟 *TRUSTED 10x DEV* (made ${(token._trustedDevInfo?.best_x||0).toFixed(1)}x before!)\n` : "";
  const msg=
    `🎯 *PUMPFUN PRE-BOND* — ${urgency}\n`+
    `${trustedBadge}`+
    `AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%\n\n`+
    `*$${sym}*\n\`${mint}\`\n`+
    `└ ⏱ ${fmtAge(token.open_timestamp?token.open_timestamp*1000:null)} | 👁 ${token.holder_count||"N/A"} holders\n\n`+
    `🏦 *Bonding Curve*\n[${bar}] ${progress.toFixed(1)}%\n\n`+
    `📊 Price: ${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"} | MC: ${fmt(token.market_cap||0)}\n`+
    `Vol: ${fmt(token.volume||0)} | Smart: ${token.smart_degen_count||0} 🤖 | KOL: ${token.renowned_count||0} 👑\n`+
    `📢 DEX: ${getDexPromo(token)}\n`+
    `🌐 ${getSocials(token)}\n`+
    `${devQualityStr}`+
    `${getInsiderAnalysis(token)}\n\n`+
    `⚡ Buy before Raydium migration!\n💰 *Snipe 0.1 SOL?*`;
  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,true)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"pump",token.creator||token.creator_address||"");
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
    dev_wallet: token.creator || token.creator_address || null,
  }).catch(()=>{});
}

async function sendUltraAlert(token,ai) {
  const mint=token.address, sym=token.symbol||"???";
  const ageMin=Math.floor((token._ageMs||token.ageMs||0)/60000);
  const progress=token.progress||0;
  const bar="█".repeat(Math.floor(progress/10))+"░".repeat(10-Math.floor(progress/10));
  const momentum=token.buyRatio>=10?"🔥🔥🔥 INSANE":token.buyRatio>=5?"🔥🔥 VERY HIGH":"🔥 HIGH";
  const riskEmoji=ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";
  const devQualityStr = token._devQuality ? `🧑‍💻 ${fmtDevQuality(token._devQuality)}\n` : "";
  const trustedBadge = token._isTrustedDev ? `🌟 *TRUSTED 10x DEV* (made ${(token._trustedDevInfo?.best_x||0).toFixed(1)}x before!)\n` : "";
  const msg=
    `🚀 *ULTRA EARLY LAUNCH* — ${momentum}\n`+
    `${trustedBadge}`+
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
    `🌐 ${getSocials(token)}\n`+
    `${devQualityStr}`+
    `${getInsiderAnalysis(token)}\n\n`+
    `💰 *Snipe 0.1 SOL?* — Always DYOR`;
  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,true)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"ultra",token.creator||token.creator_address||"");
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
    dev_wallet: token.creator || token.creator_address || null,
  }).catch(()=>{});
}

async function sendKOLEarlyAlert(token,ai) {
  const mint=token.address, sym=token.symbol||"???";
  const ageMin=Math.floor((token._ageMs||0)/60000);
  const kol=token.renowned_count||0;
  const smart=token.smart_degen_count||0;
  const riskEmoji=ai.risk==="LOW"?"🟢":ai.risk==="MEDIUM"?"🟡":"🔴";
  const trustedBadge = token._isTrustedDev ? `🌟 *TRUSTED 10x DEV* (made ${(token._trustedDevInfo?.best_x||0).toFixed(1)}x before!)\n` : "";
  const kolCheck = await verifyKOLsStillHolding(mint, token.renowned_count||0);
  const kolHoldStr = kolCheck.label ? `\n└ ${kolCheck.label}` : '';
  const devQualityStr = token._devQuality ? `🧑‍💻 ${fmtDevQuality(token._devQuality)}\n` : "";
  const msg=
    `👑 *KOL EARLY ENTRY* — ${kol} KOLs IN EARLY!\n`+
    `${trustedBadge}`+
    `AI: ${riskEmoji} ${ai.risk} ${ai.confidence}%\n`+
    `${token._copycatWarning?token._copycatWarning+"\n":""}\n`+
    `*$${sym}*\n\`${mint}\`\n`+
    `└ ⏱ ${ageMin}m old | 👁 ${token.holder_count||"N/A"} holders\n\n`+
    `🔥 *Why this matters*\n`+
    `├ ${kol} KOL buyers 👑 (2+ = strong)${kolHoldStr}\n`+
    `├ ${smart} smart money 🤖\n`+
    `└ Caught EARLY at low MC\n\n`+
    `📊 *Token Details*\n`+
    `├ Price: ${token.price?`$${parseFloat(token.price).toExponential(4)}`:"N/A"}\n`+
    `├ MC:    ${fmt(token.market_cap||0)}\n`+
    `├ Vol:   ${fmt(token.volume||0)}\n`+
    `└ Rug:   ${((token.rug_ratio||0)*100).toFixed(0)}%\n\n`+
    `🌐 ${getSocials(token)}\n`+
    `${devQualityStr}`+
    `${getInsiderAnalysis(token)}\n\n`+
    `💰 *Snipe early — higher risk, higher reward*`;
  const sent=await bot.sendMessage(CHAT_ID,msg,{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:buildKeyboard(mint,true)});
  if (token.price) await trackPerformance(mint,parseFloat(token.price),token.market_cap||0,sym,sent.message_id,"kolEarly",token.creator||token.creator_address||"");
  botStats.kolEarly.alerts++;
  log(`KOL EARLY: $${sym} kol:${kol} smart:${smart} mc:${fmt(token.market_cap||0)}`);
  dbInsert("signals", {
    mint, symbol:sym, signal_type:"KOL_EARLY",
    alert_price: token.price ? parseFloat(token.price) : null,
    alert_mc: token.market_cap || null,
    smart_degen_count: token.smart_degen_count || 0,
    rug_ratio: token.rug_ratio || 0,
    ai_decision: ai.decision,
    ai_confidence: ai.confidence || 0,
    has_socials: !!(token.twitter||token.telegram||token.website),
    dev_wallet: token.creator || token.creator_address || null,
  }).catch(()=>{});
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scan() {
  log("Scanning...");
  cleanupInsiderBuys();
  const [kolTokens,pumpTokens,ultraTokens,kolEarlyTokens]=await Promise.all([
    getKOLSignals(), getPumpSignals(), getUltraSignals(), getKOLEarlySignals()
  ]);
  log(`KOL:${kolTokens.length} Pump:${pumpTokens.length} Ultra:${ultraTokens.length} KOLEarly:${kolEarlyTokens.length}`);

  const allTokens=[
    ...kolEarlyTokens.map(t=>({...t,_type:"kolEarly"})),
    ...ultraTokens.map(t=>({...t,_type:"ultra"})),
    ...kolTokens.map(t=>({...t,_type:"kol"})),
    ...pumpTokens.map(t=>({...t,_type:"pump"})),
  ];

  const filtered=allTokens.filter(t=>t._type==="ultra"||t._type==="pump"||t._type==="kolEarly"||hardFilter(t));
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

    const creator = token.creator || token.creator_address || "";
    if (creator && blacklistedCreators.has(creator)) { log(`Blocked blacklisted creator: ${creator.slice(0,8)}`); continue; }
    if (creator) {
      await fetchCreatorProfile(creator);
      if (blacklistedCreators.has(creator)) { log(`Blocked after check: ${creator.slice(0,8)}`); continue; }
      token._devQuality = await fetchDevWalletQuality(creator);
      token._devBestATH = token._devQuality.bestATH || 0;
      if (trustedDevs.has(creator)) {
        token._isTrustedDev = true;
        token._trustedDevInfo = trustedDevs.get(creator);
      }
    }

    const copycats = await checkCopycat(token.name||"", token.symbol||"", mint);
    if (copycats > 0) token._copycatWarning = `⚠️ ${copycats+1} tokens named $${token.symbol||"?"}`;

    token._score = calcFinalScore(token, token._ai.confidence, Object.keys(insiderBuys[mint]||{}).length);

    globalAlerted.add(mint);alerted.set(mint,Date.now());
    try {
      if (token._type==="kolEarly") await sendKOLEarlyAlert(token,token._ai);
      else if (token._type==="ultra") await sendUltraAlert(token,token._ai);
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
  log("⚡ Apex v7.4 — insider analysis panel added");
  try { const r=await axios.get("https://api.ipify.org?format=json",{timeout:5000}); log(`Railway IP: ${r.data.ip}`); } catch(e){}
  log(`GMGN_API_KEY: ${GMGN_API_KEY?"SET":"MISSING"}`);
  log(`OPENROUTER_KEY: ${OPENROUTER_KEY?"SET":"MISSING"}`);

  await loadTrustedDevs();

  await bot.sendMessage(CHAT_ID,
    `⚡ *Apex v7.4 Online*\n\n`+
    `🔧 NEW: Stricter KOL filter (v12 elite values)\n`+
    `  • Holders ≥40, Liq ≥$7K, Rug <18%\n`+
    `  • Bundle <25%, Smart ≥1, Top10 <35%\n`+
    `  • Anti-farm: blocks fake holder counts\n`+
    `  → Cuts breakeven flood, raises quality\n`+
    `🕵️ NEW: Insider Analysis panel (bundlers, snipers, rat traders)\n\n`+
    `📡 All platforms: Pump.fun + letsbonk + bonkers + more\n`+
    `🎯 5 Signals: KOL + Pump + Ultra + 👑 KOL Early + 📊 Stable Gem\n`+
    `📊 Stable Gem — $500K–$1M MC, stable 24h+\n`+
    `👑 KOL Early — 2+ KOLs in fresh tokens <$100K\n`+
    `🤖 AI: OpenRouter Llama 3.3 70B (200/day)\n`+
    `🌐 Social warnings on all alerts\n`+
    `💾 Supabase signal tracking enabled\n`+
    `👤 Creator rug rate check\n`+
    `🧑‍💻 Dev wallet ATH quality check\n`+
    `🌟 Auto-track 10x devs (priority alerts)\n`+
    `🔍 Copycat detection\n`+
    `👛 6 Insider wallets (webhook real-time)\n`+
    `📊 2x/5x/10x milestone alerts\n\n`+
    `Main scan: every 60s | Stable Gem: every 10min 🔥`,
    {parse_mode:"Markdown"}
  );

  startWebhookServer();

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);

  setTimeout(() => {
    runStableGemScan();
    setInterval(runStableGemScan, STABLE_GEM_INTERVAL_MS);
  }, 30000);
}

main().catch(e=>{log(`Fatal: ${e.message}`);process.exit(1);});
