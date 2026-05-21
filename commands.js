// ═══════════════════════════════════════════════════════════
//  COMMANDS MODULE — Telegram bot commands
//  Only authorized chat ID can use these
// ═══════════════════════════════════════════════════════════

const { isAuthorized } = require("./security");
const { loadDB, getBrainReport } = require("./brain");

let bot;
let CHAT_ID;
let tradingState = {
  isLive: false,       // false = paper trading, true = live
  isPaused: false,     // pause all activity
  dailyTrades: 0,
  dailyTradeDate: null,
  maxDailyTrades: 5,
};

function init(telegramBot, chatId) {
  bot = telegramBot;
  CHAT_ID = chatId;
  setupCommands();
  console.log("Commands module initialized");
}

function setupCommands() {
  bot.onText(/\/(.+)/, async (msg) => {
    const chatId = msg.chat.id;

    // Security check
    if (!isAuthorized(chatId)) {
      console.log(`Unauthorized command attempt from ${chatId}`);
      return;
    }

    const text = msg.text.trim();
    const parts = text.split(" ");
    const cmd = parts[0].toLowerCase();

    console.log(`Command received: ${cmd} from ${chatId}`);

    switch(cmd) {
      case "/help":
        await handleHelp();
        break;
      case "/pause":
        await handlePause();
        break;
      case "/resume":
        await handleResume();
        break;
      case "/status":
        await handleStatus();
        break;
      case "/brain":
        await handleBrain();
        break;
      case "/withdraw":
        await handleWithdraw(parts[1]);
        break;
      case "/report":
        await handleReport();
        break;
      case "/golive":
        await handleGoLive();
        break;
      case "/paper":
        await handlePaper();
        break;
      case "/limit":
        await handleLimit(parts[1]);
        break;
    }
  });
}

// ─── COMMAND HANDLERS ─────────────────────────────────────

async function handleHelp() {
  await bot.sendMessage(CHAT_ID,
    `KOL Tracker Commands\n\n` +
    `/pause    - Stop all trading\n` +
    `/resume   - Resume trading\n` +
    `/status   - Positions + capital\n` +
    `/brain    - AI learned patterns\n` +
    `/withdraw - Sweep profits\n` +
    `/report   - Performance report\n` +
    `/golive   - Activate real trading\n` +
    `/paper    - Switch to paper mode\n` +
    `/limit N  - Set max daily trades\n` +
    `/help     - Show this menu\n\n` +
    `Mode: ${tradingState.isLive ? "LIVE TRADING" : "PAPER TRADING"}\n` +
    `Status: ${tradingState.isPaused ? "PAUSED" : "ACTIVE"}`
  );
}

async function handlePause() {
  tradingState.isPaused = true;
  await bot.sendMessage(CHAT_ID,
    `PAUSED\n\n` +
    `All trading stopped.\n` +
    `Existing positions still monitored.\n` +
    `Type /resume to restart.`
  );
  console.log("Bot paused by owner");
}

async function handleResume() {
  tradingState.isPaused = false;
  await bot.sendMessage(CHAT_ID,
    `RESUMED\n\n` +
    `Trading active again.\n` +
    `Mode: ${tradingState.isLive ? "LIVE" : "PAPER"}\n` +
    `Daily trades: ${tradingState.dailyTrades}/${tradingState.maxDailyTrades}`
  );
  console.log("Bot resumed by owner");
}

async function handleStatus() {
  const db = loadDB();
  const openPositions = db.trades.filter(t => !t.exitPrice);

  const positionsList = openPositions.length > 0
    ? openPositions.map(p => {
        const ageMin = Math.floor((Date.now() - p.entryTime) / 60000);
        return `$${p.symbol} | Entry: ${p.entryMC ? `$${(p.entryMC/1000).toFixed(0)}K` : "N/A"} | ${ageMin}m ago`;
      }).join("\n")
    : "No open positions";

  await bot.sendMessage(CHAT_ID,
    `Status Report\n\n` +
    `Mode: ${tradingState.isLive ? "LIVE TRADING" : "PAPER TRADING"}\n` +
    `Status: ${tradingState.isPaused ? "PAUSED" : "ACTIVE"}\n` +
    `Daily Trades: ${tradingState.dailyTrades}/${tradingState.maxDailyTrades}\n\n` +
    `Open Positions (${openPositions.length}):\n` +
    `${positionsList}\n\n` +
    `Total Trades: ${db.stats.totalTrades}\n` +
    `Win Rate: ${db.stats.totalTrades > 0 ? ((db.stats.winners/db.stats.totalTrades)*100).toFixed(0) : 0}%\n` +
    `Total PnL: ${db.stats.totalPnlSol > 0 ? "+" : ""}${db.stats.totalPnlSol.toFixed(4)} SOL`
  );
}

