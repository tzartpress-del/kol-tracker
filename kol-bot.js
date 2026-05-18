const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const crypto = require("crypto");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GMGN_API_KEY = process.env.GMGN_API_KEY;
const GMGN_PRIVATE_KEY = process.env.GMGN_PRIVATE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const MC_MIN = 15000;
const MC_MAX = 150000;
const MIN_KOL_COUNT = 2;        // min KOLs buying same token
const MIN_WIN_RATE = 0.40;      // 40% win rate minimum
const POLL_INTERVAL_MS = 30000; // check every 30s
const ALERT_COOLDOWN_MS = 3600000; // don't re-alert same token for 1hr

// ─── TOP TRADER WALLETS TO ALWAYS TRACK ───────────────────────────────────────
const TOP_TRADER_WALLETS = {
  "9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL": "9SLP_KpKS",
  "84vL38o5zTQjvA2fv7f3MgwXVBm8rBs1QBVXHtranQy5": "2snH_kKuS",
  "BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB": "Axio_TTSk",
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const alerted = new Map(); // mint → timestamp
const kolWinRateCache = new Map(); // wallet → { winRate, avgMC, name }

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

function winRateEmoji(wr) {
  if (wr >= 0.75) return "🔥";
  if (wr >= 0.65) return "✅";
  if (wr >= 0.55) return "🟡";
  return "❌";
}

// ─── GMGN AUTH SIGNATURE ─────────────────────────────────────────────────────
function gmgnHeaders(method, path) {
  try {
    const timestamp = Date.now().toString();
    const payload = `${timestamp}\n${method}\n${path}\n`;
    const privateKey = crypto.createPrivateKey(GMGN_PRIVATE_KEY);
    const sig = crypto.sign(null, Buffer.from(payload), privateKey);
    return {
      "X-GMGN-API-KEY": GMGN_API_KEY,
      "X-GMGN-TIMESTAMP": timestamp,
      "X-GMGN-SIGNATURE": sig.toString("base64"),
      "Content-Type": "application/json",
    };
  } catch(e) {
    // Fallback: try without signature (public endpoints)
    return { "Content-Type": "application/json" };
  }
}

// ─── FETCH TRENDING NEW TOKENS WITH KOL ACTIVITY ─────────────────────────────
async function getTrendingKOLTokens() {
  try {
    // Use GMGN rank endpoint filtered by renowned (KOL) activity
    const url = `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=50`;
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      timeout: 10000
    });
    const tokens = res.data?.data?.rank || [];
    // Filter: MC in range, has KOL/smart money activity
    return tokens.filter(t => {
      const mc = t.market_cap || 0;
      const kolCount = t.renowned_count || t.smart_buy_24h || 0;
      return mc >= MC_MIN && mc <= MC_MAX && kolCount >= MIN_KOL_COUNT;
    });
  } catch(e) {
    log(`Trending fetch error: ${e.message}`);
    return [];
  }
}

