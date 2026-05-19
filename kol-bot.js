const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// ─── SIGNAL FILTERS ───────────────────────────────────────────────────────────
const MC_MIN = 15000;
const MC_MAX = 150000;
const MIN_SMART_DEGEN = 1;
const MIN_RENOWNED = 1;
const MAX_RUG_RATIO = 0.3;
const MIN_LIQUIDITY = 5000;
const POLL_INTERVAL_MS = 20000;
const ALERT_COOLDOWN_MS = 3600000;
const MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;  // only show tokens < 24hrs old
const REENTRY_MIN_VOLUME = 50000;               // $50K volume spike for re-entry

// PumpFun pre-bond filters
const PUMP_MIN_VOLUME = 20000;      // min $20K volume (high activity)
const PUMP_MIN_PROGRESS = 60;       // min 60% bonding curve progress
const PUMP_MAX_PROGRESS = 98;       // max 98% (not yet migrated)
const PUMP_MIN_HOLDERS = 100;       // min 100 holders

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const alerted = new Map();

bot.on("callback_query", async (query) => {
  try {
    if (query.data?.startsWith("skip_")) {
      await bot.answerCallbackQuery(query.id, { text: "⏭ Skipped!" });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: "❌ Skipped", callback_data: "done" }]] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
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
  if (score >= 8) return "🔥 ULTRA HIGH";
  if (score >= 6) return "⚡ HIGH";
  if (score >= 4) return "✅ MEDIUM";
  return "🟡 LOW";
}

// ─── GMGN FETCH HELPER WITH RETRY ────────────────────────────────────────────
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
        log(`Rate limited (${status}), waiting ${(i+1)*5}s...`);
        await new Promise(r => setTimeout(r, (i+1) * 5000));
      } else {
        log(`Fetch error: ${e.message}`);
        return null;
      }
    }
  }
  return null;
}

// ─── 1. KOL/SMART MONEY SIGNALS ──────────────────────────────────────────────
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
      const volume = t.volume || 0;
      const isReentry = !isNew && volume >= REENTRY_MIN_VOLUME &&
        (t.smart_degen_count || 0) >= 2; // needs 2+ smart money for re-entry

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

// ─── 2. PUMPFUN PRE-BOND SIGNALS ─────────────────────────────────────────────
async function getPumpFunPrebond() {
  const urls = [
    // Near completion tokens (60-98% bonding curve)
    `https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=volume&direction=desc&filters[]=not_honeypot&limit=100`,
    // Trenches near_completion endpoint
    `https://gmgn.ai/api/v1/mutil_window_token_list/sol?type=near_completion&orderby=volume&direction=desc&limit=50`,
  ];

  const responses = await Promise.allSettled(urls.map(u => fetchGMGN(u)));
  const seen = new Set();
  const results = [];

  for (const r of responses) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const tokens = r.value?.data?.rank
      || r.value?.data?.token_list
      || r.value?.data
      || [];
    if (!Array.isArray(tokens)) continue;

    for (const t of tokens) {
      if (!t.address || seen.has(t.address)) continue;
      seen.add(t.address);

      const progress = t.launchpad_status?.bonding_curve_percentage
        || t.graduation_progress
        || t.bondingCurveProgress
        || t.progress
        || 0;

      const volume = t.volume || t.volume_24h || 0;
      const holders = t.holder_count || t.holders || 0;
      const rug = t.rug_ratio || 0;

      if (
        progress >= PUMP_MIN_PROGRESS &&
        progress <= PUMP_MAX_PROGRESS &&
        volume >= PUMP_MIN_VOLUME &&
        holders >= PUMP_MIN_HOLDERS &&
        rug < MAX_RUG_RATIO &&
        !t.is_wash_trading
      ) {
        results.push({ ...t, alertType: "PUMP", progress });
      }
    }
  }

  // Sort by volume descending
  results.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  return results.slice(0, 10); // top 10 only
}

// ─── SEND KOL ALERT ───────────────────────────────────────────────────────────
async function sendKOLAlert(token) {
  const mint = token.address;
  const symbol = token.symbol || "???";
  const mc = token.market_cap || 0;
  const age = fmtAge(token.open_timestamp ? token.open_timestamp * 1000 : null);
  const holders = token.holder_count || "N/A";
  const price = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const vol = fmt(token.volume || 0);
  const liq = fmt(token.liquidity || 0);
  const change1h = token.price_change_percent1h || 0;
  const changeStr = change1h > 0 ? `📈 +${change1h.toFixed(1)}%` : `📉 ${change1h.toFixed(1)}%`;
  const score = signalScore(token);
  const label = signalLabel(score);
  const isReentry = token.alertType === "REENTRY";
  const alertHeader = isReentry
    ? `♻️ *RE-ENTRY SIGNAL* ♻️\n${label} - Score: ${score}/11`
    : `🚨 *KOL SIGNAL DETECTED* 🚨\n${label} - Score: ${score}/11`;
  const mintR = token.renounced_mint === 1 ? "🟢" : "🔴";
  const freezeR = token.renounced_freeze_account === 1 ? "🟢" : "🔴";
  const rugPct = token.rug_ratio !== undefined ? `${(token.rug_ratio * 100).toFixed(0)}%` : "N/A";
  const wash = token.is_wash_trading ? "🔴 Yes" : "🟢 No";
  const devStatus = token.creator_token_status === "sell" ? "🔴 Sold"
    : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";
  const bundle = token.bundler_trader_amount_rate
    ? `${(token.bundler_trader_amount_rate * 100).toFixed(0)}%` : "N/A";
  const smartCount = token.smart_degen_count || 0;
  const kolCount = token.renowned_count || 0;

  const msg =
    `${alertHeader}\n` +
    `*$${symbol}*\n` +
    `├ \`${mint}\`\n` +
    `└ ⏱ ${age} | 👁 ${holders} holders\n\n` +
    `📊 *Token Details*\n` +
    `├ PRICE:   ${price}\n` +
    `├ MC:      ${fmt(mc)}\n` +
    `├ Vol 1h:  ${vol}\n` +
    `├ Liq:     ${liq}\n` +
    `└ 1h Chg:  ${changeStr}\n\n` +
    `🧠 *Smart Signals*\n` +
    `├ Smart Money: ${smartCount} 🤖\n` +
    `└ KOL Holders: ${kolCount} 👑\n\n` +
    `🔒 *Security*\n` +
    `├ Dev S:       ${devStatus}\n` +
    `├ Mint Rncd:   ${mintR}\n` +
    `├ Freeze Rncd: ${freezeR}\n` +
    `├ Rug Ratio:   ${rugPct}\n` +
    `├ Wash Trade:  ${wash}\n` +
    `└ Bundle:      ${bundle}\n\n` +
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
        { text: "❌ Skip", callback_data: `skip_${mint.slice(0,20)}` }
      ]
    ]
  };

  await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
  log(`🚨 KOL: $${symbol} Score:${score} Smart:${smartCount} KOL:${kolCount} MC:${fmt(mc)}`);
}

