const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const GMGN_API_KEY = process.env.GMGN_API_KEY;

// ─── FILTERS ─────────────────────────────────────────────────────────────────
const MC_MIN = 15000;
const MC_MAX = 150000;
const POLL_INTERVAL_MS = 45000;
const ALERT_COOLDOWN_MS = 3600000;
const CLAUDE_DAILY_LIMIT = 50;

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const alerted = new Map();
const claudeCache = new Map();
const performanceTracker = new Map();
const insiderBuys = {};
const lastSig = {};
const blacklist = new Set();
let claudeCallCount = 0;
let lastGMGNCall = 0;

const botStats = {
  kol:   { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
  pump:  { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
  ultra: { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
};

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
      const kolWR  = s.kol.alerts  > 0 ? ((s.kol.hits2x  / s.kol.alerts)  * 100).toFixed(0) : 0;
      const pumpWR = s.pump.alerts > 0 ? ((s.pump.hits2x / s.pump.alerts) * 100).toFixed(0) : 0;
      const ultraWR= s.ultra.alerts> 0 ? ((s.ultra.hits2x/ s.ultra.alerts)* 100).toFixed(0) : 0;
      await bot.sendMessage(CHAT_ID,
        `📊 *Bot Performance Stats*\n\n` +
        `🚨 KOL Signals\n` +
        `Alerts: ${s.kol.alerts} | 2x: ${s.kol.hits2x} | 5x: ${s.kol.hits5x} | 10x: ${s.kol.hits10x}\n` +
        `Win Rate: ${kolWR}%\n\n` +
        `🎯 PumpFun Pre-Bond\n` +
        `Alerts: ${s.pump.alerts} | 2x: ${s.pump.hits2x} | 5x: ${s.pump.hits5x} | 10x: ${s.pump.hits10x}\n` +
        `Win Rate: ${pumpWR}%\n\n` +
        `🚀 Ultra Early\n` +
        `Alerts: ${s.ultra.alerts} | 2x: ${s.ultra.hits2x} | 5x: ${s.ultra.hits5x} | 10x: ${s.ultra.hits10x}\n` +
        `Win Rate: ${ultraWR}%\n\n` +
        `Blacklisted: ${blacklist.size} | Tracking: ${performanceTracker.size}`,
        { parse_mode: "Markdown" }
      );
    }
  } catch(e) {}
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function fmt(n) {
  if (!n && n !== 0) return "N/A";
  if (n >= 1000000) return `$${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000)    return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtAge(ts) {
  if (!ts) return "N/A";
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60)    return `${secs}s`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
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

function signalScore(token) {
  let s = 0;
  const smart = token.smart_degen_count || 0;
  const kol   = token.renowned_count    || 0;
  const rug   = token.rug_ratio         || 0;
  if (smart >= 3) s += 3; else if (smart >= 2) s += 2; else if (smart >= 1) s += 1;
  if (kol   >= 2) s += 2; else if (kol   >= 1) s += 1;
  if (rug < 0.1)  s += 2; else if (rug < 0.2)  s += 1;
  if (token.renounced_mint             === 1) s += 1;
  if (token.renounced_freeze_account   === 1) s += 1;
  if (!token.is_wash_trading)                 s += 1;
  return s;
}

function signalLabel(score) {
  if (score >= 8) return "🔥 ULTRA HIGH";
  if (score >= 6) return "⚡ HIGH";
  if (score >= 4) return "✅ MEDIUM";
  return "🟡 LOW";
}

// ─── GMGN API FETCH (IPv4 forced, 1 req/sec) ─────────────────────────────────
async function fetchGMGN(path, retries = 2) {
  // Enforce 1 second gap between requests
  const now = Date.now();
  const wait = 1100 - (now - lastGMGNCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGMGNCall = Date.now();

  const url = `https://gmgn.ai${path}`;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, {
        headers: {
          "x-api-key": GMGN_API_KEY || "",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Referer": "https://gmgn.ai/",
        },
        timeout: 12000,
        // Force IPv4
        family: 4,
      });
      return res.data;
    } catch(e) {
      const status = e.response?.status;
      if (status === 429) {
        log(`GMGN rate limit — waiting ${(i + 1) * 5}s`);
        await new Promise(r => setTimeout(r, (i + 1) * 5000));
      } else if (status === 403) {
        log(`GMGN 403 — check API key or IPv6`);
        return null;
      } else {
        log(`GMGN fetch error: ${e.message}`);
        return null;
      }
    }
  }
  return null;
}

