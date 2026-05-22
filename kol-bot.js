const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const https = require("https");
const dns   = require("dns");

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
dns.setDefaultResultOrder("ipv4first");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const GMGN_API_KEY   = process.env.GMGN_API_KEY || "gmgn_solbscbaseethmonadtron";

// ─── SETTINGS (v11/v12 exact settings) ───────────────────────────────────────
const MC_MIN             = 15000;
const MC_MAX             = 150000;
const POLL_INTERVAL_MS   = 60000;  // 60s — 6 requests per scan, safe for Cloudflare
const ALERT_COOLDOWN_MS  = 3600000;
const MAX_TOKEN_AGE_MS   = 24 * 60 * 60 * 1000;
const REENTRY_MIN_VOLUME = 50000;
const PUMP_MIN_VOLUME    = 20000;
const PUMP_MIN_PROGRESS  = 60;
const PUMP_MAX_PROGRESS  = 98;
const PUMP_MIN_HOLDERS   = 100;
const ULTRA_MAX_AGE_MS   = 30 * 60 * 1000;
const ULTRA_MIN_VOLUME   = 3000;
const ULTRA_MIN_HOLDERS  = 30;
const ULTRA_MIN_BUY_RATIO = 2;
const CLAUDE_DAILY_LIMIT = 50;

