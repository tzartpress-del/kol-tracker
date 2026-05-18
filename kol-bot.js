const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const crypto = require("crypto");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GMGN_API_KEY = process.env.GMGN_API_KEY;
const GMGN_PRIVATE_KEY = process.env.GMGN_PRIVATE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// ─── SIGNAL FILTERS (GMGN recommended) ───────────────────────────────────────
const MC_MIN = 15000;
const MC_MAX = 150000;
const MIN_SMART_DEGEN = 1;      // at least 1 smart money wallet
const MIN_RENOWNED = 1;         // at least 1 KOL
const MAX_RUG_RATIO = 0.2;      // max 20% rug ratio
const MIN_LIQUIDITY = 10000;    // min $10K liquidity
const POLL_INTERVAL_MS = 20000; // scan every 20s
const ALERT_COOLDOWN_MS = 3600000; // 1hr cooldown per token

// ─── TOP TRADER WALLETS ───────────────────────────────────────────────────────
const TOP_TRADER_WALLETS = {
  "9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL": "9SLP_KpKS",
  "84vL38o5zTQjvA2fv7f3MgwXVBm8rBs1QBVXHtranQy5": "2snH_kKuS",
  "BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB": "Axio_TTSk",
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const alerted = new Map();
const lastSignature = {};
const recentBuys = {};

// Handle Skip button
bot.on("callback_query", async (query) => {
  if (query.data?.startsWith("skip_")) {
    await bot.answerCallbackQuery(query.id, { text: "⏭ Skipped!" });
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: "❌ Skipped", callback_data: "done" }]] },
      { chat_id: query.message.chat.id, message_id: query.message.message_id }
    );
  }
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

function signalScore(token) {
  let score = 0;
  if ((token.smart_degen_count || 0) >= 3) score += 3;
  else if ((token.smart_degen_count || 0) >= 2) score += 2;
  else if ((token.smart_degen_count || 0) >= 1) score += 1;
  if ((token.renowned_count || 0) >= 2) score += 2;
  else if ((token.renowned_count || 0) >= 1) score += 1;
  if ((token.rug_ratio || 1) < 0.1) score += 2;
  else if ((token.rug_ratio || 1) < 0.2) score += 1;
  if (token.renounced_mint === 1) score += 1;
  if (token.renounced_freeze_account === 1) score += 1;
  if (!token.is_wash_trading) score += 1;
  return score;
}

function signalLabel(score) {
  if (score >= 8) return "🔥 ULTRA HIGH";
  if (score >= 6) return "⚡ HIGH";
  if (score >= 4) return "✅ MEDIUM";
  return "🟡 LOW";
}

// ─── GMGN TRENDING SCAN ───────────────────────────────────────────────────────
async function getTrendingTokens() {
  try {
    const url = `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=100`;
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      timeout: 10000
    });
    const tokens = res.data?.data?.rank || [];
    return tokens.filter(t => {
      const mc = t.market_cap || 0;
      const smart = t.smart_degen_count || 0;
      const kol = t.renowned_count || 0;
      const rug = t.rug_ratio || 0;
      const liq = t.liquidity || 0;
      const wash = t.is_wash_trading || false;
      return (
        mc >= MC_MIN && mc <= MC_MAX &&
        smart >= MIN_SMART_DEGEN &&
        kol >= MIN_RENOWNED &&
        rug < MAX_RUG_RATIO &&
        liq >= MIN_LIQUIDITY &&
        !wash
      );
    });
  } catch(e) {
    log(`Trending error: ${e.message}`);
    return [];
  }
}

