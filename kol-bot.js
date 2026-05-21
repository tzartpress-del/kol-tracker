const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const http  = require("http");
const https = require("https");
const dns   = require("dns");

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// Force IPv4 globally
dns.setDefaultResultOrder("ipv4first");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const GMGN_API_KEY   = process.env.GMGN_API_KEY;

// ─── FILTERS ─────────────────────────────────────────────────────────────────
const MC_MIN             = 15000;
const MC_MAX             = 150000;
const POLL_INTERVAL_MS   = 90000;  // 90s — safer polling
const ALERT_COOLDOWN_MS  = 3600000;
const MAX_AGE_MS         = 24 * 60 * 60 * 1000;
const REENTRY_MIN_VEL    = 1.5;
const REENTRY_MIN_VOL    = 50000;

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 },
  },
});
const alerted            = new Map();
const performanceTracker = new Map();
const insiderBuys        = {};
const lastSig            = {};
const blacklist          = new Set();
let lastGMGNCall         = 0;

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
      const s     = botStats;
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
        `Tracking: ${performanceTracker.size} tokens`,
        { parse_mode: "Markdown" }
      );
    }
  } catch(e) {}
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function fmt(n) {
  if (!n && n !== 0) return "N/A";
  if (n >= 1000000)  return `$${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000)     return `$${(n / 1000).toFixed(1)}K`;
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
  if (token.renounced_mint           === 1) s += 1;
  if (token.renounced_freeze_account === 1) s += 1;
  if (!token.is_wash_trading)               s += 1;
  return s;
}

function signalLabel(score) {
  if (score >= 8) return "🔥 ULTRA HIGH";
  if (score >= 6) return "⚡ HIGH";
  if (score >= 4) return "✅ MEDIUM";
  return "🟡 LOW";
}

// ─── GMGN API FETCH (SAFE VERSION) ───────────────────────────────────────────
const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

const axiosInstance = axios.create({
  httpsAgent: ipv4Agent,
  timeout: 20000,
  maxRedirects: 2,
  validateStatus: () => true,
  headers: {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
    "Referer": "https://gmgn.ai/",
  },
});

async function fetchGMGN(path) {
  const now  = Date.now();
  const wait = 1100 - (now - lastGMGNCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGMGNCall = Date.now();

  try {
    const res = await axiosInstance.get(
      `https://openapi.gmgn.ai${path}${path.includes("?") ? "&" : "?"}api_key=${GMGN_API_KEY || ""}`,
      { headers: { "x-api-key": GMGN_API_KEY || "" } }
    );

    if (res.status !== 200) {
      log(`GMGN bad status: ${res.status}`);
      return null;
    }
    if (typeof res.data === "string") {
      log("GMGN returned HTML instead of JSON");
      return null;
    }
    return res.data;
  } catch(e) {
    const status = e.response?.status;
    if (status === 429) {
      log("GMGN rate limited — waiting 10s");
      await new Promise(r => setTimeout(r, 10000));
    } else if (status === 403) {
      log("GMGN 403 — blocked");
    } else if (status === 404) {
      log("GMGN endpoint missing");
    } else {
      log(`GMGN error: ${e.message}`);
    }
    return null;
  }
}

// ─── INSIDER WALLETS (hardcoded) ─────────────────────────────────────────────
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
  const cutoff = Date.now() - 7200000;
  for (const [mint, buyers] of Object.entries(insiderBuys)) {
    for (const [k, ts] of Object.entries(buyers)) {
      if (ts < cutoff) delete insiderBuys[mint][k];
    }
    if (!Object.keys(insiderBuys[mint]).length) delete insiderBuys[mint];
  }
}

// ─── DYNAMIC SMART MONEY TRACKING ────────────────────────────────────────────
const smartMoneyBuys = {};