// ─── STATE ────────────────────────────────────────────────────────────────────
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

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function fmt(n) {
  if (!n && n !== 0) return "N/A";
  if (n >= 1000000) return `$${(n/1000000).toFixed(2)}M`;
  if (n >= 1000)    return `$${(n/1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtAge(ts) {
  if (!ts) return "N/A";
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60)    return `${secs}s`;
  if (secs < 3600)  return `${Math.floor(secs/60)}m`;
  if (secs < 86400) return `${Math.floor(secs/3600)}h`;
  return `${Math.floor(secs/86400)}d`;
}

function getVelocity(token) {
  const vol5m = token.volume_5m || 0;
  const vol1h = token.volume    || 0;
  return parseFloat((vol1h > 0 ? (vol5m * 12) / vol1h : 0).toFixed(2));
}

function velocityLabel(v) {
  if (v >= 2.0) return "🔥 EXPLOSIVE";
  if (v >= 1.0) return "✅ STABLE";
  if (v <  0.5) return "💀 DYING";
  return "🟡 MODERATE";
}

// ─── HARD FILTER (before Claude) ─────────────────────────────────────────────
function hardFilter(token) {
  const holders = token.holder_count || 0;
  const liq     = token.liquidity    || 0;
  const rug     = token.rug_ratio    || 1;
  const bundle  = token.bundler_trader_amount_rate || 1;
  const smart   = token.smart_degen_count || 0;
  const top10   = token.top_10_holder_rate || 0;
  if (holders < 30)          return false;
  if (liq < 5000)            return false;
  if (rug > 0.25)            return false;
  if (bundle > 0.40)         return false;
  if (smart === 0)           return false;
  if (top10 > 0.40)          return false;
  if (blacklist.has(token.creator || "")) return false;
  return true;
}

// ─── FINAL SCORE ─────────────────────────────────────────────────────────────
function calcFinalScore(token, aiConfidence, insiderCount) {
  let s = 0;
  const smart  = token.smart_degen_count || 0;
  const kol    = token.renowned_count    || 0;
  const rug    = token.rug_ratio         || 1;
  const liq    = token.liquidity         || 0;
  const buys   = token.buy_5m || token.swaps_5m || 0;
  const sells  = token.sell_5m || 0;

  if (smart >= 3) s += 3; else if (smart >= 1) s += 2;
  if (kol   >= 2) s += 2; else if (kol   >= 1) s += 1;
  if (liq > 15000) s += 2;
  if (buys > sells * 1.5) s += 2;
  if (token.creator_token_status === "hold") s += 1;
  if (token.renounced_mint === 1) s += 1;
  if (token.is_wash_trading)  s -= 3;
  if (rug > 0.20)             s -= 3;
  if ((token.bundler_trader_amount_rate || 0) > 0.25) s -= 2;
  if ((token.holder_count || 0) < 50) s -= 2;
  if (liq < 8000) s -= 2;
  if (token.creator_token_status === "sell") s -= 2;
  s += Math.floor((aiConfidence || 50) / 20);
  if (getVelocity(token) >= 1.5) s += 1;
  s += insiderCount;
  return s;
}

function signalLabel(score) {
  if (score >= 12) return "🔥 ULTRA HIGH";
  if (score >= 8)  return "⚡ HIGH";
  if (score >= 5)  return "✅ MEDIUM";
  return "🟡 LOW";
}

// ─── CALLBACK HANDLERS ───────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  try {
    if (query.data?.startsWith("skip_")) {
      await bot.answerCallbackQuery(query.id, { text: "Skipped!" });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: "Skipped", callback_data: "done" }]] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
    }
    if (query.data === "stats") {
      await bot.answerCallbackQuery(query.id);
      const s = botStats;
      await bot.sendMessage(CHAT_ID,
        `📊 *Bot Performance Stats*\n\n` +
        `🚨 KOL Signals\nAlerts: ${s.kol.alerts} | 2x: ${s.kol.hits2x} | 5x: ${s.kol.hits5x} | 10x: ${s.kol.hits10x}\nWin Rate: ${s.kol.alerts > 0 ? ((s.kol.hits2x/s.kol.alerts)*100).toFixed(0) : 0}%\n\n` +
        `🎯 PumpFun Pre-Bond\nAlerts: ${s.pump.alerts} | 2x: ${s.pump.hits2x} | 5x: ${s.pump.hits5x} | 10x: ${s.pump.hits10x}\nWin Rate: ${s.pump.alerts > 0 ? ((s.pump.hits2x/s.pump.alerts)*100).toFixed(0) : 0}%\n\n` +
        `🚀 Ultra Early\nAlerts: ${s.ultra.alerts} | 2x: ${s.ultra.hits2x} | 5x: ${s.ultra.hits5x} | 10x: ${s.ultra.hits10x}\nWin Rate: ${s.ultra.alerts > 0 ? ((s.ultra.hits2x/s.ultra.alerts)*100).toFixed(0) : 0}%\n\n` +
        `🤖 Claude calls today: ${claudeCallsToday}/${CLAUDE_DAILY_LIMIT}\n` +
        `Tracking: ${performanceTracker.size} tokens`,
        { parse_mode: "Markdown" }
      );
    }
  } catch(e) {}
});

// ─── CLAUDE AI FILTER ────────────────────────────────────────────────────────
async function claudeFilter(token) {
  // Reset daily counter
  if (Date.now() > claudeResetTime) {
    claudeCallsToday = 0;
    claudeResetTime = Date.now() + 86400000;
  }

  // Check cache (30 min)
  const cached = claudeCache.get(token.address);
  if (cached && Date.now() - cached.ts < 1800000) return cached.result;

  const rug   = token.rug_ratio || 0;
  const smart = token.smart_degen_count || 0;
  const liq   = token.liquidity || 0;

  // Hard reject without Claude
  if (rug > 0.5)            return { decision: "REJECT", reason: "Rug >50%",        risk: "VERY HIGH", confidence: 99 };
  if (liq < 3000)           return { decision: "REJECT", reason: "Liq too low",     risk: "VERY HIGH", confidence: 99 };
  if (token.is_wash_trading) return { decision: "REJECT", reason: "Wash trading",   risk: "VERY HIGH", confidence: 99 };

  // Auto-approve strong signals (saves Claude credits)
  if (smart >= 3 && rug < 0.1) {
    const result = { decision: "APPROVE", reason: "Strong smart money", risk: "LOW", confidence: 92 };
    claudeCache.set(token.address, { result, ts: Date.now() });
    return result;
  }

  // Daily limit check
  if (!CLAUDE_API_KEY || claudeCallsToday >= CLAUDE_DAILY_LIMIT) {
    return { decision: "APPROVE", reason: "AI limit reached", risk: "MEDIUM", confidence: 50 };
  }

  try {
    claudeCallsToday++;
    const prompt = `Solana memecoin filter. Be LENIENT. Only reject clear rugs/scams.
${token.symbol} MC:$${token.market_cap} Liq:$${liq} Vol:$${token.volume}
Smart:${smart} KOL:${token.renowned_count||0} Rug:${(rug*100).toFixed(0)}%
Holders:${token.holder_count||0} Bundle:${((token.bundler_trader_amount_rate||0)*100).toFixed(0)}%
REJECT only: rug>40% OR bundle>50% OR no liq+dev sold.
APPROVE if any smart/KOL interest + reasonable liq.
JSON only: {"decision":"APPROVE","reason":"brief","risk":"LOW/MEDIUM/HIGH","confidence":75}`;

    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 80, messages: [{ role: "user", content: prompt }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 10000 }
    );
    const text = res.data?.content?.[0]?.text || "";
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());
    claudeCache.set(token.address, { result, ts: Date.now() });
    log(`Claude: $${token.symbol} -> ${result.decision} | ${result.reason} | ${result.confidence}%`);
    return result;
  } catch(e) {
    log(`Claude error: ${e.response?.status} ${e.message}`);
    return { decision: "APPROVE", reason: "AI unavailable", risk: "MEDIUM", confidence: 50 };
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
  for (const [wallet, name] of Object.entries(INSIDER_WALLETS)) {
    try {
      const res = await axios.get(
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=5&type=SWAP`,
        { timeout: 8000 }
      );
      const txs = res.data || [];
      if (!txs.length) continue;
      const newTxs = lastSig[wallet] ? txs.filter(t => t.signature !== lastSig[wallet]) : txs.slice(0, 2);
      if (newTxs.length) lastSig[wallet] = txs[0].signature;
      for (const tx of newTxs) {
        const WSOL = "So11111111111111111111111111111111111111112";
        const recv = (tx.tokenTransfers||[]).find(t => t.toUserAccount===wallet && t.mint!==WSOL);
        if (!recv?.mint) continue;
        const mint = recv.mint;
        if (!insiderBuys[mint]) insiderBuys[mint] = {};
        insiderBuys[mint][name] = Date.now();
        log(`👛 Insider ${name} bought ${mint.slice(0,8)}...`);
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  const cutoff = Date.now() - 7200000;
  for (const [mint, buyers] of Object.entries(insiderBuys)) {
    for (const [k, ts] of Object.entries(buyers)) { if (ts < cutoff) delete insiderBuys[mint][k]; }
    if (!Object.keys(insiderBuys[mint]).length) delete insiderBuys[mint];
  }
}

