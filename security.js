// ═══════════════════════════════════════════════════════════
//  SECURITY MODULE — Only you can control the bot
// ═══════════════════════════════════════════════════════════

const AUTHORIZED_CHAT_ID = process.env.CHAT_ID;

// ─── VERIFY COMMAND IS FROM YOU ──────────────────────────
function isAuthorized(chatId) {
  return String(chatId) === String(AUTHORIZED_CHAT_ID);
}

// ─── VALIDATE TRADE PARAMETERS ───────────────────────────
const HARD_LIMITS = {
  MAX_TRADE_SOL: 0.15,        // Claude can never exceed this
  MAX_DAILY_TRADES: 5,        // Max trades per day
  STOP_LOSS_PCT: 0.50,        // -50% stop loss always active
  BASE_CAPITAL_SOL: null,     // Set on first deposit, never touched
  MIN_CAPITAL_ALERT: 0.35,    // Alert if capital drops below this (SOL)
  MAX_SLIPPAGE_PCT: 2.0,      // Max slippage on Jupiter swaps
};

function validateTradeSize(sizeSol) {
  if (sizeSol > HARD_LIMITS.MAX_TRADE_SOL) {
    console.error(`SECURITY: Trade size ${sizeSol} exceeds max ${HARD_LIMITS.MAX_TRADE_SOL}`);
    return HARD_LIMITS.MAX_TRADE_SOL;
  }
  return sizeSol;
}

function validateDailyTrades(tradeCount) {
  if (tradeCount >= HARD_LIMITS.MAX_DAILY_TRADES) {
    console.log(`SECURITY: Daily trade limit reached (${HARD_LIMITS.MAX_DAILY_TRADES})`);
    return false;
  }
  return true;
}

function checkStopLoss(entryPrice, currentPrice) {
  const pctChange = (currentPrice - entryPrice) / entryPrice;
  return pctChange <= -HARD_LIMITS.STOP_LOSS_PCT;
}

function checkCapitalAlert(currentCapitalSol) {
  return currentCapitalSol <= HARD_LIMITS.MIN_CAPITAL_ALERT;
}

// ─── COMMAND WHITELIST ────────────────────────────────────
const ALLOWED_COMMANDS = [
  "/pause",
  "/resume",
  "/status",
  "/brain",
  "/withdraw",
  "/report",
  "/golive",
  "/paper",
  "/limit",
  "/help",
];

function isValidCommand(text) {
  if (!text) return false;
  const cmd = text.split(" ")[0].toLowerCase();
  return ALLOWED_COMMANDS.includes(cmd);
}

// ─── SECURITY MIDDLEWARE ──────────────────────────────────
function securityCheck(msg) {
  const chatId = msg?.chat?.id;
  const text = msg?.text || "";

  // Check authorization
  if (!isAuthorized(chatId)) {
    console.log(`SECURITY: Unauthorized access attempt from chat ${chatId}`);
    return { allowed: false, reason: "unauthorized" };
  }

  // Check command validity
  if (text.startsWith("/") && !isValidCommand(text)) {
    return { allowed: false, reason: "invalid_command" };
  }

  return { allowed: true };
}

// ─── TRADE SECURITY CHECK ─────────────────────────────────
function tradeSecurityCheck(params) {
  const errors = [];

  // Validate trade size
  if (params.sizeSol > HARD_LIMITS.MAX_TRADE_SOL) {
    errors.push(`Trade size ${params.sizeSol} SOL exceeds limit ${HARD_LIMITS.MAX_TRADE_SOL} SOL`);
  }

  // Validate daily trades
  if (params.dailyTradeCount >= HARD_LIMITS.MAX_DAILY_TRADES) {
    errors.push(`Daily trade limit reached: ${params.dailyTradeCount}/${HARD_LIMITS.MAX_DAILY_TRADES}`);
  }

  // Validate capital
  if (params.isBaseCapital) {
    errors.push("Cannot use base capital for trading");
  }

  // Validate slippage
  if (params.slippagePct > HARD_LIMITS.MAX_SLIPPAGE_PCT) {
    errors.push(`Slippage ${params.slippagePct}% exceeds max ${HARD_LIMITS.MAX_SLIPPAGE_PCT}%`);
  }

  return {
    approved: errors.length === 0,
    errors,
  };
}

module.exports = {
  isAuthorized,
  validateTradeSize,
  validateDailyTrades,
  checkStopLoss,
  checkCapitalAlert,
  securityCheck,
  tradeSecurityCheck,
  HARD_LIMITS,
};
