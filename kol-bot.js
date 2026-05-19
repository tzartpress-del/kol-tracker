const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// ─── SIGNAL FILTERS ───────────────────────────────────────────────────────────
const MC_MIN = 15000;
const MC_MAX = 150000;
const MIN_SMART_DEGEN = 1;
const MIN_RENOWNED = 1;
const MAX_RUG_RATIO = 0.3;
const MIN_LIQUIDITY = 5000;
const POLL_INTERVAL_MS = 20000;
const ALERT_COOLDOWN_MS = 3600000;
const MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;
const REENTRY_MIN_VOLUME = 50000;

// PumpFun filters
const PUMP_MIN_VOLUME = 20000;
const PUMP_MIN_PROGRESS = 60;
const PUMP_MAX_PROGRESS = 98;
const PUMP_MIN_HOLDERS = 100;

// Performance tracking
const TRACK_INTERVALS_MS = [
  30 * 60 * 1000,   // 30 mins
  60 * 60 * 1000,   // 1 hour
  4 * 60 * 60 * 1000,  // 4 hours
  24 * 60 * 60 * 1000, // 24 hours
];

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const alerted = new Map();
const performanceTracker = new Map(); // mint -> { alertPrice, alertTime, symbol, peaks, messageId }
const botStats = { totalAlerts: 0, hits2x: 0, hits5x: 0, hits10x: 0, rugs: 0 };

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
      const wr = botStats.totalAlerts > 0
        ? ((botStats.hits2x / botStats.totalAlerts) * 100).toFixed(0) : 0;
      await bot.sendMessage(CHAT_ID,
        `📊 Bot Performance Stats\n\n` +
        `Total Alerts: ${botStats.totalAlerts}\n` +
        `2x Hits: ${botStats.hits2x}\n` +
        `5x Hits: ${botStats.hits5x}\n` +
        `10x Hits: ${botStats.hits10x}\n` +
        `Rugs: ${botStats.rugs}\n` +
        `2x Win Rate: ${wr}%\n\n` +
        `Tracking ${performanceTracker.size} active tokens`
      );
    }
  } catch(e) {}
});

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function fmt(n) {
  if (!n && n !== 0) return "N/A";
  if (n >= 1000000) return `$${(n/1000000).toFixed(2)}M`;
  if (n >= 1000) return `$${(n/1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtAge(ts) {
  if (!ts) return "N/A";
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m`;
  if (secs < 86400) return `${Math.floor(secs/3600)}h`;
  return `${Math.floor(secs/86400)}d`;
}

function signalScore(t) {
  let s = 0;
  const smart = t.smart_degen_count || 0;
  const kol = t.renowned_count || 0;
  const rug = t.rug_ratio || 1;
  if (smart >= 3) s += 3; else if (smart >= 2) s += 2; else if (smart >= 1) s += 1;
  if (kol >= 2) s += 2; else if (kol >= 1) s += 1;
  if (rug < 0.1) s += 2; else if (rug < 0.2) s += 1;
  if (t.renounced_mint === 1) s += 1;
  if (t.renounced_freeze_account === 1) s += 1;
  if (!t.is_wash_trading) s += 1;
  return s;
}

function signalLabel(score) {
  if (score >= 8) return "ULTRA HIGH";
  if (score >= 6) return "HIGH";
  if (score >= 4) return "MEDIUM";
  return "LOW";
}