// ─── PERFORMANCE TRACKER (milestone only) ────────────────────────────────────
async function getTokenPrice(mint) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 8000 });
    const pairs = (res.data?.pairs || []).filter(p => p.chainId === "solana");
    if (!pairs.length) return null;
    pairs.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0));
    return {
      price:     parseFloat(pairs[0].priceUsd || 0),
      mc:        pairs[0].fdv || 0,
      liquidity: pairs[0].liquidity?.usd || 0,
      sells:     pairs[0].txns?.h1?.sells || 0,
      buys:      pairs[0].txns?.h1?.buys  || 0,
    };
  } catch(e) { return null; }
}

async function trackPerformance(mint, alertPrice, alertMC, symbol, alertMsgId, signalType) {
  performanceTracker.set(mint, {
    alertPrice, alertMC, symbol,
    alertTime: Date.now(), alertMsgId, signalType,
    peakX: 1, notified2x: false, notified5x: false, notified10x: false,
    notifiedDistrib: false,
  });

  const interval = setInterval(async () => {
    const tracker = performanceTracker.get(mint);
    if (!tracker) { clearInterval(interval); return; }

    // 24hr final report
    if (Date.now() - tracker.alertTime > 86400000) {
      const verdict =
        tracker.peakX >= 10 ? "🌙 MOONSHOT" :
        tracker.peakX >=  5 ? "🔥 BANGER"   :
        tracker.peakX >=  2 ? "✅ WIN"       :
        tracker.peakX >=  1 ? "🟡 BREAKEVEN" : "🔴 RUG";
      await bot.sendMessage(CHAT_ID,
        `📋 *24hr Final Report*\n\n*$${symbol}*\n├ Peak: *${tracker.peakX.toFixed(2)}x*\n└ Verdict: ${verdict}`,
        { parse_mode: "Markdown" }
      ).catch(()=>{});
      performanceTracker.delete(mint);
      clearInterval(interval);
      return;
    }

    const current = await getTokenPrice(mint);
    if (!current?.price || !alertPrice) return;
    const xGain = current.price / alertPrice;
    if (xGain > tracker.peakX) tracker.peakX = xGain;
    const stats = botStats[signalType] || botStats.kol;

    // Distribution warning
    if (current.sells > current.buys * 2 && xGain > 1.5 && !tracker.notifiedDistrib) {
      tracker.notifiedDistrib = true;
      await bot.sendMessage(CHAT_ID,
        `⚠️ *DISTRIBUTION DETECTED*\n\n*$${symbol}* — large sell pressure!\nCurrent: ${xGain.toFixed(2)}x\n\n🚨 Consider exiting!`,
        { parse_mode: "Markdown", reply_to_message_id: alertMsgId }
      ).catch(()=>{});
    }

    if (xGain >= 10 && !tracker.notified10x) {
      tracker.notified10x = true; stats.hits10x++;
      await bot.sendMessage(CHAT_ID,
        `🌙🌙🌙 *10x MILESTONE!* 🌙🌙🌙\n\n*$${symbol}* up *${xGain.toFixed(2)}x*!\n├ MC: ${fmt(current.mc)}\n└ Liq: ${fmt(current.liquidity)}\n\n🏆 Take significant profit!`,
        { parse_mode: "Markdown", reply_to_message_id: alertMsgId }
      ).catch(()=>{});
    } else if (xGain >= 5 && !tracker.notified5x) {
      tracker.notified5x = true; stats.hits5x++;
      await bot.sendMessage(CHAT_ID,
        `🚀🚀 *5x MILESTONE!* 🚀🚀\n\n*$${symbol}* up *${xGain.toFixed(2)}x*!\n├ MC: ${fmt(current.mc)}\n└ Liq: ${fmt(current.liquidity)}\n\n🔥 Consider 25-50% profit!`,
        { parse_mode: "Markdown", reply_to_message_id: alertMsgId }
      ).catch(()=>{});
    } else if (xGain >= 2 && !tracker.notified2x) {
      tracker.notified2x = true; stats.hits2x++;
      await bot.sendMessage(CHAT_ID,
        `✅ *2x MILESTONE!* ✅\n\n*$${symbol}* up *${xGain.toFixed(2)}x*!\n├ MC: ${fmt(current.mc)}\n└ Liq: ${fmt(current.liquidity)}\n\n💰 Consider 25% profit!`,
        { parse_mode: "Markdown", reply_to_message_id: alertMsgId }
      ).catch(()=>{});
    }

    // Liquidity warning
    if (current.liquidity < 2000 && tracker.peakX > 1.5) {
      await bot.sendMessage(CHAT_ID,
        `⚠️ *LIQ WARNING!* ⚠️\n\n*$${symbol}* liquidity dropping!\nLiq: ${fmt(current.liquidity)}\n\n🚨 Exit now!`,
        { parse_mode: "Markdown", reply_to_message_id: alertMsgId }
      ).catch(()=>{});
      performanceTracker.delete(mint);
      clearInterval(interval);
    }
  }, 3 * 60 * 1000);
}