// ─── CLAUDE AI FILTER ─────────────────────────────────────────────────────────
async function claudeFilter(token) {
  const cached = claudeCache.get(token.address);
  if (cached && Date.now() - cached.ts < 7200000) return cached.result;

  const rug    = token.rug_ratio                  || 0;
  const smart  = token.smart_degen_count          || 0;
  const liq    = token.liquidity                  || 0;
  const bundle = token.bundler_trader_amount_rate || 0;

  // Hard reject without Claude
  if (rug    > 0.5)              return { decision: "REJECT", reason: "Rug >50%",      risk: "VERY HIGH", confidence: 99 };
  if (liq    < 3000)             return { decision: "REJECT", reason: "Liq too low",   risk: "VERY HIGH", confidence: 99 };
  if (token.is_wash_trading)     return { decision: "REJECT", reason: "Wash trading",  risk: "VERY HIGH", confidence: 99 };
  if (bundle > 0.5)              return { decision: "REJECT", reason: "Bundle >50%",   risk: "VERY HIGH", confidence: 99 };
  if (blacklist.has(token.creator || "")) return { decision: "REJECT", reason: "Blacklisted deployer", risk: "VERY HIGH", confidence: 99 };

  // Auto approve strong signals — saves credits
  if (smart >= 3 && rug < 0.1 && liq > 10000) {
    const result = { decision: "APPROVE", reason: "Strong smart money", risk: "LOW", confidence: 90 };
    claudeCache.set(token.address, { result, ts: Date.now() });
    return result;
  }
  if (smart >= 1 && rug < 0.15 && liq > 7000) {
    const result = { decision: "APPROVE", reason: "Good signal", risk: "MEDIUM", confidence: 72 };
    claudeCache.set(token.address, { result, ts: Date.now() });
    return result;
  }

  // Skip Claude if no key or limit reached
  if (!CLAUDE_API_KEY || claudeCallCount >= CLAUDE_DAILY_LIMIT) {
    return { decision: "APPROVE", reason: "Auto approved", risk: "MEDIUM", confidence: 60 };
  }

  try {
    claudeCallCount++;
    const prompt = `Solana memecoin. APPROVE unless clear scam.
${token.symbol} Liq:$${liq} Rug:${(rug * 100).toFixed(0)}% Bundle:${(bundle * 100).toFixed(0)}%
Smart:${smart} Holders:${token.holder_count || 0}
REJECT only: rug>40% or bundle>50%. JSON: {"decision":"APPROVE","reason":"ok","risk":"MEDIUM","confidence":70}`;

    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 60, messages: [{ role: "user", content: prompt }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 8000 }
    );
    const text = res.data?.content?.[0]?.text || "";
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());
    claudeCache.set(token.address, { result, ts: Date.now() });
    log(`Claude [${claudeCallCount}/${CLAUDE_DAILY_LIMIT}]: ${token.symbol} -> ${result.decision}`);
    return result;
  } catch(e) {
    return { decision: "APPROVE", reason: "AI unavailable", risk: "MEDIUM", confidence: 50 };
  }
}

setInterval(() => { claudeCallCount = 0; log("Claude counter reset"); }, 24 * 60 * 60 * 1000);