// ─── CLAUDE AI QUALITY FILTER ─────────────────────────────────────────────────
async function claudeFilter(token) {
  try {
    const prompt = `You are a Solana memecoin trading risk analyst. Analyze this token and decide if it should be flagged as a trading signal.

Token Data:
- Symbol: ${token.symbol}
- Market Cap: $${token.market_cap}
- Liquidity: $${token.liquidity}
- Volume 1h: $${token.volume}
- Smart Money Wallets: ${token.smart_degen_count || 0}
- KOL Wallets: ${token.renowned_count || 0}
- Rug Ratio: ${((token.rug_ratio || 0) * 100).toFixed(0)}%
- Dev Status: ${token.creator_token_status || "unknown"}
- Mint Renounced: ${token.renounced_mint === 1 ? "yes" : "no"}
- Freeze Renounced: ${token.renounced_freeze_account === 1 ? "yes" : "no"}
- Wash Trading: ${token.is_wash_trading ? "yes" : "no"}
- Bundle Rate: ${((token.bundler_trader_amount_rate || 0) * 100).toFixed(0)}%
- Holder Count: ${token.holder_count || 0}
- Token Age: ${fmtAge(token.open_timestamp ? token.open_timestamp * 1000 : null)}
- Price Change 1h: ${token.price_change_percent1h || 0}%

Rules - REJECT if:
- Rug ratio > 20%
- Wash trading detected
- Dev already sold
- Bundle rate > 30%
- Liquidity < $8000
- Holder count < 50
- Volume looks fake (very high volume but low holders)
- Smart money = 0 AND KOL = 0

APPROVE if:
- Smart money >= 1 OR KOL >= 1
- Rug ratio < 15%
- Liquidity stable
- Holder count growing
- Volume is organic

Respond in this exact JSON format only, no other text:
{"decision":"APPROVE","reason":"brief reason","risk":"LOW/MEDIUM/HIGH","confidence":85}
or
{"decision":"REJECT","reason":"brief reason","risk":"VERY HIGH","confidence":90}`;

    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        timeout: 15000
      }
    );

    const text = res.data?.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);
    log(`Claude: ${token.symbol} -> ${result.decision} (${result.reason}) conf:${result.confidence}%`);
    return result;
  } catch(e) {
    log(`Claude filter error: ${e.response?.status} ${e.response?.data?.error?.message || e.message}`);
    return { decision: "APPROVE", reason: "Claude unavailable, using fallback", risk: "MEDIUM", confidence: 50 };
  }
}

// ─── PERFORMANCE TRACKER ──────────────────────────────────────────────────────
// ─── PROVEN INSIDER WALLETS ───────────────────────────────────────────────────
const INSIDER_WALLETS = {
  "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm": "InsiderAlpha1",
  "4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t": "InsiderAlpha2",
  "8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd": "InsiderAlpha3",
  "9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL": "9SLP_KpKS",
  "84vL38o5zTQjvA2fv7f3MgwXVBm8rBs1QBVXHtranQy5": "2snH_kKuS",
  "BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB": "Axio_TTSk",
};

// ─── INSIDER WALLET POLLING ───────────────────────────────────────────────────
const lastSig = {};
const insiderBuys = {};
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

async function pollInsiderWallets() {
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
  // Clean old entries > 2hrs
  const cutoff = Date.now() - 7200000;
  for (const [mint, buyers] of Object.entries(insiderBuys)) {
    for (const [k, ts] of Object.entries(buyers)) {
      if (ts < cutoff) delete insiderBuys[mint][k];
    }
    if (!Object.keys(insiderBuys[mint]).length) delete insiderBuys[mint];
  }
}

// ─── NETFLOW DETECTION ────────────────────────────────────────────────────────
function getNetflow(token) {
  const buys = token.buy_5m || token.swaps_5m || 0;
  const sells = token.sell_5m || 0;
  const buyVol = token.buy_volume_5m || 0;
  const sellVol = token.sell_volume_5m || 0;
  const ratio = sells > 0 ? (buys / sells).toFixed(1) : buys > 0 ? "∞" : "0";
  const netVol = buyVol - sellVol;
  const isAccumulating = netVol > 0 && buys > sells;
  return { ratio, netVol, isAccumulating, buys, sells };
}

