const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ─── MODULE IMPORTS (safe — bot runs even if modules fail) ────────────────────
let brain, security, commands, weeklyReport;
try { brain = require("./brain"); } catch(e) { console.log("brain.js not loaded:", e.message); }
try { security = require("./security"); } catch(e) { console.log("security.js not loaded:", e.message); }
try { commands = require("./commands"); } catch(e) { console.log("commands.js not loaded:", e.message); }
try { weeklyReport = require("./weekly-report"); } catch(e) { console.log("weekly-report.js not loaded:", e.message); }

// ─── PRODUCTION STABILITY ────────────────────────────────────────────────────
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
axios.defaults.timeout = 10000;

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// ─── FILTERS ─────────────────────────────────────────────────────────────────
const MC_MIN = 15000;
const MC_MAX = 150000;
const POLL_INTERVAL_MS = 20000;
const ALERT_COOLDOWN_MS = 3600000;
const MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

// PumpFun
const PUMP_MIN_VOLUME = 20000;
const PUMP_MIN_PROGRESS = 60;
const PUMP_MAX_PROGRESS = 98;
const PUMP_MIN_HOLDERS = 100;

// Ultra early
const ULTRA_MAX_AGE_MS = 30 * 60 * 1000;
const ULTRA_MIN_VOLUME = 3000;
const ULTRA_MIN_HOLDERS = 30;
const ULTRA_MIN_BUY_RATIO = 2;

// ─── PAPER TRADING CONFIG ────────────────────────────────────────────────────
const PAPER_TRADING = true;          // set to false for real trading
const PAPER_CAPITAL_SOL = 1.0;       // 1 SOL starting capital (~$150)
const PAPER_TRADE_SIZE_SOL = 0.1;    // 0.1 SOL per trade
const PAPER_TAKE_PROFIT_1 = 2.0;     // take 25% at 2x
const PAPER_TAKE_PROFIT_2 = 3.0;     // take 50% at 3x
const PAPER_STOP_LOSS = 0.5;         // exit at -50%

// ─── STATE ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const globalAlerted = new Set();
const alerted = new Map();
const claudeCache = new Map();
const performanceTracker = new Map();
const insiderBuys = {};
const lastSig = {};
const blacklist = new Set();