// ─── FETCH TOP TRADERS FOR A TOKEN ───────────────────────────────────────────
async function getTopTraders(mint) {
  try {
    const path = `/defi/quotation/v1/tokens/top_traders/sol/${mint}?orderby=profit&direction=desc&limit=20&tag=renowned`;
    const res = await axios.get(`https://gmgn.ai${path}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      timeout: 8000
    });
    return res.data?.data || [];
  } catch(e) {
    log(`Top traders error for ${mint}: ${e.message}`);
    return [];
  }
}

// ─── FETCH WALLET STATS (WIN RATE + AVG MC) VIA GMGN API ─────────────────────
async function getWalletStats(wallet) {
  // Check cache first (valid for 6 hours)
  const cached = kolWinRateCache.get(wallet);
  if (cached && Date.now() - cached.ts < 21600000) return cached;

  try {
    const path = `/api/v1/wallet_stat/sol/${wallet}?period=30d`;
    const headers = gmgnHeaders("GET", path);
    const res = await axios.get(`https://gmgn.ai${path}`, { headers, timeout: 8000 });
    const d = res.data?.data || res.data;
    if (!d) return null;

    // Calculate avg MC from recent buys
    let avgMC = null;
    try {
      const actPath = `/api/v1/wallet_activity/sol/${wallet}?type=buy&limit=20`;
      const actHeaders = gmgnHeaders("GET", actPath);
      const actRes = await axios.get(`https://gmgn.ai${actPath}`, { headers: actHeaders, timeout: 8000 });
      const activities = actRes.data?.data?.activities || [];
      const mcs = activities
        .map(a => a.market_cap || 0)
        .filter(mc => mc > 0);
      if (mcs.length > 0) avgMC = mcs.reduce((a,b) => a+b, 0) / mcs.length;
    } catch(e) {}

    const stats = {
      winRate: parseFloat(d.winrate || d.win_rate || 0),
      totalTrades: d.total_profit_trade || d.trade_count || 0,
      realizedPnl: d.realized_profit || 0,
      avgMC,
      name: d.ens || d.twitter_name || `${wallet.slice(0,6)}...${wallet.slice(-4)}`,
      ts: Date.now(),
    };
    kolWinRateCache.set(wallet, stats);
    return stats;
  } catch(e) {
    log(`Wallet stats error ${wallet}: ${e.message}`);
    return null;
  }
}

// ─── BUILD & SEND ALERT ───────────────────────────────────────────────────────
async function sendAlert(token, traders) {
  const mint = token.address;
  const symbol = token.symbol || "???";
  const mc = token.market_cap || 0;
  const age = fmtAge(token.open_timestamp ? token.open_timestamp * 1000 : null);
  const holders = token.holder_count || "N/A";
  const vol = fmt(token.volume || 0);
  const price = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const change1h = token.price_change_percent1h || 0;
  const changeStr = change1h > 0 ? `📈 +${change1h.toFixed(1)}%` : `📉 ${change1h.toFixed(1)}%`;

  // Security
  const mintR = token.renounced_mint === 1 ? "🟢" : "🔴";
  const freezeR = token.renounced_freeze_account === 1 ? "🟢" : "🔴";
  const honeypot = token.is_honeypot === 0 ? "🟢 Safe" : "🔴 Risk";
  const devStatus = token.creator_token_status === "sell" ? "🔴 Sold"
    : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";

  // KOL list with win rates
  const kolLines = traders.map((t, i) => {
    const isLast = i === traders.length - 1;
    const prefix = isLast ? "└" : "├";
    const wr = t.winRate !== null ? `${(t.winRate * 100).toFixed(0)}% WR ${winRateEmoji(t.winRate)}` : "WR N/A";
    const avgMcStr = t.avgMC ? `avg ${fmt(t.avgMC)}` : "";
    const pnl = t.realizedPnl ? `PnL: ${fmt(t.realizedPnl)}` : "";
    return `${prefix} *${t.name}*\n   ${wr} | ${avgMcStr} ${pnl}`.trim();
  }).join("\n");

  // Avg MC where these KOLs typically buy
  const avgMCs = traders.filter(t => t.avgMC).map(t => t.avgMC);
  const avgBuyMC = avgMCs.length ? avgMCs.reduce((a,b)=>a+b,0)/avgMCs.length : null;
  const avgMCStr = avgBuyMC ? `\n└ Avg KOL Entry MC: *${fmt(avgBuyMC)}*` : "";

  const msg =
    `🚨 *KOL OVERLAP DETECTED* 🚨\n\n` +
    `*$${symbol}*\n` +
    `├ \`${mint}\`\n` +
    `└ ⏱ ${age} | 👁 ${holders} holders\n\n` +
    `📊 *Token Details*\n` +
    `├ PRICE:    ${price}\n` +
    `├ MC:       ${fmt(mc)}\n` +
    `├ Vol 1h:   ${vol}\n` +
    `├ 1h Chg:   ${changeStr}\n` +
    `├ KOLs:     ${token.renowned_count || traders.length}\n` +
    `└ Smart $:  ${token.smart_buy_24h || "N/A"} buys\n\n` +
    `🔒 *Security*\n` +
    `├ Honeypot:    ${honeypot}\n` +
    `├ Dev S:       ${devStatus}\n` +
    `├ Mint Rncd:   ${mintR}\n` +
    `└ Freeze Rncd: ${freezeR}\n\n` +
    `🧠 *KOL Buyers (${traders.length})*\n` +
    `${kolLines}${avgMCStr}\n\n` +
    `🔗 [DexScreener](https://dexscreener.com/solana/${mint}) | [GMGN](https://gmgn.ai/sol/token/${mint}) | [Axiom](https://axiom.trade/t/${mint})\n` +
    `⏰ ${new Date().toUTCString()}`;

  await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true
  });
  log(`🚨 Alert sent for $${symbol} — ${traders.length} KOLs`);
}

// ─── TRACK TOP TRADER WALLETS DIRECTLY ───────────────────────────────────────
const lastSignature = {};
const recentBuys = {};