// ─── GMGN RATE LIMITER ───────────────────────────────────────────────────────
// GMGN allows 20 req/sec but Cloudflare blocks aggressive cloud IPs
// We use 1 req/2sec = 30/min — well under limit, avoids CF detection
const GMGN_GAP_MS    = 2000;  // 1 request every 2 seconds
let   gmgnBlocked    = false;
let   gmgnBlockUntil = 0;

const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });
const axiosGMGN = axios.create({
  httpsAgent: ipv4Agent,
  timeout: 20000,
  maxRedirects: 2,
  validateStatus: () => true,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept":     "application/json",
    "Referer":    "https://gmgn.ai/",
    "Origin":     "https://gmgn.ai",
  },
});

async function fetchGMGN(path) {
  // If blocked, skip until block expires
  if (gmgnBlocked && Date.now() < gmgnBlockUntil) {
    log(`GMGN blocked — skipping (${Math.round((gmgnBlockUntil - Date.now())/1000)}s remaining)`);
    return null;
  }
  gmgnBlocked = false;

  // Enforce gap between requests
  const now  = Date.now();
  const wait = GMGN_GAP_MS - (now - lastGMGNCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGMGNCall = Date.now();

  try {
    const url = `https://openapi.gmgn.ai${path}${path.includes("?") ? "&" : "?"}api_key=${GMGN_API_KEY}`;
    const res = await axiosGMGN.get(url, { headers: { "x-api-key": GMGN_API_KEY } });

    if (res.status === 429) {
      log("GMGN 429 — rate limited, backing off 60s");
      gmgnBlocked    = true;
      gmgnBlockUntil = Date.now() + 60000;
      return null;
    }
    if (res.status === 403) {
      log("GMGN 403 — Cloudflare block, backing off 5 mins");
      gmgnBlocked    = true;
      gmgnBlockUntil = Date.now() + 300000;
      return null;
    }
    if (res.status === 404) {
      log(`GMGN 404 — endpoint not found: ${path.slice(0,50)}`);
      return null;
    }
    if (res.status !== 200) {
      log(`GMGN ${res.status}: ${path.slice(0,40)}`);
      return null;
    }
    if (typeof res.data === "string") {
      log("GMGN returned HTML — likely Cloudflare page");
      gmgnBlocked    = true;
      gmgnBlockUntil = Date.now() + 120000;
      return null;
    }
    return res.data;
  } catch(e) {
    log(`GMGN error: ${e.message}`);
    return null;
  }
}

// Sequential GMGN fetcher — never fires requests in parallel
async function fetchGMGNSequential(paths) {
  const results = [];
  for (const path of paths) {
    const data = await fetchGMGN(path);
    results.push(data);
  }
  return results;
}

// ─── KOL SIGNALS ─────────────────────────────────────────────────────────────
async function getKOLSignals() {
  const paths = [
    `/defi/quotation/v1/rank/sol/swaps/1h?orderby=smart_degen_count&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=100`,
    `/defi/quotation/v1/rank/sol/swaps/1h?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
  ];
  const responses = await fetchGMGNSequential(paths);
  const seen = new Set(); const results = [];
  for (const data of responses) {
    if (!data) continue;
    const tokens = data?.data?.rank || [];
    for (const t of tokens) {
      if (!t.address || seen.has(t.address) || globalAlerted.has(t.address)) continue;
      seen.add(t.address);
      const mc       = t.market_cap || 0;
      const tokenAge = t.open_timestamp ? (Date.now() - t.open_timestamp * 1000) : null;
      const isNew    = tokenAge !== null && tokenAge <= MAX_TOKEN_AGE_MS;
      const isReentry = !isNew && (t.volume||0) >= REENTRY_MIN_VOLUME && (t.smart_degen_count||0) >= 2;
      if (
        mc >= MC_MIN && mc <= MC_MAX &&
        (t.smart_degen_count||0) >= 1 &&
        (t.renowned_count||0)    >= 1 &&
        (isNew || isReentry) &&
        !blacklist.has(t.creator || "")
      ) {
        results.push({ ...t, alertType: isReentry ? "REENTRY" : "KOL", tokenAge });
      }
    }
  }
  results.sort((a,b) => (b.smart_degen_count||0) - (a.smart_degen_count||0));
  return results;
}

// ─── PUMPFUN PRE-BOND ─────────────────────────────────────────────────────────
async function getPumpSignals() {
  const paths = [
    `/defi/quotation/v1/rank/sol/pump?orderby=volume&direction=desc&filters[]=not_honeypot&limit=100`,
    `/defi/quotation/v1/rank/sol/pump?orderby=smart_degen_count&direction=desc&filters[]=not_honeypot&limit=100`,
  ];
  const responses = await fetchGMGNSequential(paths);
  const seen = new Set(); const results = [];
  for (const data of responses) {
    if (!data) continue;
    const tokens = data?.data?.rank || [];
    for (const t of tokens) {
      if (!t.address || seen.has(t.address) || globalAlerted.has(t.address)) continue;
      seen.add(t.address);
      const progress = t.launchpad_status?.bonding_curve_percentage || t.progress || 0;
      const volume   = t.volume || 0;
      const holders  = t.holder_count || t.holders || 0;
      if (
        progress >= PUMP_MIN_PROGRESS && progress <= PUMP_MAX_PROGRESS &&
        volume >= PUMP_MIN_VOLUME &&
        holders >= PUMP_MIN_HOLDERS &&
        (t.rug_ratio||0) < 0.3 &&
        !t.is_wash_trading &&
        !blacklist.has(t.creator || "")
      ) {
        results.push({ ...t, alertType: "PUMP", progress });
      }
    }
  }
  results.sort((a,b) => (b.volume||0) - (a.volume||0));
  return results.slice(0, 10);
}

// ─── ULTRA EARLY ─────────────────────────────────────────────────────────────
async function getUltraSignals() {
  const paths = [
    `/defi/quotation/v1/rank/sol/pump?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
    `/defi/quotation/v1/rank/sol/swaps/5m?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
  ];
  const responses = await fetchGMGNSequential(paths);
  const seen = new Set(); const results = [];
  for (const data of responses) {
    if (!data) continue;
    const tokens = data?.data?.rank || [];
    for (const t of tokens) {
      if (!t.address || seen.has(t.address) || globalAlerted.has(t.address)) continue;
      seen.add(t.address);
      const ageMs    = t.open_timestamp ? Date.now() - t.open_timestamp * 1000 : null;
      if (!ageMs || ageMs > ULTRA_MAX_AGE_MS) continue;
      const progress = t.launchpad_status?.bonding_curve_percentage || t.progress || 0;
      const volume   = t.volume || t.volume_5m || 0;
      const holders  = t.holder_count || t.holders || 0;
      const buys     = t.buy_5m || t.swaps_5m || 0;
      const sells    = t.sell_5m || 0;
      const buyRatio = sells > 0 ? buys/sells : buys;
      if (
        progress >= 3 && progress <= 60 &&
        volume >= ULTRA_MIN_VOLUME &&
        holders >= ULTRA_MIN_HOLDERS &&
        buyRatio >= ULTRA_MIN_BUY_RATIO &&
        (t.rug_ratio||0) < 0.2 &&
        !t.is_wash_trading &&
        !blacklist.has(t.creator || "")
      ) {
        results.push({ ...t, alertType: "ULTRA_EARLY", ageMs, progress, buys, sells, buyRatio });
      }
    }
  }
  results.sort((a,b) => b.buyRatio - a.buyRatio);
  return results.slice(0, 5);
}

// ─── BUILD KEYBOARD ───────────────────────────────────────────────────────────
function buildKeyboard(mint, isPump) {
  return {
    inline_keyboard: [
      [{ text: "🚀 BUY 0.1 SOL via Trojan", url: `https://t.me/solana_trojanbot?start=ca_${mint}` }],
      [
        { text: "📊 DexScreener", url: `https://dexscreener.com/solana/${mint}` },
        { text: "🔍 GMGN",        url: `https://gmgn.ai/sol/token/${mint}`      },
      ],
      [
        { text: isPump ? "🎯 PumpFun" : "⚡ Axiom",
          url:  isPump ? `https://pump.fun/${mint}` : `https://axiom.trade/t/${mint}` },
        { text: "📈 Stats", callback_data: "stats" },
      ],
      [{ text: "❌ Skip", callback_data: `skip_${mint.slice(0,20)}` }],
    ],
  };
}

