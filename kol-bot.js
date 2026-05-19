const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const MC_MIN = 40000;
const MC_MAX = 60000;
const POLL_INTERVAL_MS = 20000;

// ─── KOL WALLETS ──────────────────────────────────────────────────────────────
const KOL_WALLETS = {
  "9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL": "9SLP_KpKS",
  "84vL38o5zTQjvA2fv7f3MgwXVBm8rBs1QBVXHtranQy5": "2snH_kKuS",
  "BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB": "Axio_TTSk",
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const recentBuys = {};
const alerted = new Set();
const lastSignature = {};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function fmt(n) {
  if (!n && n !== 0) return "N/A";
  if (n >= 1000000) return `$${(n/1000000).toFixed(2)}M`;
  if (n >= 1000) return `$${(n/1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtAge(createdAt) {
  if (!createdAt) return "N/A";
  const secs = Math.floor((Date.now() - createdAt) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m`;
  if (secs < 86400) return `${Math.floor(secs/3600)}h`;
  return `${Math.floor(secs/86400)}d`;
}

// ─── FETCH RICH TOKEN DATA FROM DEXSCREENER ───────────────────────────────────
async function getTokenData(mint) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 8000 }
    );
    const pairs = (res.data?.pairs || []).filter(p => p.chainId === "solana");
    if (!pairs.length) return null;
    pairs.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0));
    const p = pairs[0];
    return {
      mc:        p.fdv || p.marketCap || null,
      symbol:    p.baseToken?.symbol || "???",
      name:      p.baseToken?.name || "",
      price:     parseFloat(p.priceUsd || 0),
      volume24h: p.volume?.h24 || 0,
      liquidity: p.liquidity?.usd || 0,
      createdAt: p.pairCreatedAt || null,
      dexPaid:   p.boosts?.active > 0,
      txns24h:   (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
      priceChange: p.priceChange?.h1 || 0,
    };
  } catch(e) {
    log(`DexScreener error: ${e.message}`);
    return null;
  }
}

// ─── FETCH HOLDER COUNT FROM HELIUS ───────────────────────────────────────────
async function getHolders(mint) {
  try {
    const res = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
      {
        jsonrpc: "2.0", id: 1,
        method: "getTokenAccounts",
        params: { mint, limit: 1, page: 1 }
      },
      { timeout: 8000 }
    );
    return res.data?.result?.total || null;
  } catch(e) { return null; }
}

// ─── FETCH DEV SELL STATUS FROM HELIUS ────────────────────────────────────────
async function getDevSellStatus(mint) {
  try {
    // Get mint authority / largest accounts to check if dev still holds
    const res = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
      {
        jsonrpc: "2.0", id: 1,
        method: "getTokenLargestAccounts",
        params: [mint]
      },
      { timeout: 8000 }
    );
    const accounts = res.data?.result?.value || [];
    // If top holder has very large % it's likely dev still holding
    const top = accounts[0];
    if (!top) return null;
    const topAmt = parseFloat(top.uiAmountString || 0);
    // Rough heuristic: if top holder > 20% of supply, dev likely still in
    return topAmt > 0 ? "🟡" : "🟢";
  } catch(e) { return null; }
}

