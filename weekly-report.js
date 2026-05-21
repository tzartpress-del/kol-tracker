// ═══════════════════════════════════════════════════════════
//  WEEKLY REPORT MODULE — Claude learns and improves
//  Runs every 7 days automatically
//  Sends morning report daily
// ═══════════════════════════════════════════════════════════

const axios = require("axios");
const { loadDB, saveDB, weeklyLearning, getBrainReport } = require("./brain");

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CHAT_ID = process.env.CHAT_ID;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

let bot;

function init(telegramBot) {
  bot = telegramBot;

  // Daily morning report at 8am UTC
  scheduleDailyReport();

  // Weekly learning session every 7 days
  scheduleWeeklyLearning();

  console.log("Weekly report module initialized");
}

// ─── DAILY MORNING REPORT ────────────────────────────────
function scheduleDailyReport() {
  const now = new Date();
  const next8am = new Date();
  next8am.setUTCHours(8, 0, 0, 0);

  // If 8am already passed today, schedule for tomorrow
  if (next8am <= now) {
    next8am.setUTCDate(next8am.getUTCDate() + 1);
  }

  const msUntil8am = next8am - now;
  console.log(`Daily report scheduled in ${Math.floor(msUntil8am/3600000)}h ${Math.floor((msUntil8am%3600000)/60000)}m`);

  setTimeout(() => {
    sendDailyReport();
    // Then repeat every 24 hours
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000);
  }, msUntil8am);
}

async function sendDailyReport() {
  const db = loadDB();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  // Get yesterday's trades
  const yesterdayTrades = db.trades.filter(t => {
    const tradeDate = new Date(t.entryTime).toDateString();
    return tradeDate === yesterday;
  });

  const closedYesterday = yesterdayTrades.filter(t => t.exitPrice);
  const wins = closedYesterday.filter(t => t.xGain >= 2).length;
  const losses = closedYesterday.filter(t => t.xGain < 1).length;
  const pnl = closedYesterday.reduce((sum, t) => sum + (t.pnlSol || 0), 0);

  // Overall stats
  const totalWR = db.stats.totalTrades > 0
    ? ((db.stats.winners / db.stats.totalTrades) * 100).toFixed(0)
    : 0;

  // Trading window recommendation
  const windowRec = db.patterns.bestTimeOfDay || "Still learning...";
  const bestSignal = db.patterns.bestSignalType || "Still learning...";

  // Readiness check
  const closedTrades = db.trades.filter(t => t.exitPrice).length;
  const daysToReady = Math.max(0, 50 - closedTrades);
  const readyStatus = daysToReady === 0 && parseFloat(totalWR) >= 40
    ? "READY FOR LIVE TRADING - type /golive"
    : `${daysToReady > 0 ? `Need ${daysToReady} more trades` : "Need 40%+ win rate"}`;

  await bot.sendMessage(CHAT_ID,
    `Good morning! Daily Report\n` +
    `${new Date().toUTCString().slice(0,16)}\n\n` +
    `Yesterday\n` +
    `Signals: ${yesterdayTrades.length}\n` +
    `Wins: ${wins} | Losses: ${losses}\n` +
    `PnL: ${pnl > 0 ? "+" : ""}${pnl.toFixed(4)} SOL\n\n` +
    `Overall Stats\n` +
    `Trades: ${db.stats.totalTrades}\n` +
    `Win Rate: ${totalWR}%\n` +
    `Total PnL: ${db.stats.totalPnlSol > 0 ? "+" : ""}${db.stats.totalPnlSol.toFixed(4)} SOL\n\n` +
    `Brain Status\n` +
    `Best Signal: ${bestSignal}\n` +
    `Best Window: ${windowRec}\n` +
    `Last Trained: ${db.patterns.lastAnalyzed ? new Date(db.patterns.lastAnalyzed).toLocaleDateString() : "Not yet"}\n\n` +
    `Live Trading: ${readyStatus}\n\n` +
    `100x Watchlist: ${db.watchlist100x.length} tokens\n` +
    `${db.watchlist100x.slice(0,3).map(t => `- $${t.symbol} (${t.holdStrategy})`).join("\n") || "None yet"}`
  );
}

// ─── WEEKLY LEARNING SESSION ─────────────────────────────
function scheduleWeeklyLearning() {
  // Run every 7 days
  setInterval(async () => {
    console.log("Starting weekly learning session...");
    await runWeeklyLearning();
  }, 7 * 24 * 60 * 60 * 1000);

  // Also run after 10 trades as first quick session
  checkForFirstLearning();
}