// ─── SEND KOL ALERT ───────────────────────────────────────────────────────────
async function sendKOLAlert(token, aiResult) {
  const mint      = token.address;
  const symbol    = token.symbol    || "???";
  const mc        = token.market_cap || 0;
  const age       = fmtAge(token.open_timestamp ? token.open_timestamp*1000 : null);
  const holders   = token.holder_count || "N/A";
  const price     = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const vol       = fmt(token.volume    || 0);
  const liq       = fmt(token.liquidity || 0);
  const change1h  = token.price_change_percent1h || 0;
  const vel       = getVelocity(token);
  const velLabel  = velocityLabel(vel);
  const insiders  = Object.keys(insiderBuys[mint] || {});
  const insiderCount = insiders.length;
  const insiderBoost = insiderCount >= 3 ? " 🔥 CONVERGENCE" : insiderCount >= 2 ? " ⚡ Multi-insider" : "";
  const finalScore = calcFinalScore(token, aiResult.confidence, insiderCount);
  const label     = signalLabel(finalScore);
  const isReentry = token.alertType === "REENTRY";
  const riskEmoji = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";
  const devStatus = token.creator_token_status === "sell" ? "🔴 Sold" : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";
  const mintR     = token.renounced_mint === 1 ? "🟢 Yes" : "🔴 No";
  const rugPct    = `${((token.rug_ratio||0)*100).toFixed(0)}%`;
  const netflow   = (token.buy_5m||0) > (token.sell_5m||0) ? "🟢 Accumulating" : "🔴 Selling";
  const insiderStr = insiders.length > 0 ? `\n└ 👛 ${insiders.join(", ")}${insiderBoost}` : "";

  const msg =
    `🚨 *${isReentry ? "RE-ENTRY" : "KOL"} SIGNAL* — ${label}\n` +
    `Score: ${finalScore} | AI: ${riskEmoji} ${aiResult.risk} ${aiResult.confidence}%\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n` +
    `└ ⏱ ${age} | 👁 ${holders} holders\n\n` +
    `📊 *Token Details*\n` +
    `├ PRICE:    ${price}\n` +
    `├ MC:       ${fmt(mc)}\n` +
    `├ Vol 1h:   ${vol}\n` +
    `├ Liq:      ${liq}\n` +
    `├ 1h Chg:   ${change1h > 0 ? "+" : ""}${change1h.toFixed(1)}%\n` +
    `└ Velocity: ${vel}x ${velLabel}\n\n` +
    `🧠 *Smart Signals*\n` +
    `├ Smart Money: ${token.smart_degen_count||0} 🤖\n` +
    `├ KOL Holders: ${token.renowned_count||0} 👑\n` +
    `├ Netflow: ${netflow}${insiderStr}\n\n` +
    `🔒 *Security*\n` +
    `├ Dev:       ${devStatus}\n` +
    `├ Mint Rncd: ${mintR}\n` +
    `└ Rug:       ${rugPct}\n\n` +
    `💰 *Snipe 0.1 SOL?*`;

  const sent = await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: buildKeyboard(mint, false),
  });
  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) await trackPerformance(mint, alertPrice, mc, symbol, sent.message_id, "kol");
  botStats.kol.alerts++;
  log(`KOL: $${symbol} Score:${finalScore} Smart:${token.smart_degen_count||0} KOL:${token.renowned_count||0}`);
}