// ─── MILESTONE PERFORMANCE TRACKER ───────────────────────────────────────────
async function getTokenPrice(mint) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 8000 }
    );
    const pairs = (res.data?.pairs || []).filter(p => p.chainId === "solana");
    if (!pairs.length) return null;
    pairs.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0));
    return {
      price: parseFloat(pairs[0].priceUsd || 0),
      mc: pairs[0].fdv || pairs[0].marketCap || 0,
      liquidity: pairs[0].liquidity?.usd || 0,
    };
  } catch(e) { return null; }
}

async function trackPerformance(mint, alertPrice, alertMC, symbol, alertMsgId) {
  performanceTracker.set(mint, {
    alertPrice, alertMC, symbol,
    alertTime: Date.now(), alertMsgId,
    peakX: 1, notified2x: false, notified5x: false, notified10x: false,
  });

  // Check every 3 minutes for 24 hours
  const interval = setInterval(async () => {
    const tracker = performanceTracker.get(mint);
    if (!tracker) { clearInterval(interval); return; }

    // Stop after 24 hours
    if (Date.now() - tracker.alertTime > 86400000) {
      // Final report
      await bot.sendMessage(CHAT_ID,
        `📋 Final: $${symbol}\n` +
        `Peak: ${tracker.peakX.toFixed(2)}x\n` +
        `Verdict: ${tracker.peakX >= 10 ? "MOONSHOT 🌙" : tracker.peakX >= 5 ? "BANGER 🔥" : tracker.peakX >= 2 ? "SOLID WIN ✅" : tracker.peakX >= 1 ? "BREAKEVEN 🟡" : "RUG 🔴"}`
      ).catch(() => {});
      performanceTracker.delete(mint);
      clearInterval(interval);
      return;
    }

    const current = await getTokenPrice(mint);
    if (!current?.price || !alertPrice) return;
    const xGain = current.price / alertPrice;
    if (xGain > tracker.peakX) tracker.peakX = xGain;

    // Milestone alerts only
    if (xGain >= 10 && !tracker.notified10x) {
      tracker.notified10x = true;
      botStats.hits10x++;
      await bot.sendMessage(CHAT_ID,
        `🌙 10x MILESTONE!\n\n$${symbol} is up 10x from alert!\nMC: ${fmt(current.mc)}\nLiq: ${fmt(current.liquidity)}\n\nConsider taking profit!`,
        { reply_to_message_id: alertMsgId }
      ).catch(() => {});
    } else if (xGain >= 5 && !tracker.notified5x) {
      tracker.notified5x = true;
      botStats.hits5x++;
      await bot.sendMessage(CHAT_ID,
        `🚀 5x MILESTONE!\n\n$${symbol} is up 5x from alert!\nMC: ${fmt(current.mc)}\nLiq: ${fmt(current.liquidity)}\n\nConsider taking some profit!`,
        { reply_to_message_id: alertMsgId }
      ).catch(() => {});
    } else if (xGain >= 2 && !tracker.notified2x) {
      tracker.notified2x = true;
      botStats.hits2x++;
      await bot.sendMessage(CHAT_ID,
        `✅ 2x MILESTONE!\n\n$${symbol} is up 2x from alert!\nMC: ${fmt(current.mc)}\nLiq: ${fmt(current.liquidity)}\n\nConsider taking 25% profit!`,
        { reply_to_message_id: alertMsgId }
      ).catch(() => {});
    }

    // Rug warning
    if (current.liquidity < 2000 && tracker.peakX > 1.5) {
      await bot.sendMessage(CHAT_ID,
        `⚠️ LIQUIDITY WARNING!\n\n$${symbol} liquidity dropping!\nLiq: ${fmt(current.liquidity)}\nConsider exiting!`,
        { reply_to_message_id: alertMsgId }
      ).catch(() => {});
      performanceTracker.delete(mint);
      clearInterval(interval);
    }
  }, 3 * 60 * 1000); // check every 3 mins
}