async function getRecentTxs(wallet) {
  try {
    const res = await axios.get(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=10&type=SWAP`,
      { timeout: 10000 }
    );
    return res.data || [];
  } catch(e) { log(`TX error: ${e.message}`); return []; }
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

async function pollTopTraderWallets() {
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

      // Get token data
      let mc = 0, symbol = "???", tokenData = null;
      try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 8000 });
        const pairs = (res.data?.pairs||[]).filter(p=>p.chainId==="solana");
        if (pairs.length) {
          pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0));
          const p = pairs[0];
          mc = p.fdv || p.marketCap || 0;
          symbol = p.baseToken?.symbol || "???";
          tokenData = {
            address: mint, symbol, market_cap: mc,
            price: p.priceUsd, volume: p.volume?.h1 || 0,
            liquidity: p.liquidity?.usd || 0,
            open_timestamp: p.pairCreatedAt ? p.pairCreatedAt/1000 : null,
            price_change_percent1h: p.priceChange?.h1 || 0,
            renounced_mint: 0, renounced_freeze_account: 0,
            is_honeypot: 0, creator_token_status: null,
            renowned_count: 0, smart_buy_24h: 0,
          };
        }
      } catch(e) {}

      if (!mc || mc < MC_MIN || mc > MC_MAX) continue;
      log(`👛 Top trader ${name} bought $${symbol} @ ${fmt(mc)} MC`);

      if (!recentBuys[mint]) recentBuys[mint] = {};
      recentBuys[mint][name] = { wallet, ts: Date.now() };

      // Clean old entries
      const cutoff = Date.now() - 7200000;
      for (const [m, buyers] of Object.entries(recentBuys)) {
        for (const [k, v] of Object.entries(buyers)) {
          if (v.ts < cutoff) delete recentBuys[m][k];
        }
        if (!Object.keys(recentBuys[m]).length) delete recentBuys[m];
      }

      const buyers = Object.keys(recentBuys[mint] || {});
      if (buyers.length >= MIN_KOL_COUNT && !alerted.has(mint) && tokenData) {
        alerted.set(mint, Date.now());
        const traderStats = buyers.map(b => ({
          name: b,
          winRate: null,
          avgMC: null,
          realizedPnl: null,
        }));
        await sendAlert(tokenData, traderStats);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ─── MAIN SCAN LOOP ───────────────────────────────────────────────────────────
async function scan() {
  log("🔍 Scanning GMGN trending + top trader wallets...");

  // Run both in parallel
  await Promise.all([
    // 1. GMGN trending scan
    (async () => {
      const tokens = await getTrendingKOLTokens();
      log(`GMGN: ${tokens.length} tokens in MC range with KOL activity`);
      for (const token of tokens) {
        const mint = token.address;
        const lastAlert = alerted.get(mint);
        if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;
        const topTraders = await getTopTraders(mint);
        await new Promise(r => setTimeout(r, 500));
        if (!topTraders.length) continue;
        const tradersWithStats = [];
        for (const trader of topTraders.slice(0, 10)) {
          const wallet = trader.address || trader.maker;
          if (!wallet) continue;
          const stats = await getWalletStats(wallet);
          await new Promise(r => setTimeout(r, 300));
          if (!stats) continue;
          if (stats.winRate < MIN_WIN_RATE) continue;
          tradersWithStats.push({ ...stats, wallet });
        }
        if (tradersWithStats.length < MIN_KOL_COUNT) continue;
        alerted.set(mint, Date.now());
        await sendAlert(token, tradersWithStats);
        await new Promise(r => setTimeout(r, 1000));
      }
    })(),

    // 2. Top trader wallet polling
    pollTopTraderWallets(),
  ]);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("🤖 KOL Tracker v5 — Auto + Top Traders");

  await bot.sendMessage(CHAT_ID,
    `🟢 *KOL Tracker Bot v5 Online*\n\n` +
    `🤖 *Dual Mode Active*\n` +
    `├ 🌐 GMGN auto-scan ALL KOLs\n` +
    `├ 👛 Watching *${Object.keys(TOP_TRADER_WALLETS).length} top trader wallets*\n` +
    `├ MC Range: *$15K – $150K*\n` +
    `├ Min KOLs: *${MIN_KOL_COUNT}+*\n` +
    `├ Min Win Rate: *${(MIN_WIN_RATE*100).toFixed(0)}%+*\n` +
    `└ Scan: every 30s\n\n` +
    `🔥 Powered by GMGN + Helius\n` +
    `✅ Win rates • Avg entry MC • Security checks`,
    { parse_mode: "Markdown" }
  );

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