// Per-type stats
const botStats = {
  kol:   { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
  pump:  { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
  ultra: { alerts: 0, hits2x: 0, hits5x: 0, hits10x: 0 },
};

// Paper trading state
const paperPortfolio = {
  capital: PAPER_CAPITAL_SOL,
  startCapital: PAPER_CAPITAL_SOL,
  trades: [],
  openPositions: new Map(), // mint -> { entryPrice, size, symbol, type, openTime }
  totalPnl: 0,
  wins: 0,
  losses: 0,
};

function paperBuy(mint, price, symbol, signalType, score) {
  if (!PAPER_TRADING) return;
  if (paperPortfolio.openPositions.has(mint)) return;
  if (paperPortfolio.capital < PAPER_TRADE_SIZE_SOL) {
    log(`Paper: insufficient capital (${paperPortfolio.capital.toFixed(3)} SOL)`);
    return;
  }
  paperPortfolio.capital -= PAPER_TRADE_SIZE_SOL;
  paperPortfolio.openPositions.set(mint, {
    entryPrice: price, size: PAPER_TRADE_SIZE_SOL,
    symbol, signalType, openTime: Date.now(),
    tp1Hit: false, tp2Hit: false,
  });
  // Log to brain
  try {
    const db = brain.loadDB();
    brain.logTrade(db, { mint, symbol, signalType, entryPrice: price, entryTime: Date.now(), score: score||0, sizeSol: PAPER_TRADE_SIZE_SOL });
  } catch(e) { log(`Brain log error: ${e.message}`); }
  log(`Paper BUY: $${symbol} @ $${price} | Capital: ${paperPortfolio.capital.toFixed(3)} SOL`);
}

function paperSell(mint, price, reason) {
  if (!PAPER_TRADING) return null;
  const pos = paperPortfolio.openPositions.get(mint);
  if (!pos) return null;

  const xGain = price / pos.entryPrice;
  let pnlSol = 0;

  if (reason === "tp1") {
    pnlSol = pos.size * 0.25 * (xGain - 1);
    paperPortfolio.capital += pos.size * 0.25 * xGain;
    pos.size *= 0.75;
    pos.tp1Hit = true;
  } else if (reason === "tp2") {
    pnlSol = pos.size * 0.5 * (xGain - 1);
    paperPortfolio.capital += pos.size * 0.5 * xGain;
    pos.size *= 0.5;
    pos.tp2Hit = true;
  } else {
    pnlSol = pos.size * (xGain - 1);
    paperPortfolio.capital += pos.size * xGain;
    paperPortfolio.totalPnl += pnlSol;
    if (pnlSol > 0) paperPortfolio.wins++;
    else paperPortfolio.losses++;
    paperPortfolio.trades.push({ symbol: pos.symbol, entryPrice: pos.entryPrice, exitPrice: price, xGain, pnlSol, signalType: pos.signalType, duration: Date.now() - pos.openTime });
    paperPortfolio.openPositions.delete(mint);
    // Close in brain
    try {
      const db = brain.loadDB();
      brain.closeTrade(db, mint, price, reason);
    } catch(e) { log(`Brain close error: ${e.message}`); }
    log(`Paper SELL: $${pos.symbol} @ ${xGain.toFixed(2)}x | PnL: ${pnlSol > 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL`);
  }
  return { xGain, pnlSol };
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
      const p = paperPortfolio;
      const totalReturn = ((p.capital - p.startCapital) / p.startCapital * 100).toFixed(1);
      const winRate = (p.wins + p.losses) > 0 ? ((p.wins / (p.wins + p.losses)) * 100).toFixed(0) : 0;
      const openCount = p.openPositions.size;
      const recentTrades = p.trades.slice(-5).map(t =>
        `${t.xGain >= 1 ? "✅" : "❌"} $${t.symbol} ${t.xGain.toFixed(2)}x (${t.pnlSol > 0 ? "+" : ""}${t.pnlSol.toFixed(3)} SOL) [${t.signalType}]`
      ).join("\n");

      const msg =
        `📊 Bot Performance Stats\n\n` +
        `Signal Stats\n` +
        `KOL: ${s.kol.alerts} alerts | 2x:${s.kol.hits2x} 5x:${s.kol.hits5x}\n` +
        `Pump: ${s.pump.alerts} alerts | 2x:${s.pump.hits2x} 5x:${s.pump.hits5x}\n` +
        `Ultra: ${s.ultra.alerts} alerts | 2x:${s.ultra.hits2x} 5x:${s.ultra.hits5x}\n\n` +
        `📝 Paper Trading (${PAPER_TRADING ? "ACTIVE" : "OFF"})\n` +
        `Capital: ${p.capital.toFixed(3)} SOL (start: ${p.startCapital} SOL)\n` +
        `Total Return: ${totalReturn}%\n` +
        `Total PnL: ${p.totalPnl > 0 ? "+" : ""}${p.totalPnl.toFixed(4)} SOL\n` +
        `Trades: ${p.trades.length} | Wins: ${p.wins} | Losses: ${p.losses}\n` +
        `Win Rate: ${winRate}%\n` +
        `Open Positions: ${openCount}\n\n` +
        `Recent Trades:\n${recentTrades || "No trades yet"}\n\n` +
        `Blacklisted: ${blacklist.size} | Tracking: ${performanceTracker.size}`;
      await bot.sendMessage(CHAT_ID, msg);
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

// ─── HARD FILTER (before Claude) ─────────────────────────────────────────────
function hardFilter(token) {
function hardFilter(token) {
  const holders = token.holder_count || 0;
  const liq = token.liquidity || 0;
  const rug = token.rug_ratio || 0;  // default 0 not 1
  const bundle = token.bundler_trader_amount_rate || 0; // default 0 not 1
  const smart = token.smart_degen_count || 0;
  const top10 = token.top_10_holder_rate || 0;
  const holders500 = holders > 500 && (token.volume || 0) < 10000;

  if (holders < 30) return false;       // loosened from 40
  if (liq < 5000) return false;         // loosened from 7000
  if (rug > 0.25) return false;         // loosened from 0.18
  if (bundle > 0.40) return false;      // loosened from 0.25
  if (smart === 0) return false;
  if (top10 > 0.40) return false;       // loosened from 0.35
  if (holders500) return false;
  if (blacklist.has(token.creator || "")) return false;
  return true;
}

// ─── VELOCITY SCORING ────────────────────────────────────────────────────────
function getVelocity(token) {
  const vol5m = token.volume_5m || 0;
  const vol1h = token.volume || 0;
  const velocity = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
  return parseFloat(velocity.toFixed(2));
}

function velocityLabel(v) {
  if (v >= 2.0) return "EXPLOSIVE";
  if (v >= 1.0) return "STABLE";
  if (v < 0.5) return "DYING";
  return "MODERATE";
}

// ─── FINAL SCORE ─────────────────────────────────────────────────────────────
function calcFinalScore(token, aiConfidence, insiderCount) {
  let s = 0;
  const smart = token.smart_degen_count || 0;
  const kol = token.renowned_count || 0;
  const rug = token.rug_ratio || 1;
  const liq = token.liquidity || 0;
  const buys = token.buy_5m || token.swaps_5m || 0;
  const sells = token.sell_5m || 0;

  // Smart money
  if (smart >= 3) s += 3; else if (smart >= 1) s += 2;
  // KOL
  if (kol >= 2) s += 2; else if (kol >= 1) s += 1;
  // Liquidity
  if (liq > 15000) s += 2;
  // Buy pressure
  if (buys > sells * 1.5) s += 2;
  // Dev holding
  if (token.creator_token_status === "hold") s += 1;
  // Mint renounced
  if (token.renounced_mint === 1) s += 1;
  // Negatives
  if (token.is_wash_trading) s -= 3;
  if (rug > 0.20) s -= 3;
  if ((token.bundler_trader_amount_rate || 0) > 0.25) s -= 2;
  if ((token.holder_count || 0) < 50) s -= 2;
  if (liq < 8000) s -= 2;
  if (token.creator_token_status === "sell") s -= 2;
  // AI confidence bonus
  s += Math.floor(aiConfidence / 20);
  // Velocity bonus
  const vel = getVelocity(token);
  if (vel >= 1.5) s += 1;
  // Insider convergence
  s += insiderCount;

  return s;
}

function signalLabel(score) {
  if (score >= 12) return "ULTRA HIGH";
  if (score >= 8) return "HIGH";
  if (score >= 5) return "MEDIUM";
  return "LOW";
}

// ─── CLAUDE AI FILTER (COST OPTIMIZED) ───────────────────────────────────────
let claudeCallCount = 0;
const CLAUDE_DAILY_LIMIT = 50; // max 50 calls per day to control cost

async function claudeFilter(token) {
  // Check cache first (2 hour cache)
  const cached = claudeCache.get(token.address);
  if (cached && Date.now() - cached.ts < 7200000) return cached.result;

  const rug = token.rug_ratio || 0;
  const smart = token.smart_degen_count || 0;
  const liq = token.liquidity || 0;
  const bundle = token.bundler_trader_amount_rate || 0;

  // Hard reject without Claude - saves all credits
  if (rug > 0.5) return { decision: "REJECT", reason: "Rug >50%", risk: "VERY HIGH", confidence: 99 };
  if (liq < 3000) return { decision: "REJECT", reason: "Liq too low", risk: "VERY HIGH", confidence: 99 };
  if (token.is_wash_trading) return { decision: "REJECT", reason: "Wash trading", risk: "VERY HIGH", confidence: 99 };
  if (bundle > 0.5) return { decision: "REJECT", reason: "Bundle >50%", risk: "VERY HIGH", confidence: 99 };

  // Auto approve strong signals - no Claude needed
  if (smart >= 2 && rug < 0.1 && liq > 10000) {
    const result = { decision: "APPROVE", reason: "Strong smart money", risk: "LOW", confidence: 88 };
    claudeCache.set(token.address, { result, ts: Date.now() });
    return result;
  }

  // Auto approve decent signals - no Claude needed
  if (smart >= 1 && rug < 0.15 && liq > 8000 && !token.is_wash_trading) {
    const result = { decision: "APPROVE", reason: "Good signal", risk: "MEDIUM", confidence: 72 };
    claudeCache.set(token.address, { result, ts: Date.now() });
    return result;
  }

  // Skip Claude if disabled or daily limit reached
  if (!CLAUDE_API_KEY || claudeCallCount >= CLAUDE_DAILY_LIMIT) {
    return { decision: "APPROVE", reason: "AI limit reached", risk: "MEDIUM", confidence: 60 };
  }

  // Only call Claude for ambiguous cases
  try {
    claudeCallCount++;
    const prompt = `Solana memecoin. APPROVE unless clear scam.
${token.symbol} Liq:$${liq} Rug:${(rug*100).toFixed(0)}% Bundle:${(bundle*100).toFixed(0)}%
Smart:${smart} Holders:${token.holder_count||0}
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

// Reset Claude counter daily
setInterval(() => { claudeCallCount = 0; log("Claude call counter reset"); }, 24 * 60 * 60 * 1000);

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
  for (const [wallet, name] of Object.entries(INSIDER_WALLETS)) {
    try {
      if (!HELIUS_API_KEY) continue;
      const res = await axios.get(
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=5&type=SWAP`
      );
      const txs = res.data || [];
      if (!txs.length) continue;
      const newTxs = lastSig[wallet] ? txs.filter(t => t.signature !== lastSig[wallet]) : txs.slice(0,2);
      if (newTxs.length) lastSig[wallet] = txs[0].signature;
      for (const tx of newTxs) {
        const WSOL = "So11111111111111111111111111111111111111112";
        const recv = (tx.tokenTransfers||[]).find(t => t.toUserAccount===wallet && t.mint!==WSOL);
        if (!recv?.mint) continue;
        const mint = recv.mint;
        if (!insiderBuys[mint]) insiderBuys[mint] = {};
        insiderBuys[mint][name] = Date.now();
        log(`Insider ${name} bought ${mint.slice(0,8)}...`);
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  // Cleanup old entries
  const cutoff = Date.now() - 7200000;
  for (const [mint, buyers] of Object.entries(insiderBuys)) {
    for (const [k, ts] of Object.entries(buyers)) { if (ts < cutoff) delete insiderBuys[mint][k]; }
    if (!Object.keys(insiderBuys[mint]).length) delete insiderBuys[mint];
  }
}

// ─── MILESTONE PERFORMANCE TRACKER ───────────────────────────────────────────
async function getTokenPrice(mint) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const pairs = (res.data?.pairs || []).filter(p => p.chainId === "solana");
    if (!pairs.length) return null;
    pairs.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0));
    return { price: parseFloat(pairs[0].priceUsd||0), mc: pairs[0].fdv||0, liquidity: pairs[0].liquidity?.usd||0, sells: pairs[0].txns?.h1?.sells||0, buys: pairs[0].txns?.h1?.buys||0 };
  } catch(e) { return null; }
}

async function trackPerformance(mint, alertPrice, alertMC, symbol, alertMsgId, signalType) {
  performanceTracker.set(mint, { alertPrice, alertMC, symbol, alertTime: Date.now(), alertMsgId, signalType, peakX: 1, notified2x: false, notified5x: false, notified10x: false });

  const interval = setInterval(async () => {
    const tracker = performanceTracker.get(mint);
    if (!tracker) { clearInterval(interval); return; }
    if (Date.now() - tracker.alertTime > 86400000) {
      await bot.sendMessage(CHAT_ID,
        `Final: $${symbol}\nPeak: ${tracker.peakX.toFixed(2)}x\nVerdict: ${tracker.peakX >= 10 ? "MOONSHOT" : tracker.peakX >= 5 ? "BANGER" : tracker.peakX >= 2 ? "WIN" : tracker.peakX >= 1 ? "BREAKEVEN" : "RUG"}`
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

    // Distribution warning (exit signal)
    if (current.sells > current.buys * 2 && xGain > 1.5) {
      await bot.sendMessage(CHAT_ID,
        `⚠️ DISTRIBUTION DETECTED\n$${symbol}\nLarge sell pressure emerging\nCurrent: ${xGain.toFixed(2)}x`,
        { reply_to_message_id: alertMsgId }
      ).catch(()=>{});
    }

    if (xGain >= 10 && !tracker.notified10x) {
      tracker.notified10x = true; stats.hits10x++;
      await bot.sendMessage(CHAT_ID, `🌙 10x! $${symbol} is up 10x!\nMC: ${fmt(current.mc)}\nConsider taking profit!`, { reply_to_message_id: alertMsgId }).catch(()=>{});
    } else if (xGain >= 5 && !tracker.notified5x) {
      tracker.notified5x = true; stats.hits5x++;
      await bot.sendMessage(CHAT_ID, `🚀 5x! $${symbol} is up 5x!\nMC: ${fmt(current.mc)}\nConsider taking profit!`, { reply_to_message_id: alertMsgId }).catch(()=>{});
    } else if (xGain >= PAPER_TAKE_PROFIT_2 && !tracker.notified5x) {
      // Paper trade TP2
      const result = paperSell(mint, current.price, "tp2");
      if (result) await bot.sendMessage(CHAT_ID, `📝 Paper TP2: $${symbol} @ 3x\nSold 50% of position\nCapital: ${paperPortfolio.capital.toFixed(3)} SOL`, { reply_to_message_id: alertMsgId }).catch(()=>{});
    } else if (xGain >= PAPER_TAKE_PROFIT_1 && !tracker.notified2x) {
      tracker.notified2x = true; stats.hits2x++;
      // Paper trade TP1
      const result = paperSell(mint, current.price, "tp1");
      const paperMsg = result ? `\n📝 Paper: Sold 25% @ 2x` : "";
      await bot.sendMessage(CHAT_ID, `✅ 2x! $${symbol} is up 2x!\nMC: ${fmt(current.mc)}\nConsider 25% profit!${paperMsg}`, { reply_to_message_id: alertMsgId }).catch(()=>{});
    } else if (xGain <= PAPER_STOP_LOSS) {
      // Paper stop loss
      const result = paperSell(mint, current.price, "stop");
      if (result) await bot.sendMessage(CHAT_ID, `🛑 Stop Loss: $${symbol} -50%\n📝 Paper: Position closed\nCapital: ${paperPortfolio.capital.toFixed(3)} SOL`, { reply_to_message_id: alertMsgId }).catch(()=>{});
      performanceTracker.delete(mint); clearInterval(interval); return;
    }
    if (current.liquidity < 2000 && tracker.peakX > 1.5) {
      await bot.sendMessage(CHAT_ID, `⚠️ LIQ WARNING! $${symbol} liquidity dropping!\nExit now!`, { reply_to_message_id: alertMsgId }).catch(()=>{});
      performanceTracker.delete(mint); clearInterval(interval);
    }
  }, 3 * 60 * 1000);
}

// ─── GMGN FETCH ───────────────────────────────────────────────────────────────
async function fetchGMGN(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json", "Referer": "https://gmgn.ai/" }
      });
      return res.data;
    } catch(e) {
      const status = e.response?.status;
      if (status === 429 || status === 403) { await new Promise(r => setTimeout(r, (i+1)*5000)); }
      else { log(`Fetch error: ${e.message}`); return null; }
    }
  }
  return null;
}