async function checkForFirstLearning() {
  const db = loadDB();
  const closedTrades = db.trades.filter(t => t.exitPrice).length;

  if (closedTrades >= 10 && !db.patterns.lastAnalyzed) {
    console.log("10 trades reached — running first learning session");
    await runWeeklyLearning();
  } else {
    // Check again in 1 hour
    setTimeout(checkForFirstLearning, 60 * 60 * 1000);
  }
}

async function runWeeklyLearning() {
  if (!CLAUDE_API_KEY) {
    console.log("Weekly learning skipped: no Claude API key");
    return;
  }

  const db = loadDB();
  const closedTrades = db.trades.filter(t => t.exitPrice);

  if (closedTrades.length < 10) {
    console.log(`Weekly learning skipped: only ${closedTrades.length} trades (need 10+)`);
    return;
  }

  await bot.sendMessage(CHAT_ID,
    `Claude is analyzing your trade history...\n` +
    `${closedTrades.length} trades being reviewed.\n` +
    `This may take a moment.`
  );

  try {
    const insights = await weeklyLearning(db);

    if (!insights) {
      await bot.sendMessage(CHAT_ID, `Learning session failed. Will retry next week.`);
      return;
    }

    // Build improvement message
    const improvements = [];
    if (insights.bestSignalType) improvements.push(`Best signal: ${insights.bestSignalType}`);
    if (insights.bestScoreRange) improvements.push(`Best score: ${insights.bestScoreRange}`);
    if (insights.bestMCRange) improvements.push(`Best MC: ${insights.bestMCRange}`);

    await bot.sendMessage(CHAT_ID,
      `Weekly Learning Complete!\n\n` +
      `Analyzed ${closedTrades.length} trades\n\n` +
      `Key Findings:\n` +
      `${improvements.map(i => `- ${i}`).join("\n")}\n\n` +
      `Hold Patterns Found:\n` +
      `${(insights.holdPatterns || []).slice(0,3).map(p => `- ${p}`).join("\n") || "Still collecting data"}\n\n` +
      `Rug Patterns to Avoid:\n` +
      `${(insights.rugPatterns || []).slice(0,3).map(p => `- ${p}`).join("\n") || "Still collecting data"}\n\n` +
      `Claude says:\n` +
      `"${insights.summary}"\n\n` +
      `Settings updated automatically.\n` +
      `Type /brain for full report.`
    );

    // Check if ready for live trading
    const winRate = db.stats.totalTrades > 0
      ? (db.stats.winners / db.stats.totalTrades) * 100
      : 0;

    if (closedTrades.length >= 50 && winRate >= 40) {
      await bot.sendMessage(CHAT_ID,
        `READY FOR LIVE TRADING!\n\n` +
        `Win Rate: ${winRate.toFixed(0)}%\n` +
        `Trades: ${closedTrades.length}\n` +
        `Best Signal: ${db.patterns.bestSignalType}\n\n` +
        `Type /golive to activate real trading.\n` +
        `Or keep paper trading to improve more.`
      );
    }

  } catch(e) {
    console.error("Weekly learning error:", e.message);
    await bot.sendMessage(CHAT_ID, `Learning session error: ${e.message}`);
  }
}

// ─── MARKET CONDITIONS REPORT ────────────────────────────
async function getMarketConditions() {
  if (!CLAUDE_API_KEY) return null;

  try {
    const db = loadDB();
    const recentTrades = db.trades.slice(-20);
    const recentWins = recentTrades.filter(t => t.exitPrice && t.xGain >= 2).length;
    const recentWR = recentTrades.length > 0
      ? ((recentWins / recentTrades.length) * 100).toFixed(0)
      : 0;

    const prompt = `Solana memecoin market analysis.

Recent bot performance (last 20 trades):
Win rate: ${recentWR}%
Wins: ${recentWins}/${recentTrades.length}

Current time: ${new Date().toUTCString()}

Based on this data should the bot be:
1. Trading aggressively (good conditions)
2. Trading normally (neutral conditions)  
3. Trading cautiously (poor conditions)
4. Not trading (bad conditions)

JSON: {"recommendation":"aggressive/normal/cautious/pause","reason":"brief","confidence":75}`;

    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 80, messages: [{ role: "user", content: prompt }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 8000 }
    );

    const text = res.data?.content?.[0]?.text || "";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch(e) {
    return { recommendation: "normal", reason: "Analysis unavailable", confidence: 50 };
  }
}

module.exports = {
  init,
  sendDailyReport,
  runWeeklyLearning,
  getMarketConditions,
};