// ─── SEND PUMP ALERT ──────────────────────────────────────────────────────────
async function sendPumpAlert(token, aiResult) {
  const mint        = token.address;
  const symbol      = token.symbol || "???";
  const progress    = token.progress || 0;
  const progressBar = "█".repeat(Math.floor(progress/10)) + "░".repeat(10-Math.floor(progress/10));
  const holders     = token.holder_count || token.holders || "N/A";
  const vol         = fmt(token.volume || 0);
  const mc          = fmt(token.market_cap || 0);
  const price       = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const age         = fmtAge(token.open_timestamp ? token.open_timestamp*1000 : null);
  const urgency     = progress >= 90 ? "🔴 MIGRATING SOON" : progress >= 75 ? "🟡 FILLING FAST" : "🟢 EARLY";
  const riskEmoji   = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";

  const msg =
    `🎯 *PUMPFUN PRE-BOND* — ${urgency}\n` +
    `AI: ${riskEmoji} ${aiResult.risk} ${aiResult.confidence}%\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n` +
    `└ ⏱ ${age} | 👁 ${holders} holders\n\n` +
    `🏦 *Bonding Curve*\n` +
    `[${progressBar}] ${progress.toFixed(1)}%\n\n` +
    `📊 *Token Details*\n` +
    `├ PRICE: ${price}\n` +
    `├ MC:    ${mc}\n` +
    `└ Vol:   ${vol}\n\n` +
    `🧠 Smart: ${token.smart_degen_count||0} 🤖 | KOL: ${token.renowned_count||0} 👑\n\n` +
    `⚡ Buy before Raydium migration!\n` +
    `💰 *Snipe 0.1 SOL?*`;

  const sent = await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: buildKeyboard(mint, true),
  });
  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) await trackPerformance(mint, alertPrice, token.market_cap||0, symbol, sent.message_id, "pump");
  botStats.pump.alerts++;
  log(`Pump: $${symbol} ${progress.toFixed(0)}% Vol:${vol}`);
}