// ─── GET KOL SIGNALS ─────────────────────────────────────────────────────────
async function getKOLSignals() {
  const urls = [
    `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=smart_degen_count&direction=desc&filters[]=not_honeypot&filters[]=renounced&limit=100`,
    `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
  ];
  const responses = await Promise.allSettled(urls.map(u => fetchGMGN(u)));
  const seen = new Set(); const results = [];
  for (const r of responses) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const tokens = r.value?.data?.rank || [];
    for (const t of tokens) {
      if (!t.address || seen.has(t.address) || globalAlerted.has(t.address)) continue;
      seen.add(t.address);
      const mc = t.market_cap || 0;
      const tokenAge = t.open_timestamp ? (Date.now() - t.open_timestamp * 1000) : null;
      const isNew = tokenAge !== null && tokenAge <= MAX_TOKEN_AGE_MS;
      const isReentry = !isNew && (t.volume||0) >= 50000 && (t.smart_degen_count||0) >= 2;
      if (mc >= MC_MIN && mc <= MC_MAX && (t.smart_degen_count||0) >= 1 && (t.renowned_count||0) >= 1 && (isNew||isReentry) && !blacklist.has(t.creator||"")) {
        results.push({ ...t, alertType: isReentry ? "REENTRY" : "KOL", tokenAge });
      }
    }
  }
  results.sort((a,b) => (b.smart_degen_count||0) - (a.smart_degen_count||0));
  return results;
}

// ─── GET PUMPFUN PRE-BOND ─────────────────────────────────────────────────────
async function getPumpFunPrebond() {
  const urls = [
    `https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=volume&direction=desc&filters[]=not_honeypot&limit=100`,
    `https://gmgn.ai/api/v1/mutil_window_token_list/sol?type=near_completion&orderby=volume&direction=desc&limit=50`,
  ];
  const responses = await Promise.allSettled(urls.map(u => fetchGMGN(u)));
  const seen = new Set(); const results = [];
  for (const r of responses) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const tokens = r.value?.data?.rank || r.value?.data?.token_list || r.value?.data || [];
    if (!Array.isArray(tokens)) continue;
    for (const t of tokens) {
      if (!t.address || seen.has(t.address) || globalAlerted.has(t.address)) continue;
      seen.add(t.address);
      const progress = t.launchpad_status?.bonding_curve_percentage || t.graduation_progress || t.progress || 0;
      const volume = t.volume || t.volume_24h || 0;
      const holders = t.holder_count || t.holders || 0;
      if (progress >= PUMP_MIN_PROGRESS && progress <= PUMP_MAX_PROGRESS && volume >= PUMP_MIN_VOLUME && holders >= PUMP_MIN_HOLDERS && (t.rug_ratio||0) < 0.3 && !t.is_wash_trading && !blacklist.has(t.creator||"")) {
        results.push({ ...t, alertType: "PUMP", progress });
      }
    }
  }
  results.sort((a,b) => (b.volume||0) - (a.volume||0));
  return results.slice(0, 10);
}