// ─── GMGN FETCH ───────────────────────────────────────────────────────────────
async function fetchGMGN(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Referer": "https://gmgn.ai/",
        },
        timeout: 12000
      });
      return res.data;
    } catch(e) {
      const status = e.response?.status;
      if (status === 429 || status === 403) {
        log(`Rate limited, waiting ${(i+1)*5}s...`);
        await new Promise(r => setTimeout(r, (i+1) * 5000));
      } else {
        log(`Fetch error: ${e.message}`);
        return null;
      }
    }
  }
  return null;
}

// ─── GET KOL SIGNALS ─────────────────────────────────────────────────────────
async function getKOLSignals() {
  const urls = [
    `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=100`,
    `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/5m?orderby=smart_degen_count&direction=desc&filters[]=not_honeypot&limit=100`,
    `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=smart_degen_count&direction=desc&filters[]=not_honeypot&limit=100`,
  ];

  const responses = await Promise.allSettled(urls.map(u => fetchGMGN(u)));
  const seen = new Set();
  const results = [];

  for (const r of responses) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const tokens = r.value?.data?.rank || [];
    for (const t of tokens) {
      if (!t.address || seen.has(t.address)) continue;
      seen.add(t.address);

      const mc = t.market_cap || 0;
      const tokenAge = t.open_timestamp ? (Date.now() - t.open_timestamp * 1000) : null;
      const isNew = tokenAge !== null && tokenAge <= MAX_TOKEN_AGE_MS;
      const isReentry = !isNew && (t.volume || 0) >= REENTRY_MIN_VOLUME && (t.smart_degen_count || 0) >= 2;

      if (
        mc >= MC_MIN && mc <= MC_MAX &&
        (t.smart_degen_count || 0) >= MIN_SMART_DEGEN &&
        (t.renowned_count || 0) >= MIN_RENOWNED &&
        (t.rug_ratio || 0) < MAX_RUG_RATIO &&
        (t.liquidity || 0) >= MIN_LIQUIDITY &&
        !t.is_wash_trading &&
        (isNew || isReentry)
      ) {
        results.push({ ...t, alertType: isReentry ? "REENTRY" : "KOL", tokenAge });
      }
    }
  }

  results.sort((a, b) => signalScore(b) - signalScore(a));
  return results;
}

// ─── GET PUMPFUN PRE-BOND ─────────────────────────────────────────────────────
async function getPumpFunPrebond() {
  const urls = [
    `https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=volume&direction=desc&filters[]=not_honeypot&limit=100`,
    `https://gmgn.ai/api/v1/mutil_window_token_list/sol?type=near_completion&orderby=volume&direction=desc&limit=50`,
  ];

  const responses = await Promise.allSettled(urls.map(u => fetchGMGN(u)));
  const seen = new Set();
  const results = [];

  for (const r of responses) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const tokens = r.value?.data?.rank || r.value?.data?.token_list || r.value?.data || [];
    if (!Array.isArray(tokens)) continue;

    for (const t of tokens) {
      if (!t.address || seen.has(t.address)) continue;
      seen.add(t.address);

      const progress = t.launchpad_status?.bonding_curve_percentage
        || t.graduation_progress || t.bondingCurveProgress || t.progress || 0;
      const volume = t.volume || t.volume_24h || 0;
      const holders = t.holder_count || t.holders || 0;

      if (
        progress >= PUMP_MIN_PROGRESS &&
        progress <= PUMP_MAX_PROGRESS &&
        volume >= PUMP_MIN_VOLUME &&
        holders >= PUMP_MIN_HOLDERS &&
        (t.rug_ratio || 0) < MAX_RUG_RATIO &&
        !t.is_wash_trading
      ) {
        results.push({ ...t, alertType: "PUMP", progress });
      }
    }
  }

  results.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  return results.slice(0, 10);
}