async function fetchSmartMoneyActivity() {
  try {
    const data = await fetchGMGN(`/defi/quotation/v1/smartmoney/sol?limit=100`);

    if (!data || typeof data !== "object") {
      log("Smart money: invalid response");
      return;
    }

    const trades = data?.data?.list || [];
    if (!Array.isArray(trades) || !trades.length) {
      log("Smart money: no trades");
      return;
    }

    log(`Smart money: ${trades.length} trades fetched`);
    const now = Date.now();

    for (const trade of trades) {
      const mint = trade.address || trade.base_address;
      if (!mint) continue;

      if (!smartMoneyBuys[mint]) {
        smartMoneyBuys[mint] = {
          symbol:   trade.symbol || trade.base_token?.symbol || "???",
          wallets:  new Set(),
          amounts:  [],
          lastSeen: now,
        };
      }
      smartMoneyBuys[mint].wallets.add(trade.wallet || trade.maker || "unknown");
      smartMoneyBuys[mint].amounts.push(trade.amount_usd || 0);
      smartMoneyBuys[mint].lastSeen = now;
    }

    // Cleanup entries older than 30 mins
    const cutoff = now - 1800000;
    for (const [mint, d] of Object.entries(smartMoneyBuys)) {
      if (d.lastSeen < cutoff) delete smartMoneyBuys[mint];
    }

    // Cluster signal — 3+ wallets buying same token
    for (const [mint, d] of Object.entries(smartMoneyBuys)) {
      if (d.wallets.size >= 3 && !alerted.has(`cluster_${mint}`)) {
        alerted.set(`cluster_${mint}`, Date.now());
        const totalUsd = d.amounts.reduce((a, b) => a + b, 0);
        log(`CLUSTER SIGNAL: $${d.symbol} — ${d.wallets.size} wallets — $${totalUsd.toFixed(0)}`);
        await sendClusterAlert(mint, d.symbol, d.wallets.size, totalUsd);
      }
    }
  } catch(e) {
    log(`Smart money error: ${e.message}`);
  }
}

// ─── CLUSTER SIGNAL ALERT ────────────────────────────────────────────────────
async function sendClusterAlert(mint, symbol, walletCount, totalUsd) {
  const strength =
    walletCount >= 5 ? "🔥🔥🔥 VERY STRONG" :
    walletCount >= 4 ? "🔥🔥 STRONG"         :
                       "🔥 MEDIUM";

  const msg =
    `⚡ *CLUSTER SIGNAL DETECTED* ⚡\n\n` +
    `${strength}\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n\n` +
    `👥 *${walletCount} Smart Money wallets* buying same token!\n` +
    `💵 Total volume: $${totalUsd.toFixed(0)}\n\n` +
    `This is a strong convergence signal!\n` +
    `Multiple whales entering simultaneously.\n\n` +
    `💰 *Snipe 0.1 SOL?*`;

  await bot.sendMessage(CHAT_ID, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 BUY via Trojan", url: `https://t.me/solana_trojanbot?start=ca_${mint}` }],
        [
          { text: "📊 DexScreener", url: `https://dexscreener.com/solana/${mint}` },
          { text: "🔍 GMGN",        url: `https://gmgn.ai/sol/token/${mint}`      },
        ],
        [{ text: "⚡ Axiom", url: `https://axiom.trade/t/${mint}` }],
      ],
    },
  });
  log(`Cluster alert sent: $${symbol} — ${walletCount} wallets`);
}

