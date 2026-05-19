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
        model: "claude-sonnet-4-20250514",
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
    log(`Claude filter error: ${e.message}`);
    // If Claude fails, fall back to basic approval
    return { decision: "APPROVE", reason: "Claude unavailable, using fallback", risk: "MEDIUM", confidence: 50 };
  }
}

// ─── PERFORMANCE TRACKER ──────────────────────────────────────────────────────
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
  // Store in tracker
  performanceTracker.set(mint, {
    alertPrice,
    alertMC,
    symbol,
    alertTime: Date.now(),
    alertMsgId,
    peakX: 1,
    checked: 0,
  });

  // Schedule checks
  for (const delay of TRACK_INTERVALS_MS) {
    setTimeout(async () => {
      const tracker = performanceTracker.get(mint);
      if (!tracker) return;

      const current = await getTokenPrice(mint);
      if (!current || !current.price || !alertPrice) return;

      const xGain = current.price / alertPrice;
      const xLabel = xGain.toFixed(2);
      tracker.checked++;

      // Update peak
      if (xGain > tracker.peakX) tracker.peakX = xGain;

      // Update stats
      if (xGain >= 10 && botStats.hits10x < Math.floor(xGain/10)) botStats.hits10x++;
      else if (xGain >= 5 && botStats.hits5x < Math.floor(xGain/5)) botStats.hits5x++;
      else if (xGain >= 2 && botStats.hits2x < Math.floor(xGain/2)) botStats.hits2x++;
      if (current.liquidity < 1000) botStats.rugs++;

      const timeLabel = delay < 3600000 ? `${delay/60000}m` : `${delay/3600000}h`;
      const emoji = xGain >= 5 ? "🚀" : xGain >= 2 ? "🟢" : xGain >= 1 ? "🟡" : "🔴";
      const liqWarning = current.liquidity < 5000 ? "\nLIQUIDITY LOW - consider exit!" : "";

      const msg =
        `${emoji} Performance Update\n\n` +
        `$${symbol} at ${timeLabel} after alert\n\n` +
        `Alert MC: ${fmt(alertMC)}\n` +
        `Current MC: ${fmt(current.mc)}\n` +
        `Gain: ${xLabel}x ${emoji}\n` +
        `Peak so far: ${tracker.peakX.toFixed(2)}x\n` +
        `Liq: ${fmt(current.liquidity)}${liqWarning}\n\n` +
        `${xGain >= 2 ? "Consider taking some profit!" : xGain < 0.5 ? "Significant loss - review position" : "Holding steady"}`;

      await bot.sendMessage(CHAT_ID, msg, {
        reply_to_message_id: alertMsgId,
      }).catch(() => {});

      // Final report at 24h
      if (tracker.checked >= TRACK_INTERVALS_MS.length) {
        await bot.sendMessage(CHAT_ID,
          `📋 Final Report: $${symbol}\n\n` +
          `Peak gain: ${tracker.peakX.toFixed(2)}x\n` +
          `Final: ${xLabel}x\n` +
          `Verdict: ${tracker.peakX >= 5 ? "BANGER" : tracker.peakX >= 2 ? "SOLID WIN" : tracker.peakX >= 1 ? "BREAKEVEN" : "RUG"}\n\n` +
          `Bot accuracy improving with each trade!`
        ).catch(() => {});
        performanceTracker.delete(mint);
      }
    }, delay);
  }
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
    `Rug: ${rugPct}\n\n` +
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

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scan() {
  log("Scanning GMGN for signals...");

  const [kolTokens, pumpTokens] = await Promise.all([
    getKOLSignals(),
    getPumpFunPrebond(),
  ]);

  log(`KOL: ${kolTokens.length} | PumpFun: ${pumpTokens.length}`);

  // Process KOL signals
  for (const token of kolTokens) {
    const mint = token.address;
    const lastAlert = alerted.get(mint);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;

    // Claude AI filter
    const aiResult = await claudeFilter(token);
    if (aiResult.decision === "REJECT") {
      log(`Rejected by AI: $${token.symbol} - ${aiResult.reason}`);
      continue;
    }

    alerted.set(mint, Date.now());
    await sendKOLAlert(token, aiResult);
    await new Promise(r => setTimeout(r, 2000));
  }

  // Process PumpFun signals
  for (const token of pumpTokens) {
    const mint = token.address;
    const lastAlert = alerted.get(`pump_${mint}`);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;

    const aiResult = await claudeFilter(token);
    if (aiResult.decision === "REJECT") {
      log(`PumpFun rejected by AI: $${token.symbol} - ${aiResult.reason}`);
      continue;
    }

    alerted.set(`pump_${mint}`, Date.now());
    await sendPumpAlert(token, aiResult);
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("KOL Tracker v9 - AI Powered");

  await bot.sendMessage(CHAT_ID,
    `KOL Tracker Bot v9 Online\n\n` +
    `AI-Powered Signal System\n\n` +
    `1. KOL Signal Alerts\n` +
    `- Claude AI quality filter\n` +
    `- smart_degen + KOL overlap\n` +
    `- 24hr age filter\n` +
    `- Re-entry detection\n\n` +
    `2. PumpFun Pre-Bond Alerts\n` +
    `- 60-98% bonding curve\n` +
    `- High volume only\n` +
    `- AI filtered\n\n` +
    `3. Performance Tracking\n` +
    `- Tracks every alert\n` +
    `- Updates at 30m/1h/4h/24h\n` +
    `- Shows X gains from alert price\n` +
    `- Tap Stats button for summary\n\n` +
    `Scan every 20s`
  );

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