// ─── SEND KOL ALERT ───────────────────────────────────────────────────────────
async function sendKOLAlert(token, aiResult) {
  const mint = token.address;
  const symbol = token.symbol || "???";
  const mc = token.market_cap || 0;
  const age = fmtAge(token.open_timestamp ? token.open_timestamp * 1000 : null);
  const holders = token.holder_count || "N/A";
  const price = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const vol = fmt(token.volume || 0);
  const liq = fmt(token.liquidity || 0);
  const change1h = token.price_change_percent1h || 0;
  const changeStr = change1h > 0 ? `+${change1h.toFixed(1)}%` : `${change1h.toFixed(1)}%`;
  const score = signalScore(token);
  const label = signalLabel(score);
  const isReentry = token.alertType === "REENTRY";
  const mintR = token.renounced_mint === 1 ? "Yes" : "No";
  const freezeR = token.renounced_freeze_account === 1 ? "Yes" : "No";
  const rugPct = token.rug_ratio !== undefined ? `${(token.rug_ratio * 100).toFixed(0)}%` : "N/A";
  const devStatus = token.creator_token_status === "sell" ? "Sold" : token.creator_token_status === "hold" ? "Holding" : "N/A";
  const smartCount = token.smart_degen_count || 0;
  const kolCount = token.renowned_count || 0;
  const netflow = getNetflow(token);
  const insiders = Object.keys(insiderBuys[token.address] || {});
  const insiderStr = insiders.length > 0
    ? `\n\n👛 *Insider Wallets*\n${insiders.map(i => `- ${i}`).join("\n")}`
    : "";
  const netflowStr = netflow.buys > 0
    ? `\n\n📊 *Netflow (5m)*\nBuys: ${netflow.buys} | Sells: ${netflow.sells}\nRatio: ${netflow.ratio}:1 ${netflow.isAccumulating ? "🟢 Accumulating" : "🔴 Selling"}`
    : "";

  const riskEmoji = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";
  const header = isReentry ? "REENTRY SIGNAL" : "KOL SIGNAL DETECTED";

  const msg =
    `🚨 ${header} 🚨\n` +
    `Signal: ${label} | Score: ${score}/11\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n` +
    `Age: ${age} | Holders: ${holders}\n\n` +
    `📊 *Token Details*\n` +
    `Price:   ${price}\n` +
    `MC:      ${fmt(mc)}\n` +
    `Vol 1h:  ${vol}\n` +
    `Liq:     ${liq}\n` +
    `1h Chg:  ${changeStr}\n\n` +
    `🧠 *Smart Signals*\n` +
    `Smart Money: ${smartCount}\n` +
    `KOL Holders: ${kolCount}\n\n` +
    `🤖 *AI Analysis*\n` +
    `Risk: ${riskEmoji} ${aiResult.risk}\n` +
    `Reason: ${aiResult.reason}\n` +
    `Confidence: ${aiResult.confidence}%\n\n` +
    `🔒 *Security*\n` +
    `Dev: ${devStatus} | Mint: ${mintR} | Freeze: ${freezeR}\n` +
    `Rug: ${rugPct}\n` +
    `${netflowStr}${insiderStr}\n\n` +
    `💰 *Snipe 0.1 SOL?*`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🚀 BUY 0.1 SOL via Trojan", url: `https://t.me/solana_trojanbot?start=ca_${mint}` }],
      [
        { text: "📊 DexScreener", url: `https://dexscreener.com/solana/${mint}` },
        { text: "🔍 GMGN", url: `https://gmgn.ai/sol/token/${mint}` }
      ],
      [
        { text: "⚡ Axiom", url: `https://axiom.trade/t/${mint}` },
        { text: "📈 Stats", callback_data: "stats" }
      ],
      [{ text: "❌ Skip", callback_data: `skip_${mint.slice(0,20)}` }]
    ]
  };

  const sent = await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });

  // Start performance tracking
  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) {
    await trackPerformance(mint, alertPrice, mc, symbol, sent.message_id);
  }

  botStats.totalAlerts++;
  log(`Alert sent: $${symbol} | AI:${aiResult.decision} | Risk:${aiResult.risk} | Score:${score}`);
}