// ─── GET ULTRA EARLY ─────────────────────────────────────────────────────────
async function getUltraEarlyLaunches() {
  const urls = [
    `https://gmgn.ai/defi/quotation/v1/rank/sol/pump?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
    `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/5m?orderby=open_timestamp&direction=desc&filters[]=not_honeypot&limit=100`,
  ];
  const responses = await Promise.allSettled(urls.map(u => fetchGMGN(u)));
  const seen = new Set(); const results = [];
  for (const r of responses) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const tokens = r.value?.data?.rank || r.value?.data?.token_list || r.value?.data || [];
    if (!Array.isArray(tokens)) continue;
    for (const t of tokens) {
      if (!t.address || seen.has(t.address) || globalAlerted.has(t.address)) continue;
      seen.add(t.address);
      const ageMs = t.open_timestamp ? Date.now() - t.open_timestamp * 1000 : null;
      if (!ageMs || ageMs > ULTRA_MAX_AGE_MS) continue;
      const progress = t.launchpad_status?.bonding_curve_percentage || t.progress || 0;
      const volume = t.volume || t.volume_5m || 0;
      const holders = t.holder_count || t.holders || 0;
      const buys = t.buy_5m || t.swaps_5m || t.txns_5m?.buys || 0;
      const sells = t.sell_5m || t.txns_5m?.sells || 0;
      const buyRatio = sells > 0 ? buys/sells : buys;
      if (progress >= 3 && progress <= 60 && volume >= ULTRA_MIN_VOLUME && holders >= ULTRA_MIN_HOLDERS && buyRatio >= ULTRA_MIN_BUY_RATIO && (t.rug_ratio||0) < 0.2 && !t.is_wash_trading && !blacklist.has(t.creator||"")) {
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
      [{ text: "BUY 0.1 SOL via Trojan", url: `https://t.me/solana_trojanbot?start=ca_${mint}` }],
      [
        { text: "DexScreener", url: `https://dexscreener.com/solana/${mint}` },
        { text: "GMGN", url: `https://gmgn.ai/sol/token/${mint}` }
      ],
      [
        { text: isPump ? "PumpFun" : "Axiom", url: isPump ? `https://pump.fun/${mint}` : `https://axiom.trade/t/${mint}` },
        { text: "Stats", callback_data: "stats" }
      ],
      [{ text: "Skip", callback_data: `skip_${mint.slice(0,20)}` }]
    ]
  };
}