async function handleBrain() {
  const db = loadDB();
  const report = getBrainReport(db);
  await bot.sendMessage(CHAT_ID, report);
}

async function handleWithdraw(address) {
  if (!address) {
    await bot.sendMessage(CHAT_ID,
      `Withdraw profits\n\n` +
      `Usage: /withdraw YOUR_WALLET_ADDRESS\n\n` +
      `This sweeps all profits above base capital\n` +
      `to your specified wallet address.\n\n` +
      `Example:\n` +
      `/withdraw 7xKj3mN...pump`
    );
    return;
  }

  await bot.sendMessage(CHAT_ID,
    `Withdraw requested\n\n` +
    `Destination: ${address.slice(0,8)}...${address.slice(-6)}\n\n` +
    `Jupiter integration required for execution.\n` +
    `Coming in Phase 10 of the build plan.\n\n` +
    `For now manually send profits from\n` +
    `your trading wallet to Binance.`
  );
}

async function handleReport() {
  const db = loadDB();
  const byType = db.stats.bySignalType;

  const kolWR = byType.kol.trades > 0 ? ((byType.kol.wins/byType.kol.trades)*100).toFixed(0) : 0;
  const pumpWR = byType.pump.trades > 0 ? ((byType.pump.wins/byType.pump.trades)*100).toFixed(0) : 0;
  const ultraWR = byType.ultra.trades > 0 ? ((byType.ultra.wins/byType.ultra.trades)*100).toFixed(0) : 0;

  const recentTrades = db.trades.slice(-10).reverse().map(t =>
    `${t.exitPrice ? (t.xGain >= 2 ? "WIN" : "LOSS") : "OPEN"} $${t.symbol} ${t.exitPrice ? t.xGain?.toFixed(2)+"x" : "holding"} [${t.signalType}]`
  ).join("\n");

  await bot.sendMessage(CHAT_ID,
    `Performance Report\n\n` +
    `Overall\n` +
    `Total Trades: ${db.stats.totalTrades}\n` +
    `Winners: ${db.stats.winners}\n` +
    `Losers: ${db.stats.losers}\n` +
    `Win Rate: ${db.stats.totalTrades > 0 ? ((db.stats.winners/db.stats.totalTrades)*100).toFixed(0) : 0}%\n` +
    `Total PnL: ${db.stats.totalPnlSol > 0 ? "+" : ""}${db.stats.totalPnlSol.toFixed(4)} SOL\n\n` +
    `By Signal Type\n` +
    `KOL:   ${byType.kol.trades} trades | ${kolWR}% WR | ${byType.kol.totalPnl.toFixed(3)} SOL\n` +
    `Pump:  ${byType.pump.trades} trades | ${pumpWR}% WR | ${byType.pump.totalPnl.toFixed(3)} SOL\n` +
    `Ultra: ${byType.ultra.trades} trades | ${ultraWR}% WR | ${byType.ultra.totalPnl.toFixed(3)} SOL\n\n` +
    `Best Trade: ${db.stats.bestTrade ? `$${db.stats.bestTrade.symbol} ${db.stats.bestTrade.xGain}x` : "N/A"}\n\n` +
    `Recent Trades\n` +
    `${recentTrades || "No trades yet"}\n\n` +
    `Brain Status: ${db.patterns.lastAnalyzed ? "Trained" : "Learning..."}\n` +
    `Best Signal: ${db.patterns.bestSignalType || "Collecting data..."}`
  );
}