// ─── SEND PUMPFUN ALERT ───────────────────────────────────────────────────────
async function sendPumpAlert(token, aiResult) {
  const mint = token.address;
  const symbol = token.symbol || "???";
  const progress = token.progress || 0;
  const progressBar = "█".repeat(Math.floor(progress/10)) + "░".repeat(10 - Math.floor(progress/10));
  const holders = token.holder_count || token.holders || "N/A";
  const vol = fmt(token.volume || token.volume_24h || 0);
  const mc = fmt(token.market_cap || token.usd_market_cap || 0);
  const price = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const age = fmtAge(token.open_timestamp ? token.open_timestamp * 1000 : token.created_timestamp ? token.created_timestamp * 1000 : null);
  const urgency = progress >= 90 ? "MIGRATING SOON" : progress >= 75 ? "FILLING FAST" : "EARLY";
  const riskEmoji = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";

  const msg =
    `🎯 *PUMPFUN PRE-BOND ALERT* 🎯\n` +
    `${urgency}\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n` +
    `Age: ${age} | Holders: ${holders}\n\n` +
    `*Bonding Curve*\n` +
    `[${progressBar}] ${progress.toFixed(1)}%\n` +
    `${progress >= 90 ? "Almost migrating to Raydium!" : "Still on PumpFun"}\n\n` +
    `Price: ${price}\n` +
    `MC:    ${mc}\n` +
    `Vol:   ${vol}\n\n` +
    `🤖 *AI Analysis*\n` +
    `Risk: ${riskEmoji} ${aiResult.risk}\n` +
    `Reason: ${aiResult.reason}\n` +
    `Confidence: ${aiResult.confidence}%\n\n` +
    `Buy before migration to Raydium!\n` +
    `💰 *Snipe 0.1 SOL?*`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🚀 BUY 0.1 SOL via Trojan", url: `https://t.me/solana_trojanbot?start=ca_${mint}` }],
      [
        { text: "🎯 PumpFun", url: `https://pump.fun/${mint}` },
        { text: "🔍 GMGN", url: `https://gmgn.ai/sol/token/${mint}` }
      ],
      [
        { text: "⚡ Axiom", url: `https://axiom.trade/t/${mint}` },
        { text: "📈 Stats", callback_data: "stats" }
      ],
      [{ text: "❌ Skip", callback_data: `skip_${mint.slice(0,20)}` }]
    ]
  };

  const sent = await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });

  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) {
    await trackPerformance(mint, alertPrice, token.market_cap || 0, symbol, sent.message_id);
  }

  botStats.totalAlerts++;
  log(`PumpFun alert: $${symbol} ${progress.toFixed(0)}% | AI:${aiResult.decision} | Risk:${aiResult.risk}`);
}

// ─── ULTRA EARLY LAUNCH DETECTOR ─────────────────────────────────────────────
async function getUltraEarlyLaunches() {
  const urls = [
    // Brand new tokens sorted by creation time
    `https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
    // High momentum new launches
    `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/5m?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
  ];

  const responses = await Promise.allSettled(urls.map(u => fetchGMGN(u)));
  const seen = new Set();
  const results = [];

  for (const r of responses) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const tokens = r.value?.data?.rank || r.value?.data?.token_list || r.value?.data || [];
    if (!Array.isArray(tokens)) continue;

    for (const t of tokens) {
      if (!t.address || seen.has(t.address)) continue;
      seen.add(t.address);

      // Must be very fresh — under 30 mins old
      const ageMs = t.open_timestamp ? Date.now() - t.open_timestamp * 1000 : null;
      if (!ageMs || ageMs > 30 * 60 * 1000) continue;

      const progress = t.launchpad_status?.bonding_curve_percentage
        || t.graduation_progress || t.progress || 0;
      const volume = t.volume || t.volume_5m || 0;
      const holders = t.holder_count || t.holders || 0;
      const buys = t.swaps_5m || t.buy_5m || t.txns_5m?.buys || 0;
      const sells = t.sells_5m || t.txns_5m?.sells || 0;
      const buyRatio = sells > 0 ? buys / sells : buys;
      const rug = t.rug_ratio || 0;

      // Ultra early filters:
      // - Under 30 mins old
      // - Bonding curve 3-60% (early but moving)
      // - Volume > $3K in 5 mins (strong momentum)
      // - Holders > 30 (organic buying)
      // - Buy/sell ratio > 2:1
      // - No rug signals
      if (
        progress >= 3 &&
        progress <= 60 &&
        volume >= 3000 &&
        holders >= 30 &&
        buyRatio >= 2 &&
        rug < 0.2 &&
        !t.is_wash_trading &&
        !t.is_honeypot
      ) {
        results.push({
          ...t,
          alertType: "ULTRA_EARLY",
          ageMs,
          progress,
          buys,
          sells,
          buyRatio
        });
      }
    }
  }

  // Sort by buy/sell ratio (strongest momentum first)
  results.sort((a, b) => b.buyRatio - a.buyRatio);
  return results.slice(0, 5); // top 5 only — quality over quantity
}