// ─── PERFORMANCE TRACKER ─────────────────────────────────────────────────────
async function getTokenPrice(mint) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 8000 }
    );
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
    peakX: 1,
    notified2x: false, notified5x: false, notified10x: false,
    notifiedDistribution: false,
  });
  const stats = botStats[signalType] || botStats.kol;

  const interval = setInterval(async () => {
    const tracker = performanceTracker.get(mint);
    if (!tracker) { clearInterval(interval); return; }

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

// ─── SCANNER: KOL + SMART MONEY ──────────────────────────────────────────────
async function getKOLSignals() {
  const results = [];
  try {
    const data = await fetchGMGN(
      `/defi/quotation/v1/rank/sol/swaps/1h?orderby=smart_degen_count&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=100`
    );
    const tokens = data?.data?.rank || [];
    for (const t of tokens) {
      if (!t.address)                       continue;
      const mc  = t.market_cap           || 0;
      const sm  = t.smart_degen_count    || 0;
      const kol = t.renowned_count       || 0;
      if (mc < MC_MIN || mc > MC_MAX)      continue;
      if (sm < 1 || kol < 1)              continue;
      if ((t.rug_ratio || 0) > 0.25)      continue;
      if (t.is_wash_trading)               continue;

      const ageMs    = t.open_timestamp ? Date.now() - t.open_timestamp * 1000 : null;
      const vol5m    = t.volume_5m || 0;
      const vol1h    = t.volume    || 0;
      const velocity = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
      const isNew    = ageMs !== null && ageMs <= MAX_AGE_MS;
      const hasSpike = velocity >= REENTRY_MIN_VEL || vol1h >= REENTRY_MIN_VOL;

      // Fresh tokens always pass — old tokens need a spike
      if (!isNew && !hasSpike) continue;

      results.push({ ...t, alertType: isNew ? "KOL" : "REENTRY" });
    }
  } catch(e) { log(`KOL error: ${e.message}`); }
  results.sort((a, b) => (b.smart_degen_count || 0) - (a.smart_degen_count || 0));
  return results.slice(0, 20);
}

// ─── SCANNER: PUMPFUN PRE-BOND ────────────────────────────────────────────────
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
      const volume   = t.volume       || 0;
      const holders  = t.holder_count || t.holders || 0;
      if (progress < 60 || progress > 98) continue;
      if (volume   < 20000)               continue;
      if (holders  < 100)                 continue;
      if ((t.rug_ratio || 0) > 0.3)       continue;
      if (t.is_wash_trading)              continue;
      results.push({ ...t, alertType: "PUMP", progress });
    }
  } catch(e) { log(`Pump error: ${e.message}`); }
  results.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  return results.slice(0, 10);
}

// ─── SCANNER: ULTRA EARLY ─────────────────────────────────────────────────────
async function getUltraSignals() {
  const results = [];
  try {
    const data = await fetchGMGN(
      `/defi/quotation/v1/rank/sol/pump?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`
    );
    const tokens = data?.data?.rank || [];
    for (const t of tokens) {
      if (!t.address) continue;
      const ageMs = t.open_timestamp ? Date.now() - t.open_timestamp * 1000 : null;
      if (!ageMs || ageMs > 30 * 60 * 1000) continue; // under 30 mins only
      const volume  = t.volume       || 0;
      const holders = t.holder_count || t.holders || 0;
      const buys    = t.buy_5m  || t.swaps_5m || 0;
      const sells   = t.sell_5m || 0;
      const ratio   = sells > 0 ? buys / sells : buys;
      if (volume  < 3000)  continue;
      if (holders < 30)    continue;
      if (ratio   < 2)     continue;
      if ((t.rug_ratio || 0) > 0.2) continue;
      if (t.is_wash_trading)        continue;
      results.push({ ...t, alertType: "ULTRA_EARLY", ageMs, buys, sells, buyRatio: ratio });
    }
  } catch(e) { log(`Ultra error: ${e.message}`); }
  results.sort((a, b) => b.buyRatio - a.buyRatio);
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
      [{ text: "❌ Skip", callback_data: `skip_${mint.slice(0, 20)}` }],
    ],
  };
}