// ─── SEND KOL ALERT ───────────────────────────────────────────────────────────
async function sendKOLAlert(token, aiResult) {
  const mint = token.address;
  const symbol = token.symbol || "???";
  const mc = token.market_cap || 0;
  const age = fmtAge(token.open_timestamp ? token.open_timestamp*1000 : null);
  const holders = token.holder_count || "N/A";
  const price = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const vol = fmt(token.volume || 0);
  const liq = fmt(token.liquidity || 0);
  const change1h = token.price_change_percent1h || 0;
  const vel = getVelocity(token);
  const velLabel = velocityLabel(vel);
  const insiders = Object.keys(insiderBuys[mint] || {});
  const insiderCount = insiders.length;
  const insiderBoost = insiderCount >= 3 ? "INSIDER CONVERGENCE" : insiderCount >= 2 ? "Multi-insider" : insiderCount === 1 ? "Insider buy" : "";
  const finalScore = calcFinalScore(token, aiResult.confidence, insiderCount);
  const label = signalLabel(finalScore);
  const isReentry = token.alertType === "REENTRY";
  const riskEmoji = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";
  const devStatus = token.creator_token_status === "sell" ? "Sold" : token.creator_token_status === "hold" ? "Holding" : "N/A";
  const mintR = token.renounced_mint === 1 ? "Yes" : "No";
  const rugPct = `${((token.rug_ratio||0)*100).toFixed(0)}%`;
  const netflow = token.buy_5m > token.sell_5m ? "Accumulating" : "Selling";

  const insiderStr = insiders.length > 0 ? `\nInsiders: ${insiders.join(", ")}${insiderBoost ? " - " + insiderBoost : ""}` : "";

  const msg =
    `${isReentry ? "REENTRY SIGNAL" : "KOL SIGNAL"} - ${label}\n` +
    `Score: ${finalScore} | AI: ${riskEmoji} ${aiResult.risk} ${aiResult.confidence}%\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n` +
    `Age: ${age} | Holders: ${holders}\n\n` +
    `Price: ${price} | MC: ${fmt(mc)}\n` +
    `Vol: ${vol} | Liq: ${liq}\n` +
    `1h: ${change1h > 0 ? "+" : ""}${change1h.toFixed(1)}%\n` +
    `Velocity: ${vel}x ${velLabel}\n\n` +
    `Smart Money: ${token.smart_degen_count||0} | KOL: ${token.renowned_count||0}\n` +
    `Netflow: ${netflow}${insiderStr}\n\n` +
    `Dev: ${devStatus} | Mint: ${mintR} | Rug: ${rugPct}\n\n` +
    `Snipe 0.1 SOL?`;

  const sent = await bot.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: buildKeyboard(mint, false) });
  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) {
    await trackPerformance(mint, alertPrice, mc, symbol, sent.message_id, "kol");
    paperBuy(mint, alertPrice, symbol, "kol");
  }
  botStats.kol.alerts++;
  log(`KOL Alert: $${symbol} Score:${finalScore} Smart:${token.smart_degen_count||0} KOL:${token.renowned_count||0}`);
}