// ─── SEND PUMPFUN PRE-BOND ALERT ──────────────────────────────────────────────
async function sendPumpAlert(token) {
  const mint = token.address;
  const symbol = token.symbol || "???";
  const progress = token.progress || 0;
  const progressBar = "█".repeat(Math.floor(progress / 10)) + "░".repeat(10 - Math.floor(progress / 10));
  const holders = token.holder_count || token.holders || "N/A";
  const vol = fmt(token.volume || token.volume_24h || 0);
  const mc = fmt(token.market_cap || token.usd_market_cap || 0);
  const price = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const age = fmtAge(token.open_timestamp ? token.open_timestamp * 1000 : token.created_timestamp ? token.created_timestamp * 1000 : null);
  const smartCount = token.smart_degen_count || 0;
  const kolCount = token.renowned_count || 0;
  const rug = token.rug_ratio !== undefined ? `${(token.rug_ratio * 100).toFixed(0)}%` : "N/A";
  const devStatus = token.creator_token_status === "sell" ? "🔴 Sold"
    : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";

  const urgency = progress >= 90 ? "🔴 MIGRATING SOON" : progress >= 75 ? "🟡 FILLING FAST" : "🟢 EARLY";

  const msg =
    `🎯 *PUMPFUN PRE-BOND ALERT* 🎯\n` +
    `${urgency}\n\n` +
    `*$${symbol}*\n` +
    `├ \`${mint}\`\n` +
    `└ ⏱ ${age} | 👁 ${holders} holders\n\n` +
    `🏦 *Bonding Curve*\n` +
    `├ Progress: [${progressBar}] ${progress.toFixed(1)}%\n` +
    `└ Status: ${progress >= 90 ? "🚨 Almost migrating!" : "Still on PumpFun"}\n\n` +
    `📊 *Token Details*\n` +
    `├ PRICE:  ${price}\n` +
    `├ MC:     ${mc}\n` +
    `└ Vol:    ${vol}\n\n` +
    `🧠 *Smart Signals*\n` +
    `├ Smart Money: ${smartCount} 🤖\n` +
    `└ KOL Holders: ${kolCount} 👑\n\n` +
    `🔒 *Security*\n` +
    `├ Dev S:     ${devStatus}\n` +
    `└ Rug Ratio: ${rug}\n\n` +
    `⚡ *Buy before migration to Raydium!*\n` +
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
        { text: "❌ Skip", callback_data: `skip_${mint.slice(0,20)}` }
      ]
    ]
  };

  await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
  log(`🎯 PUMP: $${symbol} Progress:${progress.toFixed(1)}% Vol:${vol}`);
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scan() {
  log("🔍 Scanning KOL signals + PumpFun pre-bond...");

  const [kolTokens, pumpTokens] = await Promise.all([
    getKOLSignals(),
    getPumpFunPrebond(),
  ]);

  log(`KOL signals: ${kolTokens.length} | PumpFun pre-bond: ${pumpTokens.length}`);

  // Send KOL alerts
  for (const token of kolTokens) {
    const mint = token.address;
    const lastAlert = alerted.get(mint);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;
    alerted.set(mint, Date.now());
    await sendKOLAlert(token);
    await new Promise(r => setTimeout(r, 1500));
  }

  // Send PumpFun alerts
  for (const token of pumpTokens) {
    const mint = token.address;
    const lastAlert = alerted.get(`pump_${mint}`);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;
    alerted.set(`pump_${mint}`, Date.now());
    await sendPumpAlert(token);
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("🤖 KOL Tracker v8 — KOL + PumpFun Pre-Bond");

  await bot.sendMessage(CHAT_ID,
    `🟢 KOL Tracker Bot v8 Online\n\n` +
    `Dual Alert System Active\n\n` +
    `1. KOL Signal Alerts\n` +
    `- smart_degen >= 1 + KOL >= 1\n` +
    `- rug < 30% + no wash trading\n` +
    `- MC: $15K - $150K\n\n` +
    `2. PumpFun Pre-Bond Alerts\n` +
    `- Bonding curve 60-98% filled\n` +
    `- Volume > $20K\n` +
    `- Holders > 100\n` +
    `- Sorted by highest volume\n\n` +
    `Scan every 20s\n` +
    `Trojan buy button on every alert`
  );

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