// ─── SEND ULTRA EARLY ALERT ───────────────────────────────────────────────────
async function sendUltraEarlyAlert(token, aiResult) {
  const mint = token.address;
  const symbol = token.symbol || "???";
  const ageMin = Math.floor((token.ageMs || 0) / 60000);
  const progress = token.progress || 0;
  const progressBar = "█".repeat(Math.floor(progress/10)) + "░".repeat(10 - Math.floor(progress/10));
  const holders = token.holder_count || token.holders || "N/A";
  const vol5m = fmt(token.volume || token.volume_5m || 0);
  const mc = token.market_cap || token.usd_market_cap || 0;
  const price = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const buys = token.buys || 0;
  const sells = token.sells || 0;
  const buyRatio = token.buyRatio ? token.buyRatio.toFixed(1) : "N/A";
  const devStatus = token.creator_token_status === "sell" ? "🔴 Sold"
    : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";
  const rug = token.rug_ratio !== undefined ? `${(token.rug_ratio * 100).toFixed(0)}%` : "N/A";
  const bundle = token.bundler_trader_amount_rate
    ? `${(token.bundler_trader_amount_rate * 100).toFixed(0)}%` : "N/A";
  const riskEmoji = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";

  // Momentum score
  const momentum = token.buyRatio >= 10 ? "🔥🔥🔥 INSANE"
    : token.buyRatio >= 5 ? "🔥🔥 VERY HIGH"
    : token.buyRatio >= 3 ? "🔥 HIGH"
    : "✅ GOOD";

  const msg =
    `🚀 *ULTRA EARLY LAUNCH* 🚀\n` +
    `${momentum} MOMENTUM\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n` +
    `Age: ${ageMin}m | Holders: ${holders}\n\n` +
    `📈 *Bonding Curve*\n` +
    `[${progressBar}] ${progress.toFixed(1)}%\n\n` +
    `⚡ *Momentum (5min)*\n` +
    `Vol:       ${vol5m}\n` +
    `Buys:      ${buys}\n` +
    `Sells:     ${sells}\n` +
    `B/S Ratio: ${buyRatio}:1\n\n` +
    `💰 *Token*\n` +
    `Price: ${price}\n` +
    `MC:    ${fmt(mc)}\n\n` +
    `🔒 *Safety*\n` +
    `Dev:    ${devStatus}\n` +
    `Rug:    ${rug}\n` +
    `Bundle: ${bundle}\n\n` +
    `🤖 *AI Analysis*\n` +
    `Risk: ${riskEmoji} ${aiResult.risk}\n` +
    `${aiResult.reason}\n` +
    `Confidence: ${aiResult.confidence}%\n\n` +
    `💰 *Snipe 0.1 SOL?*\n` +
    `Always DYOR`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🚀 BUY 0.1 SOL via Trojan", url: `https://t.me/solana_trojanbot?start=ca_${mint}` }],
      [
        { text: "🎯 PumpFun", url: `https://pump.fun/${mint}` },
        { text: "🔍 GMGN", url: `https://gmgn.ai/sol/token/${mint}` }
      ],
      [
        { text: "📊 DexScreener", url: `https://dexscreener.com/solana/${mint}` },
        { text: "📈 Stats", callback_data: "stats" }
      ],
      [{ text: "❌ Skip", callback_data: `skip_${mint.slice(0,20)}` }]
    ]
  };

  const sent = await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });

  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) {
    await trackPerformance(mint, alertPrice, mc, symbol, sent.message_id);
  }

  botStats.totalAlerts++;
  log(`🚀 Ultra Early: $${symbol} | Age:${ageMin}m | Curve:${progress.toFixed(0)}% | B/S:${buyRatio} | AI:${aiResult.risk}`);
}
async function scan() {
  log("Scanning GMGN for signals...");

  // Poll insider wallets in background
  pollInsiderWallets().catch(e => log(`Insider poll error: ${e.message}`));

  const [kolTokens, pumpTokens, ultraEarlyTokens] = await Promise.all([
    getKOLSignals(),
    getPumpFunPrebond(),
    getUltraEarlyLaunches(),
  ]);

  log(`KOL: ${kolTokens.length} | PumpFun: ${pumpTokens.length} | Ultra Early: ${ultraEarlyTokens.length}`);

  // Ultra Early FIRST — most time sensitive
  for (const token of ultraEarlyTokens) {
    const mint = token.address;
    const lastAlert = alerted.get(`early_${mint}`);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;
    const aiResult = await claudeFilter(token);
    if (aiResult.decision === "REJECT") {
      log(`Ultra Early rejected: $${token.symbol} - ${aiResult.reason}`);
      continue;
    }
    alerted.set(`early_${mint}`, Date.now());
    await sendUltraEarlyAlert(token, aiResult);
    await new Promise(r => setTimeout(r, 1500));
  }

  // KOL signals
  for (const token of kolTokens) {
    const mint = token.address;
    const lastAlert = alerted.get(mint);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;
    const aiResult = await claudeFilter(token);
    if (aiResult.decision === "REJECT") {
      log(`KOL rejected: $${token.symbol} - ${aiResult.reason}`);
      continue;
    }
    alerted.set(mint, Date.now());
    await sendKOLAlert(token, aiResult);
    await new Promise(r => setTimeout(r, 2000));
  }

  // PumpFun pre-bond
  for (const token of pumpTokens) {
    const mint = token.address;
    const lastAlert = alerted.get(`pump_${mint}`);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;
    const aiResult = await claudeFilter(token);
    if (aiResult.decision === "REJECT") {
      log(`PumpFun rejected: $${token.symbol} - ${aiResult.reason}`);
      continue;
    }
    alerted.set(`pump_${mint}`, Date.now());
    await sendPumpAlert(token, aiResult);
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("KOL Tracker v11 - Full Upgrade");

  await bot.sendMessage(CHAT_ID,
    `KOL Tracker Bot v11 Online\n\n` +
    `Upgrades Active\n\n` +
    `1. Claude AI Filter - FIXED\n` +
    `2. Milestone Tracking Only\n` +
    `   - Alerts at 2x, 5x, 10x\n` +
    `   - Liquidity warning\n` +
    `   - 24hr final report\n\n` +
    `3. Proven Insider Wallets\n` +
    `   - 6 high win rate wallets\n` +
    `   - Shows on every alert\n\n` +
    `4. Netflow Detection\n` +
    `   - Buy/sell ratio\n` +
    `   - Accumulation signal\n\n` +
    `5. Ultra Early Launches\n` +
    `6. PumpFun Pre-Bond\n` +
    `7. KOL Signal Alerts\n\n` +
    `Scan every 20s`
  );

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