// ─── SEND PUMP ALERT ─────────────────────────────────────────────────────────
async function sendPumpAlert(token, aiResult) {
  const mint = token.address;
  const symbol = token.symbol || "???";
  const progress = token.progress || 0;
  const progressBar = "█".repeat(Math.floor(progress/10)) + "░".repeat(10-Math.floor(progress/10));
  const holders = token.holder_count || token.holders || "N/A";
  const vol = fmt(token.volume || token.volume_24h || 0);
  const mc = fmt(token.market_cap || token.usd_market_cap || 0);
  const price = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const age = fmtAge(token.open_timestamp ? token.open_timestamp*1000 : null);
  const urgency = progress >= 90 ? "MIGRATING SOON" : progress >= 75 ? "FILLING FAST" : "EARLY";
  const riskEmoji = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";

  const msg =
    `PUMPFUN PRE-BOND - ${urgency}\n` +
    `AI: ${riskEmoji} ${aiResult.risk} ${aiResult.confidence}%\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n` +
    `Age: ${age} | Holders: ${holders}\n\n` +
    `[${progressBar}] ${progress.toFixed(1)}%\n\n` +
    `Price: ${price} | MC: ${mc}\n` +
    `Vol: ${vol}\n\n` +
    `Smart: ${token.smart_degen_count||0} | KOL: ${token.renowned_count||0}\n\n` +
    `Buy before Raydium migration!\n` +
    `Snipe 0.1 SOL?`;

  const sent = await bot.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: buildKeyboard(mint, true) });
  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) {
    await trackPerformance(mint, alertPrice, token.market_cap||0, symbol, sent.message_id, "pump");
    paperBuy(mint, alertPrice, symbol, "pump");
  }
  botStats.pump.alerts++;
  log(`Pump Alert: $${symbol} ${progress.toFixed(0)}% Vol:${vol}`);
}