// ─── SEND ALERT ───────────────────────────────────────────────────────────────
async function sendAlert(token, extraBuyers = []) {
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

  // Signal score
  const score = signalScore(token);
  const label = signalLabel(score);

  // Security
  const mintR = token.renounced_mint === 1 ? "🟢" : "🔴";
  const freezeR = token.renounced_freeze_account === 1 ? "🟢" : "🔴";
  const rugR = token.rug_ratio !== undefined ? `${(token.rug_ratio * 100).toFixed(0)}%` : "N/A";
  const wash = token.is_wash_trading ? "🔴 Yes" : "🟢 No";
  const devStatus = token.creator_token_status === "sell" ? "🔴 Sold"
    : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";
  const bundle = token.bundler_trader_amount_rate
    ? `${(token.bundler_trader_amount_rate * 100).toFixed(0)}%` : "N/A";

  // Smart money + KOL counts
  const smartCount = token.smart_degen_count || 0;
  const kolCount = token.renowned_count || 0;

  // Extra buyers from wallet tracking
  const extraStr = extraBuyers.length > 0
    ? `\n\n👛 *Tracked Wallets Buying*\n${extraBuyers.map((b,i) =>
        `${i === extraBuyers.length-1 ? "└" : "├"} ${b}`).join("\n")}`
    : "";

  const msg =
    `🚨 *SIGNAL DETECTED* 🚨\n` +
    `${label} — Score: ${score}/11\n\n` +
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
    `├ Smart Money: ${smartCount} wallet${smartCount !== 1 ? "s" : ""} 🤖\n` +
    `└ KOL Holders: ${kolCount} wallet${kolCount !== 1 ? "s" : ""} 👑\n\n` +
    `🔒 *Security*\n` +
    `├ Dev S:       ${devStatus}\n` +
    `├ Mint Rncd:   ${mintR}\n` +
    `├ Freeze Rncd: ${freezeR}\n` +
    `├ Rug Ratio:   ${rugR}\n` +
    `├ Wash Trade:  ${wash}\n` +
    `└ Bundle:      ${bundle}\n` +
    `${extraStr}\n\n` +
    `💰 *Snipe 0.1 SOL?*\n` +
    `⏰ ${new Date().toUTCString()}`;

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
  log(`🚨 Alert: $${symbol} | Score: ${score} | Smart: ${smartCount} | KOL: ${kolCount}`);
}

// ─── WALLET POLLING ───────────────────────────────────────────────────────────
async function getRecentTxs(wallet) {
  try {
    const res = await axios.get(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=10&type=SWAP`,
      { timeout: 10000 }
    );
    return res.data || [];
  } catch(e) { return []; }
}

function extractBoughtToken(tx, wallet) {
  try {
    const WSOL = "So11111111111111111111111111111111111111112";
    const recv = (tx.tokenTransfers||[]).find(t => t.toUserAccount===wallet && t.mint!==WSOL);
    return recv?.mint || null;
  } catch { return null; }
}

async function pollWallets() {
  for (const [wallet, name] of Object.entries(TOP_TRADER_WALLETS)) {
    const txs = await getRecentTxs(wallet);
    if (!txs.length) continue;
    const newTxs = lastSignature[wallet]
      ? txs.filter(t => t.signature !== lastSignature[wallet])
      : txs.slice(0, 3);
    if (newTxs.length) lastSignature[wallet] = txs[0].signature;

    for (const tx of newTxs) {
      const mint = extractBoughtToken(tx, wallet);
      if (!mint) continue;
      if (!recentBuys[mint]) recentBuys[mint] = {};
      recentBuys[mint][name] = Date.now();
      log(`👛 ${name} bought ${mint.slice(0,8)}...`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scan() {
  log("🔍 Scanning...");

  // Poll wallets in background
  pollWallets().catch(e => log(`Wallet poll error: ${e.message}`));

  // Get GMGN signals
  const tokens = await getTrendingTokens();
  log(`Found ${tokens.length} qualifying tokens`);

  for (const token of tokens) {
    const mint = token.address;
    const lastAlert = alerted.get(mint);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;

    // Check if any tracked wallets also bought this
    const cutoff = Date.now() - 7200000;
    const walletBuyers = Object.entries(recentBuys[mint] || {})
      .filter(([, ts]) => ts > cutoff)
      .map(([name]) => name);

    alerted.set(mint, Date.now());
    await sendAlert(token, walletBuyers);
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("🤖 KOL Tracker v6 starting...");

  await bot.sendMessage(CHAT_ID,
    `🟢 *KOL Tracker Bot v6 Online*\n\n` +
    `🧠 *Smart Signal Mode*\n` +
    `├ ✅ smart_degen ≥ 1 + KOL ≥ 1\n` +
    `├ ✅ rug_ratio < 20%\n` +
    `├ ✅ wash trading filter\n` +
    `├ ✅ liquidity > $10K\n` +
    `├ ✅ MC: $15K – $150K\n` +
    `├ 👛 Watching ${Object.keys(TOP_TRADER_WALLETS).length} wallets\n` +
    `└ ⚡ Scan every 20s\n\n` +
    `🚀 Trojan snipe button on every alert\n` +
    `📊 Signal score 1–11 on every alert`,
    { parse_mode: "Markdown" }
  );

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