async function handleGoLive() {
  const db = loadDB();
  const closedTrades = db.trades.filter(t => t.exitPrice);
  const winRate = db.stats.totalTrades > 0
    ? ((db.stats.winners / db.stats.totalTrades) * 100)
    : 0;

  // Check readiness
  const checks = {
    minTrades: closedTrades.length >= 50,
    winRate: winRate >= 40,
    brainTrained: db.patterns.lastAnalyzed !== null,
    bestSignalFound: db.patterns.bestSignalType !== null,
  };

  const allPassed = Object.values(checks).every(v => v === true);

  if (!allPassed) {
    const checkList =
      `${checks.minTrades ? "YES" : "NO"} Min 50 paper trades (${closedTrades.length}/50)\n` +
      `${checks.winRate ? "YES" : "NO"} Win rate above 40% (${winRate.toFixed(0)}%)\n` +
      `${checks.brainTrained ? "YES" : "NO"} Brain trained at least once\n` +
      `${checks.bestSignalFound ? "YES" : "NO"} Best signal type identified`;

    await bot.sendMessage(CHAT_ID,
      `NOT READY FOR LIVE TRADING\n\n` +
      `Checklist:\n` +
      `${checkList}\n\n` +
      `Complete all checks before going live.\n` +
      `Keep paper trading and let Claude learn.`
    );
    return;
  }

  // All checks passed
  tradingState.isLive = true;
  await bot.sendMessage(CHAT_ID,
    `LIVE TRADING ACTIVATED\n\n` +
    `All checks passed!\n\n` +
    `Win Rate: ${winRate.toFixed(0)}%\n` +
    `Trades Analyzed: ${closedTrades.length}\n` +
    `Best Signal: ${db.patterns.bestSignalType}\n` +
    `Best MC Range: ${db.patterns.bestMCRange || "N/A"}\n\n` +
    `Rules:\n` +
    `- Base capital $50 LOCKED\n` +
    `- Max 0.15 SOL per trade\n` +
    `- Stop loss -50% always active\n` +
    `- Max ${tradingState.maxDailyTrades} trades per day\n\n` +
    `Type /pause anytime to stop.\n` +
    `Good luck! Trade smart.`
  );
  console.log("LIVE TRADING ACTIVATED by owner");
}

async function handlePaper() {
  tradingState.isLive = false;
  await bot.sendMessage(CHAT_ID,
    `SWITCHED TO PAPER MODE\n\n` +
    `Real trading disabled.\n` +
    `All trades are simulated.\n` +
    `Capital is safe.\n\n` +
    `Type /golive when ready for real trading.`
  );
  console.log("Switched to paper mode by owner");
}

async function handleLimit(value) {
  const num = parseInt(value);
  if (isNaN(num) || num < 1 || num > 5) {
    await bot.sendMessage(CHAT_ID,
      `Invalid limit.\n` +
      `Usage: /limit N (1-5)\n` +
      `Example: /limit 3\n\n` +
      `Current limit: ${tradingState.maxDailyTrades}`
    );
    return;
  }
  tradingState.maxDailyTrades = num;
  await bot.sendMessage(CHAT_ID,
    `Daily trade limit updated\n\n` +
    `New limit: ${num} trades per day\n` +
    `Current today: ${tradingState.dailyTrades}/${num}`
  );
}

// ─── DAILY RESET ─────────────────────────────────────────
function resetDailyTrades() {
  const today = new Date().toDateString();
  if (tradingState.dailyTradeDate !== today) {
    tradingState.dailyTrades = 0;
    tradingState.dailyTradeDate = today;
  }
}

function incrementDailyTrades() {
  resetDailyTrades();
  tradingState.dailyTrades++;
}

function canTrade() {
  resetDailyTrades();
  return (
    !tradingState.isPaused &&
    tradingState.dailyTrades < tradingState.maxDailyTrades
  );
}

function isLiveMode() {
  return tradingState.isLive;
}

module.exports = {
  init,
  canTrade,
  isLiveMode,
  incrementDailyTrades,
  tradingState,
};