// ─── INSIDER WALLETS ──────────────────────────────────────────────────────────
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
      const newTxs = lastSig[wallet]
        ? txs.filter(t => t.signature !== lastSig[wallet])
        : txs.slice(0, 2);
      if (newTxs.length) lastSig[wallet] = txs[0].signature;
      for (const tx of newTxs) {
        const WSOL = "So11111111111111111111111111111111111111112";
        const recv = (tx.tokenTransfers || []).find(t => t.toUserAccount === wallet && t.mint !== WSOL);
        if (!recv?.mint) continue;
        if (!insiderBuys[recv.mint]) insiderBuys[recv.mint] = {};
        insiderBuys[recv.mint][name] = Date.now();
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  // Cleanup entries older than 2 hours
  const cutoff = Date.now() - 7200000;
  for (const [mint, buyers] of Object.entries(insiderBuys)) {
    for (const [k, ts] of Object.entries(buyers)) {
      if (ts < cutoff) delete insiderBuys[mint][k];
    }
    if (!Object.keys(insiderBuys[mint]).length) delete insiderBuys[mint];
  }
}

// ─── PERFORMANCE TRACKER ─────────────────────────────────────────────────────
async function getTokenPrice(mint) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 8000 });
    const pairs = (res.data?.pairs || []).filter(p => p.chainId === "solana");
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
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
    notifiedDistribution: false,
  });
  const stats = botStats[signalType] || botStats.kol;

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
      ).catch(() => {});
      performanceTracker.delete(mint);
      clearInterval(interval);
      return;
    }

    const current = await getTokenPrice(mint);
    if (!current?.price || !alertPrice) return;
    const xGain = current.price / alertPrice;
    if (xGain > tracker.peakX) tracker.peakX = xGain;

    // Distribution warning
    if (current.sells > current.buys * 2 && xGain > 1.5 && !tracker.notifiedDistribution) {
      tracker.notifiedDistribution = true;
      await bot.sendMessage(CHAT_ID,
        `⚠️ *DISTRIBUTION DETECTED*\n\n*$${symbol}* — Large sell pressure!\nCurrent: ${xGain.toFixed(2)}x\nConsider exiting!`,
        { parse_mode: "Markdown", reply_to_message_id: alertMsgId }
      ).catch(() => {});
    }

    // Milestones
    if (xGain >= 10 && !tracker.notified10x) {
      tracker.notified10x = true; stats.hits10x++;
      await bot.sendMessage(CHAT_ID,
        `🌙🌙🌙 *10x MILESTONE!* 🌙🌙🌙\n\n*$${symbol}* is up *${xGain.toFixed(2)}x*!\n\n├ Alert MC: ${fmt(alertMC)}\n├ Current MC: ${fmt(current.mc)}\n└ Liquidity: ${fmt(current.liquidity)}\n\n🏆 MOONSHOT CONFIRMED!\nTake significant profit!`,
        { parse_mode: "Markdown", reply_to_message_id: alertMsgId }
      ).catch(() => {});
    } else if (xGain >= 5 && !tracker.notified5x) {
      tracker.notified5x = true; stats.hits5x++;
      await bot.sendMessage(CHAT_ID,
        `🚀🚀 *5x MILESTONE!* 🚀🚀\n\n*$${symbol}* is up *${xGain.toFixed(2)}x*!\n\n├ Alert MC: ${fmt(alertMC)}\n├ Current MC: ${fmt(current.mc)}\n└ Liquidity: ${fmt(current.liquidity)}\n\n🔥 BANGER! Consider 25-50% profit!`,
        { parse_mode: "Markdown", reply_to_message_id: alertMsgId }
      ).catch(() => {});
    } else if (xGain >= 2 && !tracker.notified2x) {
      tracker.notified2x = true; stats.hits2x++;
      await bot.sendMessage(CHAT_ID,
        `✅ *2x MILESTONE!* ✅\n\n*$${symbol}* is up *${xGain.toFixed(2)}x*!\n\n├ Alert MC: ${fmt(alertMC)}\n├ Current MC: ${fmt(current.mc)}\n└ Liquidity: ${fmt(current.liquidity)}\n\n💰 Consider taking 25% profit!\nLet the rest ride 🎯`,
        { parse_mode: "Markdown", reply_to_message_id: alertMsgId }
      ).catch(() => {});
    }

    // Liquidity warning
    if (current.liquidity < 2000 && tracker.peakX > 1.5) {
      await bot.sendMessage(CHAT_ID,
        `⚠️ *LIQUIDITY WARNING!* ⚠️\n\n*$${symbol}* liq dropping!\n└ Liq: ${fmt(current.liquidity)}\n\n🚨 Exit now!`,
        { parse_mode: "Markdown", reply_to_message_id: alertMsgId }
      ).catch(() => {});
      performanceTracker.delete(mint);
      clearInterval(interval);
    }
  }, 3 * 60 * 1000);
}

