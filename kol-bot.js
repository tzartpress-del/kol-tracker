const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const MC_MIN = 40000;
const MC_MAX = 60000;
const POLL_INTERVAL_MS = 20000;

const KOL_WALLETS = {
  "9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL": "9SLP_KpKS",
  "84vL38o5zTQjvA2fv7f3MgwXVBm8rBs1QBVXHtranQy5": "2snH_kKuS",
  "BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB": "Axio_TTSk",
};

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const recentBuys = {};
const alerted = new Set();
const lastSignature = {};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function sendAlert(tokenMint, tokenSymbol, mc, buyers) {
  const mcF = `$${(mc/1000).toFixed(1)}K`;
  const msg =
    `🚨 *KOL OVERLAP DETECTED*\n\n` +
    `🪙 Token: *${tokenSymbol}*\n` +
    `📊 MC: *${mcF}*\n` +
    `👥 KOLs Buying:\n${buyers.map(b=>`• ${b}`).join("\n")}\n\n` +
    `🔗 [DexScreener](https://dexscreener.com/solana/${tokenMint}) | [GMGN](https://gmgn.ai/sol/token/${tokenMint})\n` +
    `⏰ ${new Date().toUTCString()}`;
  await bot.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
  log(`Alert sent for ${tokenSymbol}`);
}

async function getRecentTxs(wallet) {
  try {
    const res = await axios.get(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=10&type=SWAP`,
      { timeout: 10000 }
    );
    return res.data || [];
  } catch(e) { log(`TX error ${wallet}: ${e.message}`); return []; }
}

async function getTokenMC(mint) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 8000 });
    const pairs = (res.data?.pairs || []).filter(p => p.chainId === "solana");
    if (!pairs.length) return null;
    pairs.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0));
    const p = pairs[0];
    return { mc: p.fdv || p.marketCap || null, symbol: p.baseToken?.symbol || "???" };
  } catch(e) { return null; }
}

function extractBoughtToken(tx, wallet) {
  try {
    const WSOL = "So11111111111111111111111111111111111111112";
    const recv = (tx.tokenTransfers||[]).find(t => t.toUserAccount===wallet && t.mint!==WSOL);
    return recv?.mint || null;
  } catch { return null; }
}

async function pollWallet(wallet, kolName) {
  const txs = await getRecentTxs(wallet);
  if (!txs.length) return;
  const newTxs = lastSignature[wallet]
    ? txs.filter(t => t.signature !== lastSignature[wallet])
    : txs.slice(0,3);
  if (newTxs.length) lastSignature[wallet] = txs[0].signature;
  for (const tx of newTxs) {
    const mint = extractBoughtToken(tx, wallet);
    if (!mint) continue;
    const data = await getTokenMC(mint);
    if (!data?.mc) continue;
    log(`${kolName} bought ${data.symbol} @ $${data.mc}`);
    if (data.mc < MC_MIN || data.mc > MC_MAX) continue;
    if (!recentBuys[mint]) recentBuys[mint] = {};
    recentBuys[mint][kolName] = Date.now();
    const twoHrsAgo = Date.now() - 7200000;
    for (const [m, buyers] of Object.entries(recentBuys)) {
      for (const [k, ts] of Object.entries(buyers)) {
        if (ts < twoHrsAgo) delete recentBuys[m][k];
      }
      if (!Object.keys(recentBuys[m]).length) delete recentBuys[m];
    }
    const buyers = Object.keys(recentBuys[mint]||{});
    if (buyers.length >= 2 && !alerted.has(mint)) {
      alerted.add(mint);
      await sendAlert(mint, data.symbol, data.mc, buyers);
    }
  }
}

async function main() {
  log("🤖 KOL Tracker started");
  await bot.sendMessage(CHAT_ID,
    `🟢 *KOL Tracker Bot Online*\n👀 Watching *3 wallets*\n📊 MC: *$40K–$60K*\n⚡ Every 20s`,
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