// ─── SEND ULTRA ALERT ─────────────────────────────────────────────────────────
async function sendUltraAlert(token, aiResult) {
  const mint      = token.address;
  const symbol    = token.symbol || "???";
  const ageMin    = Math.floor((token.ageMs||0)/60000);
  const progress  = token.progress || 0;
  const progressBar = "█".repeat(Math.floor(progress/10)) + "░".repeat(10-Math.floor(progress/10));
  const holders   = token.holder_count || token.holders || "N/A";
  const vol5m     = fmt(token.volume || token.volume_5m || 0);
  const mc        = token.market_cap || 0;
  const price     = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const buys      = token.buys  || 0;
  const sells     = token.sells || 0;
  const buyRatio  = token.buyRatio ? token.buyRatio.toFixed(1) : "N/A";
  const vel       = getVelocity(token);
  const momentum  = token.buyRatio >= 10 ? "🔥🔥🔥 INSANE" : token.buyRatio >= 5 ? "🔥🔥 VERY HIGH" : "🔥 HIGH";
  const riskEmoji = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";
  const devStatus = token.creator_token_status === "sell" ? "🔴 Sold" : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";

  const msg =
    `🚀 *ULTRA EARLY LAUNCH* — ${momentum}\n` +
    `AI: ${riskEmoji} ${aiResult.risk} ${aiResult.confidence}%\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n` +
    `└ ⏱ ${ageMin}m | 👁 ${holders} holders\n\n` +
    `📈 *Bonding Curve*\n` +
    `[${progressBar}] ${progress.toFixed(1)}%\n\n` +
    `⚡ *Momentum (5min)*\n` +
    `├ Vol:     ${vol5m}\n` +
    `├ Buys:    ${buys} | Sells: ${sells}\n` +
    `├ B/S:     ${buyRatio}:1\n` +
    `└ Vel:     ${vel}x\n\n` +
    `📊 *Token*\n` +
    `├ Price: ${price}\n` +
    `├ MC:    ${fmt(mc)}\n` +
    `└ Dev:   ${devStatus}\n\n` +
    `💰 *Snipe 0.1 SOL?*\nAlways DYOR`;

  const sent = await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: buildKeyboard(mint, true),
  });
  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) await trackPerformance(mint, alertPrice, mc, symbol, sent.message_id, "ultra");
  botStats.ultra.alerts++;
  log(`Ultra: $${symbol} Age:${ageMin}m Curve:${progress.toFixed(0)}% B/S:${buyRatio}`);
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scan() {
  log("Scanning...");
  pollInsiderWallets().catch(()=>{});

  // Run sequentially — never parallel GMGN calls
  const kolTokens   = await getKOLSignals();
  const pumpTokens  = await getPumpSignals();
  const ultraTokens = await getUltraSignals();
  log(`KOL: ${kolTokens.length} | Pump: ${pumpTokens.length} | Ultra: ${ultraTokens.length}`);

  // Combine all tokens
  const allTokens = [
    ...ultraTokens.map(t => ({ ...t, _type: "ultra" })),
    ...kolTokens.map(t =>   ({ ...t, _type: "kol"   })),
    ...pumpTokens.map(t =>  ({ ...t, _type: "pump"  })),
  ];

  // Hard filter (KOL only — pump/ultra have their own filters)
  const filtered = allTokens.filter(t =>
    t._type === "ultra" || t._type === "pump" || hardFilter(t)
  );

  // Run Claude in parallel
  const aiResults = await Promise.all(filtered.map(t => claudeFilter(t)));

  // Score + sort
  const scored = filtered
    .map((t, i) => {
      const insiderCount = Object.keys(insiderBuys[t.address] || {}).length;
      return { ...t, _ai: aiResults[i], _score: calcFinalScore(t, aiResults[i].confidence, insiderCount) };
    })
    .filter((t, i) => aiResults[i]?.decision !== "REJECT")
    .sort((a,b) => b._score - a._score);

  // Send top 3 per scan
  let sent = 0;
  for (const token of scored) {
    if (sent >= 3) break;
    const mint = token.address;
    if (globalAlerted.has(mint)) continue;
    const lastAlert = alerted.get(mint);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;

    globalAlerted.add(mint);
    alerted.set(mint, Date.now());

    try {
      if (token._type === "ultra") await sendUltraAlert(token, token._ai);
      else if (token._type === "pump") await sendPumpAlert(token, token._ai);
      else await sendKOLAlert(token, token._ai);
      sent++;
    } catch(e) { log(`Alert error: ${e.message}`); }
    await new Promise(r => setTimeout(r, 3000));
  }

  // Memory cleanup
  if (globalAlerted.size > 500) {
    [...globalAlerted].slice(0, 100).forEach(m => globalAlerted.delete(m));
  }
  const now = Date.now();
  for (const [k, v] of claudeCache.entries()) {
    if (now - v.ts > 1800000) claudeCache.delete(k);
  }
  for (const [k, ts] of alerted.entries()) {
    if (now - ts > ALERT_COOLDOWN_MS) alerted.delete(k);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("KOL Tracker v12 Final — Elite Signal Engine");

  await bot.sendMessage(CHAT_ID,
    `🟢 *KOL Tracker v12 Final Online*\n\n` +
    `🏆 Elite Signal Engine\n\n` +
    `📡 *3 Signal Types:*\n` +
    `├ 🚨 KOL Signal — smart money + KOL overlap\n` +
    `├ ♻️ Re-Entry — vol spike on known tokens\n` +
    `├ 🎯 PumpFun Pre-Bond — 60-98% curve\n` +
    `└ 🚀 Ultra Early — under 30 mins\n\n` +
    `🔒 *Filters:*\n` +
    `├ MC: $15K–$150K\n` +
    `├ Hard filter before Claude\n` +
    `├ Claude Haiku (max 50/day)\n` +
    `├ Strong signals auto-approved\n` +
    `└ TOP 3 per scan\n\n` +
    `📊 *Tracking:*\n` +
    `├ 2x/5x/10x milestones\n` +
    `├ Distribution warnings\n` +
    `├ Liquidity warnings\n` +
    `└ 24hr final report\n\n` +
    `Scan every 20s 🚀`,
    { parse_mode: "Markdown" }
  );

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