// ─── SCANNER: GMGN TRENCHES (new token discovery) ────────────────────────────
async function getTrenchesSignals() {
  const results = [];
  try {
    // new_creation = brand new tokens, sorted by smart money count
    const data = await fetchGMGN(
      `/defi/quotation/v1/rank/sol/pump?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`
    );
    const tokens = data?.data?.rank || [];
    for (const t of tokens) {
      if (!t.address) continue;
      const mc  = t.market_cap || 0;
      const sm  = t.smart_degen_count || 0;
      const kol = t.renowned_count    || 0;
      if (mc < MC_MIN || mc > MC_MAX) continue;
      if (sm < 1 && kol < 1)          continue;
      if ((t.rug_ratio || 0) > 0.25)  continue;
      if (t.is_wash_trading)           continue;
      results.push({ ...t, alertType: "ULTRA_EARLY" });
    }
  } catch(e) { log(`Trenches error: ${e.message}`); }
  return results.slice(0, 10);
}

// ─── SCANNER: GMGN KOL + SMART MONEY RANK ────────────────────────────────────
async function getKOLSignals() {
  const results = [];
  try {
    const data = await fetchGMGN(
      `/defi/quotation/v1/rank/sol/swaps/1h?orderby=smart_degen_count&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=100`
    );
    const tokens = data?.data?.rank || [];
    for (const t of tokens) {
      if (!t.address) continue;
      const mc  = t.market_cap          || 0;
      const sm  = t.smart_degen_count   || 0;
      const kol = t.renowned_count      || 0;
      if (mc < MC_MIN || mc > MC_MAX)   continue;
      if (sm < 1 || kol < 1)            continue;
      if ((t.rug_ratio || 0) > 0.25)    continue;
      if (t.is_wash_trading)             continue;
      results.push({ ...t, alertType: "KOL" });
    }
  } catch(e) { log(`KOL signals error: ${e.message}`); }
  results.sort((a, b) => (b.smart_degen_count || 0) - (a.smart_degen_count || 0));
  return results.slice(0, 20);
}

// ─── SCANNER: GMGN PUMPFUN PRE-BOND ──────────────────────────────────────────
async function getPumpSignals() {
  const results = [];
  try {
    const data = await fetchGMGN(
      `/defi/quotation/v1/rank/sol/pump?orderby=volume&direction=desc&filters[]=not_honeypot&limit=100`
    );
    const tokens = data?.data?.rank || [];
    for (const t of tokens) {
      if (!t.address) continue;
      const progress = t.launchpad_status?.bonding_curve_percentage || t.progress || 0;
      const volume   = t.volume || 0;
      const holders  = t.holder_count || t.holders || 0;
      if (progress < 60 || progress > 98) continue;
      if (volume   < 20000)               continue;
      if (holders  < 100)                 continue;
      if ((t.rug_ratio || 0) > 0.3)       continue;
      if (t.is_wash_trading)              continue;
      results.push({ ...t, alertType: "PUMP", progress });
    }
  } catch(e) { log(`Pump signals error: ${e.message}`); }
  results.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  return results.slice(0, 10);
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
          url: isPump ? `https://pump.fun/${mint}` : `https://axiom.trade/t/${mint}` },
        { text: "📈 Stats", callback_data: "stats" },
      ],
      [{ text: "❌ Skip", callback_data: `skip_${mint.slice(0, 20)}` }],
    ],
  };
}