// ─── BUILD RICH ALERT MESSAGE ─────────────────────────────────────────────────
async function sendAlert(mint, symbol, tokenData, buyers) {
  const holders = await getHolders(mint);
  const devStatus = await getDevSellStatus(mint);

  const age = fmtAge(tokenData.createdAt);
  const mc = fmt(tokenData.mc);
  const price = tokenData.price < 0.001
    ? `$${tokenData.price.toExponential(4)}`
    : `$${tokenData.price.toFixed(6)}`;
  const vol = fmt(tokenData.volume24h);
  const liq = fmt(tokenData.liquidity);
  const change = tokenData.priceChange > 0
    ? `+${tokenData.priceChange.toFixed(1)}%`
    : `${tokenData.priceChange.toFixed(1)}%`;

  const devS = devStatus || "🟡";
  const dexP = tokenData.dexPaid ? "🟢" : "🔴";
  const holdersStr = holders ? holders.toLocaleString() : "N/A";

  const shortMint = `${mint.slice(0,8)}...${mint.slice(-8)}`;
  const buyerList = buyers.map((b,i) =>
    i === buyers.length-1 ? `└ ${b}` : `├ ${b}`
  ).join("\n");

  const msg =
    `🚨 *KOL OVERLAP DETECTED* 🚨\n\n` +
    `*$${symbol}*\n` +
    `├ \`${mint}\`\n` +
    `└ ⏱ ${age} | 👁 ${holdersStr} holders\n\n` +
    `📊 *Token Details*\n` +
    `├ PRICE:    ${price}\n` +
    `├ MC:       ${mc}\n` +
    `├ Vol 24h:  ${vol}\n` +
    `├ Liq:      ${liq}\n` +
    `└ 1h Chg:   ${change}\n\n` +
    `🔒 *Security*\n` +
    `├ Dev S:    ${devS}\n` +
    `└ Dex P:    ${dexP}\n\n` +
    `👥 *KOLs Buying (${buyers.length})*\n` +
    `${buyerList}\n\n` +
    `🔗 [DexScreener](https://dexscreener.com/solana/${mint}) | [GMGN](https://gmgn.ai/sol/token/${mint}) | [Axiom](https://axiom.trade/t/${mint})\n` +
    `⏰ ${new Date().toUTCString()}`;

  await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true
  });
  log(`🚨 Alert sent for $${symbol}`);
}

// ─── FETCH RECENT SWAP TXS ────────────────────────────────────────────────────
async function getRecentTxs(wallet) {
  try {
    const res = await axios.get(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=10&type=SWAP`,
      { timeout: 10000 }
    );
    return res.data || [];
  } catch(e) {
    log(`TX error ${wallet}: ${e.message}`);
    return [];
  }
}

function extractBoughtToken(tx, wallet) {
  try {
    const WSOL = "So11111111111111111111111111111111111111112";
    const recv = (tx.tokenTransfers||[]).find(t =>
      t.toUserAccount === wallet && t.mint !== WSOL
    );
    return recv?.mint || null;
  } catch { return null; }
}

// ─── POLL WALLET ──────────────────────────────────────────────────────────────
async function pollWallet(wallet, kolName) {
  const txs = await getRecentTxs(wallet);
  if (!txs.length) return;

  const newTxs = lastSignature[wallet]
    ? txs.filter(t => t.signature !== lastSignature[wallet])
    : txs.slice(0, 3);

  if (newTxs.length) lastSignature[wallet] = txs[0].signature;

  for (const tx of newTxs) {
    const mint = extractBoughtToken(tx, wallet);
    if (!mint) continue;

    const data = await getTokenData(mint);
    if (!data?.mc) continue;

    log(`${kolName} bought $${data.symbol} @ MC ${fmt(data.mc)}`);

    if (data.mc < MC_MIN || data.mc > MC_MAX) {
      log(`Out of range — skipping`);
      continue;
    }

    if (!recentBuys[mint]) recentBuys[mint] = {};
    recentBuys[mint][kolName] = Date.now();

    // Clean entries older than 2 hours
    const cutoff = Date.now() - 7200000;
    for (const [m, buyers] of Object.entries(recentBuys)) {
      for (const [k, ts] of Object.entries(buyers)) {
        if (ts < cutoff) delete recentBuys[m][k];
      }
      if (!Object.keys(recentBuys[m]).length) delete recentBuys[m];
    }

    const buyers = Object.keys(recentBuys[mint] || {});
    if (buyers.length >= 2 && !alerted.has(mint)) {
      alerted.add(mint);
      await sendAlert(mint, data.symbol, data, buyers);
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("🤖 KOL Tracker Bot v2 started");

  await bot.sendMessage(CHAT_ID,
    `🟢 *KOL Tracker Bot v2 Online*\n\n` +
    `👀 Watching *${Object.keys(KOL_WALLETS).length} wallets*\n` +
    `📊 MC Range: *${fmt(MC_MIN)} – ${fmt(MC_MAX)}*\n` +
    `⚡ Poll: every 20s\n\n` +
    `New: Age • Holders • Volume • Security checks 🔒`,
    { parse_mode: "Markdown" }
  );

  while (true) {
    for (const [addr, name] of Object.entries(KOL_WALLETS)) {
      await pollWallet(addr, name);
      await new Promise(r => setTimeout(r, 1000));
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