// ─── SEND ULTRA EARLY ALERT ───────────────────────────────────────────────────
async function sendUltraEarlyAlert(token, aiResult) {
  const mint = token.address;
  const symbol = token.symbol || "???";
  const ageMin = Math.floor((token.ageMs||0)/60000);
  const progress = token.progress || 0;
  const progressBar = "█".repeat(Math.floor(progress/10)) + "░".repeat(10-Math.floor(progress/10));
  const holders = token.holder_count || token.holders || "N/A";
  const vol5m = fmt(token.volume || token.volume_5m || 0);
  const mc = token.market_cap || token.usd_market_cap || 0;
  const price = token.price ? `$${parseFloat(token.price).toExponential(4)}` : "N/A";
  const buys = token.buys || 0;
  const sells = token.sells || 0;
  const buyRatio = token.buyRatio ? token.buyRatio.toFixed(1) : "N/A";
  const vel = getVelocity(token);
  const momentum = token.buyRatio >= 10 ? "INSANE" : token.buyRatio >= 5 ? "VERY HIGH" : "HIGH";
  const riskEmoji = aiResult.risk === "LOW" ? "🟢" : aiResult.risk === "MEDIUM" ? "🟡" : "🔴";
  const devStatus = token.creator_token_status === "sell" ? "Sold" : token.creator_token_status === "hold" ? "Holding" : "N/A";

  const msg =
    `ULTRA EARLY LAUNCH - ${momentum} MOMENTUM\n` +
    `AI: ${riskEmoji} ${aiResult.risk} ${aiResult.confidence}%\n\n` +
    `*$${symbol}*\n` +
    `\`${mint}\`\n` +
    `Age: ${ageMin}m | Holders: ${holders}\n\n` +
    `[${progressBar}] ${progress.toFixed(1)}%\n\n` +
    `Price: ${price} | MC: ${fmt(mc)}\n` +
    `Vol 5m: ${vol5m}\n` +
    `Buys: ${buys} | Sells: ${sells}\n` +
    `B/S Ratio: ${buyRatio}:1\n` +
    `Velocity: ${vel}x\n\n` +
    `Dev: ${devStatus}\n\n` +
    `Snipe 0.1 SOL?\nAlways DYOR`;

  const sent = await bot.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: buildKeyboard(mint, true) });
  const alertPrice = token.price ? parseFloat(token.price) : null;
  if (alertPrice) {
    await trackPerformance(mint, alertPrice, mc, symbol, sent.message_id, "ultra");
    paperBuy(mint, alertPrice, symbol, "ultra");
  }
  botStats.ultra.alerts++;
  log(`Ultra Early: $${symbol} Age:${ageMin}m Curve:${progress.toFixed(0)}% B/S:${buyRatio}`);
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scan() {
  log("Scanning...");
  pollInsiderWallets().catch(()=>{});

  const [kolTokens, pumpTokens, ultraTokens] = await Promise.all([
    getKOLSignals(), getPumpFunPrebond(), getUltraEarlyLaunches()
  ]);
  log(`KOL: ${kolTokens.length} | Pump: ${pumpTokens.length} | Ultra: ${ultraTokens.length}`);

  // Combine + run Claude in parallel (async batching)
  const allTokens = [
    ...ultraTokens.map(t => ({ ...t, _type: "ultra" })),
    ...kolTokens.map(t => ({ ...t, _type: "kol" })),
    ...pumpTokens.map(t => ({ ...t, _type: "pump" })),
  ];

  // Hard filter first
  const filtered = allTokens.filter(t => t._type === "ultra" || t._type === "pump" || hardFilter(t));

  // Run Claude in parallel
  const aiResults = await Promise.all(filtered.map(t => claudeFilter(t)));

  // Calculate final scores and sort
  const scored = filtered.map((t, i) => {
    const insiderCount = Object.keys(insiderBuys[t.address] || {}).length;
    return { ...t, _ai: aiResults[i], _finalScore: calcFinalScore(t, aiResults[i].confidence, insiderCount) };
  }).filter(t => aiResults[filtered.indexOf(t)]?.decision !== "REJECT")
    .sort((a,b) => b._finalScore - a._finalScore);

  // Send TOP 5 per scan (was 3 — too restrictive)
  let sent = 0;
  for (const token of scored) {
    if (sent >= 5) break;
    const mint = token.address;
    const lastAlert = alerted.get(mint);
    if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;

    globalAlerted.add(mint);
    alerted.set(mint, Date.now());

    try {
      if (token._type === "ultra") await sendUltraEarlyAlert(token, token._ai);
      else if (token._type === "pump") await sendPumpAlert(token, token._ai);
      else await sendKOLAlert(token, token._ai);
      sent++;
    } catch(e) { log(`Alert error: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500));
  }

  // Memory cleanup — reset globalAlerted after cooldown expires
  const now = Date.now();
  for (const mint of globalAlerted) {
    const lastAlert = alerted.get(mint);
    if (!lastAlert || now - lastAlert > ALERT_COOLDOWN_MS) {
      globalAlerted.delete(mint);
    }
  }
  // Clean claude cache
  for (const [k, v] of claudeCache.entries()) {
    if (now - v.ts > 7200000) claudeCache.delete(k);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("KOL Tracker v14 - Full System");

  // Initialize all modules safely
  try { if (brain) { const db = brain.loadDB(); log(`Brain: ${db.stats.totalTrades} trades loaded`); } } catch(e) { log(`Brain init error: ${e.message}`); }
  try { if (commands) commands.init(bot, CHAT_ID); log("Commands: active"); } catch(e) { log(`Commands init error: ${e.message}`); }
  try { if (weeklyReport) weeklyReport.init(bot); log("Weekly report: scheduled"); } catch(e) { log(`Weekly report init error: ${e.message}`); }

  await bot.sendMessage(CHAT_ID,
    `KOL Tracker Bot v14 Online\n\n` +
    `Full System Active\n\n` +
    `PAPER TRADING: ${PAPER_TRADING ? "ON" : "OFF"}\n` +
    `Capital: ${PAPER_CAPITAL_SOL} SOL\n` +
    `Trade Size: ${PAPER_TRADE_SIZE_SOL} SOL\n` +
    `TP1: 25% at 2x | TP2: 50% at 3x\n` +
    `Stop Loss: -50%\n\n` +
    `Modules Active:\n` +
    `- Brain: learning database\n` +
    `- Security: only you control bot\n` +
    `- Commands: /help to see all\n` +
    `- Weekly report: 8am UTC daily\n\n` +
    `Type /help for all commands`
  );

  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });

}