// ─── SEND KOL ALERT ───────────────────────────────────────────────────────────
async function sendKOLAlert(token, aiResult) {
  const mint      = token.address;
  const symbol    = token.symbol || "???";
  const mc        = token.market_cap || 0;
  const age       = fmtAge(token.open_timestamp ? token.open_timestamp * 1000 : null);
  const holders   = token.holder_count || "N/A";
  const price     = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const vol       = fmt(token.volume || 0);
  const liq       = fmt(token.liquidity || 0);
  const change1h  = token.price_change_percent1h || 0;
  const vel       = getVelocity(token);
  const velLabel  = velocityLabel(vel);
  const score     = signalScore(token);
  const label     = signalLabel(score);
  const isReentry = token.alertType === "REENTRY";
  const riskEmoji = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";
  const devStatus = token.creator_token_status === "sell" ? "🔴 Sold" : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";
  const mintR     = token.renounced_mint           === 1 ? "🟢 Yes" : "🔴 No";
  const rugPct    = `${((token.rug_ratio || 0) * 100).toFixed(0)}%`;
  const netflow   = (token.buy_5m || 0) > (token.sell_5m || 0) ? "🟢 Accumulating" : "🔴 Selling";
  const insiders  = Object.keys(insiderBuys[mint] || {});
  const insiderStr = insiders.length > 0
    ? `\n└ 👛 ${insiders.join(", ")}${insiders.length >= 3 ? " 🔥 INSIDER CONVERGENCE" : ""}`
    : "";

  const msg =
    `🚨 *${isReentry ? "REENTRY" : "KOL"} SIGNAL* — ${label}\n` +
    `Score: ${score}/11 | AI: ${riskEmoji} ${aiResult.risk} ${aiResult.confidence}%\n\n` +
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
    `├ Smart Money: ${token.smart_degen_count || 0} 🤖\n` +
    `├ KOL Holders: ${token.renowned_count    || 0} 👑\n` +
    `└ Netflow: ${netflow}${insiderStr}\n\n` +
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
  log(`KOL: $${symbol} Score:${score} Smart:${token.smart_degen_count || 0} KOL:${token.renowned_count || 0} MC:${fmt(mc)}`);
}

// ─── SEND PUMP ALERT ──────────────────────────────────────────────────────────
async function sendPumpAlert(token, aiResult) {
  const mint        = token.address;
  const symbol      = token.symbol || "???";
  const progress    = token.progress || 0;
  const progressBar = "█".repeat(Math.floor(progress / 10)) + "░".repeat(10 - Math.floor(progress / 10));
  const holders     = token.holder_count || token.holders || "N/A";
  const vol         = fmt(token.volume || token.volume_24h || 0);
  const mc          = fmt(token.market_cap || token.usd_market_cap || 0);
  const price       = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const age         = fmtAge(token.open_timestamp ? token.open_timestamp * 1000 : null);
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
    `🧠 *Smart Signals*\n` +
    `├ Smart Money: ${token.smart_degen_count || 0} 🤖\n` +
    `└ KOL Holders: ${token.renowned_count    || 0} 👑\n\n` +
    `⚡ Buy before Raydium migration!\n` +
    `💰 *Snipe 0.1 SOL?*`;

  const sent = await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: buildKeyboard(mint, true),
  });
  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) await trackPerformance(mint, alertPrice, token.market_cap || 0, symbol, sent.message_id, "pump");
  botStats.pump.alerts++;
  log(`Pump: $${symbol} ${progress.toFixed(0)}% Vol:${vol}`);
}