// ─── SEND KOL ALERT ───────────────────────────────────────────────────────────
async function sendKOLAlert(token) {
  const mint       = token.address;
  const symbol     = token.symbol || "???";
  const mc         = token.market_cap || 0;
  const age        = fmtAge(token.open_timestamp ? token.open_timestamp * 1000 : null);
  const holders    = token.holder_count || "N/A";
  const price      = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const vol        = fmt(token.volume || 0);
  const liq        = fmt(token.liquidity || 0);
  const change1h   = token.price_change_percent1h || 0;
  const vel        = getVelocity(token);
  const velLabel   = velocityLabel(vel);
  const score      = signalScore(token);
  const label      = signalLabel(score);
  const isReentry  = token.alertType === "REENTRY";
  const devStatus  = token.creator_token_status === "sell" ? "🔴 Sold" : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";
  const mintR      = token.renounced_mint           === 1 ? "🟢 Yes" : "🔴 No";
  const rugPct     = `${((token.rug_ratio || 0) * 100).toFixed(0)}%`;
  const netflow    = (token.buy_5m || 0) > (token.sell_5m || 0) ? "🟢 Accumulating" : "🔴 Selling";
  const insiders   = Object.keys(insiderBuys[mint] || {});
  const insiderStr = insiders.length > 0
    ? `\n└ 👛 ${insiders.join(", ")}${insiders.length >= 3 ? " 🔥 CONVERGENCE" : ""}`
    : "";

  const msg =
    `🚨 *${isReentry ? "REENTRY" : "KOL"} SIGNAL* — ${label}\n` +
    `Score: ${score}/11\n\n` +
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
async function sendPumpAlert(token) {
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

  const msg =
    `🎯 *PUMPFUN PRE-BOND* — ${urgency}\n\n` +
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
async function sendUltraAlert(token) {
  const mint      = token.address;
  const symbol    = token.symbol || "???";
  const ageMin    = Math.floor((token.ageMs || 0) / 60000);
  const holders   = token.holder_count || token.holders || "N/A";
  const vol       = fmt(token.volume || 0);
  const mc        = token.market_cap || token.usd_market_cap || 0;
  const price     = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const buys      = token.buys  || 0;
  const sells     = token.sells || 0;
  const buyRatio  = token.buyRatio ? token.buyRatio.toFixed(1) : "N/A";
  const vel       = getVelocity(token);
  const momentum  = parseFloat(buyRatio) >= 10 ? "🔥🔥🔥 INSANE" : parseFloat(buyRatio) >= 5 ? "🔥🔥 VERY HIGH" : "🔥 HIGH";
  const devStatus = token.creator_token_status === "sell" ? "🔴 Sold" : token.creator_token_status === "hold" ? "🟢 Holding" : "🟡 N/A";

  const msg =
    `🚀 *ULTRA EARLY LAUNCH* — ${momentum}\n\n` +
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
  fetchSmartMoneyActivity().catch(() => {});

  const [kolTokens, pumpTokens, ultraTokens] = await Promise.all([
    getKOLSignals(),
    getPumpSignals(),
    getUltraSignals(),
  ]);

  log(`KOL: ${kolTokens.length} | Pump: ${pumpTokens.length} | Ultra: ${ultraTokens.length}`);

  // Merge — ultra first (most time sensitive)
  const allTokens = [
    ...ultraTokens.map(t => ({ ...t, _type: "ultra" })),
    ...kolTokens.map(t =>   ({ ...t, _type: "kol"   })),
    ...pumpTokens.map(t =>  ({ ...t, _type: "pump"  })),
  ];

  // Sort by score
  allTokens.sort((a, b) => signalScore(b) - signalScore(a));

  // Send top 5
  let sent = 0;
  for (const token of allTokens) {
    if (sent >= 5) break;
    const mint      = token.address;
    const lastAlert = alerted.get(mint);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;
    alerted.set(mint, Date.now());

    try {
      if (token._type === "ultra") await sendUltraAlert(token);
      else if (token._type === "pump") await sendPumpAlert(token);
      else await sendKOLAlert(token);
      sent++;
    } catch(e) { log(`Alert error: ${e.message}`); }
    await new Promise(r => setTimeout(r, 3000)); // safer send delay
  }

  // Cleanup old cooldowns
  const now = Date.now();
  for (const [mint, ts] of alerted.entries()) {
    if (now - ts > ALERT_COOLDOWN_MS) alerted.delete(mint);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("KOL Tracker v15 - Clean");

  await bot.sendMessage(CHAT_ID,
    `🟢 *KOL Tracker v15 Online*\n\n` +
    `No Claude — clean signals only\n\n` +
    `✅ KOL + Smart Money (24hr fresh)\n` +
    `✅ Old tokens only on volume spike\n` +
    `✅ PumpFun Pre-Bond\n` +
    `✅ Ultra Early (under 30 mins)\n` +
    `✅ Milestone alerts 2x 5x 10x\n` +
    `✅ 6 insider wallets tracked\n` +
    `✅ IPv4 forced\n\n` +
    `Scan every 45s`,
    { parse_mode: "Markdown" }
  );

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