// ─── SEND ULTRA EARLY ALERT ───────────────────────────────────────────────────
async function sendUltraAlert(token, aiResult) {
  const mint      = token.address;
  const symbol    = token.symbol || "???";
  const ageMs     = token.open_timestamp ? Date.now() - token.open_timestamp * 1000 : 0;
  const ageMin    = Math.floor(ageMs / 60000);
  const holders   = token.holder_count || token.holders || "N/A";
  const vol       = fmt(token.volume || 0);
  const mc        = token.market_cap || token.usd_market_cap || 0;
  const price     = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const buys      = token.buy_5m  || token.swaps_5m || 0;
  const sells     = token.sell_5m || 0;
  const buyRatio  = sells > 0 ? (buys / sells).toFixed(1) : buys > 0 ? "∞" : "0";
  const vel       = getVelocity(token);
  const momentum  = parseFloat(buyRatio) >= 10 ? "🔥🔥🔥 INSANE" : parseFloat(buyRatio) >= 5 ? "🔥🔥 VERY HIGH" : "🔥 HIGH";
  const riskEmoji = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";
  const devStatus = token.creator_token_status === "sell" ? "🔴 Sold" : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";

  const msg =
    `🚀 *ULTRA EARLY LAUNCH* — ${momentum}\n` +
    `AI: ${riskEmoji} ${aiResult.risk} ${aiResult.confidence}%\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n` +
    `└ ⏱ ${ageMin}m | 👁 ${holders} holders\n\n` +
    `📊 *Token Details*\n` +
    `├ PRICE: ${price}\n` +
    `└ MC:    ${fmt(mc)}\n\n` +
    `⚡ *Momentum*\n` +
    `├ Vol:      ${vol}\n` +
    `├ Buys:     ${buys}\n` +
    `├ Sells:    ${sells}\n` +
    `├ B/S:      ${buyRatio}:1\n` +
    `└ Velocity: ${vel}x\n\n` +
    `🔒 Dev: ${devStatus}\n\n` +
    `💰 *Snipe 0.1 SOL?*\nAlways DYOR`;

  const sent = await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: buildKeyboard(mint, true),
  });
  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) await trackPerformance(mint, alertPrice, mc, symbol, sent.message_id, "ultra");
  botStats.ultra.alerts++;
  log(`Ultra: $${symbol} Age:${ageMin}m B/S:${buyRatio}`);
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scan() {
  log("Scanning...");
  pollInsiderWallets().catch(() => {});

  const [kolTokens, pumpTokens, ultraTokens] = await Promise.all([
    getKOLSignals(),
    getPumpSignals(),
    getTrenchesSignals(),
  ]);

  log(`KOL: ${kolTokens.length} | Pump: ${pumpTokens.length} | Ultra: ${ultraTokens.length}`);

  // Merge all — ultra first (most time sensitive)
  const allTokens = [
    ...ultraTokens.map(t => ({ ...t, _type: "ultra" })),
    ...kolTokens.map(t =>   ({ ...t, _type: "kol"   })),
    ...pumpTokens.map(t =>  ({ ...t, _type: "pump"  })),
  ];

  // Run Claude in parallel
  const aiResults = await Promise.all(allTokens.map(t => claudeFilter(t)));

  // Filter rejected + sort by score
  const scored = allTokens
    .map((t, i) => ({ ...t, _ai: aiResults[i], _score: signalScore(t) }))
    .filter((t, i) => aiResults[i]?.decision !== "REJECT")
    .sort((a, b) => b._score - a._score);

  // Send top 5 per scan
  let sent = 0;
  for (const token of scored) {
    if (sent >= 5) break;
    const mint      = token.address;
    const lastAlert = alerted.get(mint);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;
    alerted.set(mint, Date.now());

    try {
      if (token._type === "ultra") await sendUltraAlert(token, token._ai);
      else if (token._type === "pump") await sendPumpAlert(token, token._ai);
      else await sendKOLAlert(token, token._ai);
      sent++;
    } catch(e) { log(`Alert error: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500));
  }

  // Cleanup
  const now = Date.now();
  for (const [mint, ts] of alerted.entries()) {
    if (now - ts > ALERT_COOLDOWN_MS) alerted.delete(mint);
  }
  for (const [k, v] of claudeCache.entries()) {
    if (now - v.ts > 7200000) claudeCache.delete(k);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("KOL Tracker v15 - GMGN Official API");

  await bot.sendMessage(CHAT_ID,
    `🟢 *KOL Tracker v15 Online*\n\n` +
    `✅ GMGN Official API\n` +
    `✅ IPv4 forced (fixes 403)\n` +
    `✅ 1 req/sec rate limiting\n` +
    `✅ KOL + Smart Money signals\n` +
    `✅ PumpFun Pre-Bond alerts\n` +
    `✅ Ultra Early Launch alerts\n` +
    `✅ Milestone tracking 2x 5x 10x\n` +
    `✅ Claude AI 50 calls/day\n` +
    `✅ 6 insider wallets tracked\n\n` +
    `Scan every 45s`,
    { parse_mode: "Markdown" }
  );

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
