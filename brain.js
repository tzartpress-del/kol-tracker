// ─── CLAUDE BRAIN - LEARNING DATABASE ────────────────────────────────────────
// This module handles all learning, pattern recognition and decision making
// It gets smarter with every trade

const fs = require("fs");
const axios = require("axios");

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const DB_FILE = "./brain_data.json";

// ─── DATABASE STRUCTURE ───────────────────────────────────────────────────────
const defaultDB = {
  version: 1,
  created: Date.now(),
  lastUpdated: Date.now(),

  // Every single trade ever made
  trades: [],

  // Learned patterns (updated weekly)
  patterns: {
    bestSignalType: null,       // kol / pump / ultra
    bestScoreRange: null,       // e.g. "9-11"
    bestMCRange: null,          // e.g. "15k-40k"
    bestTimeOfDay: null,        // e.g. "02:00-06:00 UTC"
    bestVelocityRange: null,    // e.g. "1.5-3.0"
    holdPatterns: [],           // patterns that led to 10x+
    rugPatterns: [],            // patterns that led to rugs
    lastAnalyzed: null,
  },

  // Dynamic exit rules (updated by Claude based on performance)
  exitRules: {
    score_10_11: { tp1: 0.10, tp1_at: 2, tp2: 0.15, tp2_at: 5, holdPct: 0.75 },
    score_8_9:   { tp1: 0.25, tp1_at: 2, tp2: 0.25, tp2_at: 3, holdPct: 0.50 },
    score_5_7:   { tp1: 0.50, tp1_at: 2, tp2: 0.50, tp2_at: 3, holdPct: 0.00 },
    score_below5:{ tp1: 1.00, tp1_at: 2, tp2: 0,    tp2_at: 0, holdPct: 0.00 },
  },

  // Position sizing rules (updated by Claude)
  sizingRules: {
    score_10_11: 0.15,  // SOL
    score_8_9:   0.10,
    score_5_7:   0.05,
    score_below5: 0,    // skip
  },

  // 100x watchlist — tokens Claude thinks have potential
  watchlist100x: [],

  // Stats summary
  stats: {
    totalTrades: 0,
    winners: 0,
    losers: 0,
    rugs: 0,
    totalPnlSol: 0,
    best2x: 0,
    best5x: 0,
    best10x: 0,
    bestTrade: null,
    worstTrade: null,
    bySignalType: {
      kol:   { trades: 0, wins: 0, totalPnl: 0, avg2xRate: 0 },
      pump:  { trades: 0, wins: 0, totalPnl: 0, avg2xRate: 0 },
      ultra: { trades: 0, wins: 0, totalPnl: 0, avg2xRate: 0 },
    }
  }
};

// ─── LOAD / SAVE DB ───────────────────────────────────────────────────────────
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      return { ...defaultDB, ...data };
    }
  } catch(e) { console.error("DB load error:", e.message); }
  return { ...defaultDB };
}

function saveDB(db) {
  try {
    db.lastUpdated = Date.now();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch(e) { console.error("DB save error:", e.message); }
}

// ─── LOG A NEW TRADE ─────────────────────────────────────────────────────────
function logTrade(db, trade) {
  /*
  trade = {
    mint, symbol, signalType,
    entryPrice, entryMC, entryTime,
    score, velocity, smartCount, kolCount,
    holders, liquidity, rugRatio,
    devStatus, mintRenounced,
    insiderCount, aiRisk, aiConfidence,
    // filled in when closed:
    exitPrice, exitMC, exitTime,
    xGain, pnlSol, exitReason,
    peakX, timeTopeakMs,
  }
  */
  db.trades.push({ ...trade, id: Date.now() });

  // Update stats
  db.stats.totalTrades++;
  const type = db.stats.bySignalType[trade.signalType] || db.stats.bySignalType.kol;
  type.trades++;

  saveDB(db);
  console.log(`Brain: Logged trade $${trade.symbol} entry @ $${trade.entryPrice}`);
}

// ─── CLOSE A TRADE ───────────────────────────────────────────────────────────
function closeTrade(db, mint, exitPrice, exitReason) {
  const trade = db.trades.find(t => t.mint === mint && !t.exitPrice);
  if (!trade) return null;

  trade.exitPrice = exitPrice;
  trade.exitTime = Date.now();
  trade.xGain = exitPrice / trade.entryPrice;
  trade.pnlSol = trade.sizeSol * (trade.xGain - 1);
  trade.exitReason = exitReason;
  trade.timeToExitMs = trade.exitTime - trade.entryTime;

  // Update stats
  db.stats.totalPnlSol += trade.pnlSol;
  const type = db.stats.bySignalType[trade.signalType] || db.stats.bySignalType.kol;
  type.totalPnl += trade.pnlSol;

  if (trade.xGain >= 2) {
    db.stats.winners++;
    type.wins++;
    if (trade.xGain >= 10) db.stats.best10x++;
    else if (trade.xGain >= 5) db.stats.best5x++;
    else db.stats.best2x++;
    if (!db.stats.bestTrade || trade.xGain > db.stats.bestTrade.xGain) {
      db.stats.bestTrade = { symbol: trade.symbol, xGain: trade.xGain, signalType: trade.signalType };
    }
  } else if (trade.xGain < 0.5) {
    db.stats.rugs++;
    db.stats.losers++;
  } else {
    db.stats.losers++;
  }

  saveDB(db);
  console.log(`Brain: Closed $${trade.symbol} @ ${trade.xGain.toFixed(2)}x | PnL: ${trade.pnlSol > 0 ? "+" : ""}${trade.pnlSol.toFixed(4)} SOL`);
  return trade;
}

// ─── GET POSITION SIZE FROM BRAIN ────────────────────────────────────────────
function getPositionSize(db, score) {
  if (score >= 10) return db.sizingRules.score_10_11;
  if (score >= 8)  return db.sizingRules.score_8_9;
  if (score >= 5)  return db.sizingRules.score_5_7;
  return db.sizingRules.score_below5;
}

// ─── GET EXIT RULES FROM BRAIN ────────────────────────────────────────────────
function getExitRules(db, score) {
  if (score >= 10) return db.exitRules.score_10_11;
  if (score >= 8)  return db.exitRules.score_8_9;
  if (score >= 5)  return db.exitRules.score_5_7;
  return db.exitRules.score_below5;
}

// ─── CHECK 100x POTENTIAL ────────────────────────────────────────────────────
async function check100xPotential(db, token, score) {
  if (!CLAUDE_API_KEY) return false;
  if (score < 9) return false; // only check high score tokens

  try {
    const prompt = `You are analyzing a Solana memecoin for 100x potential.

Token: $${token.symbol}
Entry MC: $${token.market_cap}
Smart Money: ${token.smart_degen_count || 0}
KOL Holders: ${token.renowned_count || 0}
Velocity: ${token.velocity || 0}x
Holders: ${token.holder_count || 0}
Liquidity: $${token.liquidity || 0}
Dev Status: ${token.creator_token_status || "unknown"}
Mint Renounced: ${token.renounced_mint === 1 ? "yes" : "no"}
Bundle Rate: ${((token.bundler_trader_amount_rate || 0) * 100).toFixed(0)}%
Score: ${score}/11

Historical 100x patterns from our database:
${db.patterns.holdPatterns.slice(0, 3).map(p => `- ${p}`).join("\n") || "- Still collecting data"}

Does this token show 100x potential?
Consider: narrative strength, entry MC, smart money conviction, organic growth signs.

JSON only: {"potential100x": true/false, "reason": "brief", "holdStrategy": "exit_at_2x/hold_to_5x/hold_to_10x/diamond_hands", "confidence": 75}`;

    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 100, messages: [{ role: "user", content: prompt }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 10000 }
    );
    const text = res.data?.content?.[0]?.text || "";
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());

    if (result.potential100x) {
      db.watchlist100x.push({
        mint: token.address,
        symbol: token.symbol,
        entryMC: token.market_cap,
        addedAt: Date.now(),
        reason: result.reason,
        holdStrategy: result.holdStrategy,
        confidence: result.confidence,
      });
      saveDB(db);
      console.log(`Brain: 100x candidate detected! $${token.symbol} - ${result.reason}`);
    }
    return result;
  } catch(e) {
    console.error("100x check error:", e.message);
    return { potential100x: false, holdStrategy: "exit_at_2x" };
  }
}

// ─── WEEKLY LEARNING SESSION ──────────────────────────────────────────────────
async function weeklyLearning(db) {
  if (!CLAUDE_API_KEY) return;
  const closedTrades = db.trades.filter(t => t.exitPrice);
  if (closedTrades.length < 10) {
    console.log("Brain: Need 10+ closed trades before learning session");
    return;
  }

  console.log(`Brain: Starting weekly learning session with ${closedTrades.length} trades...`);

  try {
    // Prepare trade summary for Claude
    const summary = closedTrades.slice(-50).map(t =>
      `${t.symbol}|${t.signalType}|score:${t.score}|${t.xGain?.toFixed(2)}x|MC:${t.entryMC}|smart:${t.smartCount}|vel:${t.velocity?.toFixed(1)}|age:${Math.floor((t.timeToExitMs||0)/60000)}m`
    ).join("\n");

    const byType = db.stats.bySignalType;
    const prompt = `You are analyzing trading performance data to improve a Solana memecoin trading bot.

Trade History (last 50):
${summary}

Current Stats:
Total Trades: ${closedTrades.length}
Win Rate: ${((db.stats.winners / db.stats.totalTrades) * 100).toFixed(0)}%
Best Trade: ${db.stats.bestTrade ? `$${db.stats.bestTrade.symbol} ${db.stats.bestTrade.xGain}x` : "N/A"}
Total PnL: ${db.stats.totalPnlSol.toFixed(4)} SOL

By Signal Type:
KOL: ${byType.kol.trades} trades, ${byType.kol.wins} wins, ${byType.kol.totalPnl.toFixed(3)} SOL PnL
Pump: ${byType.pump.trades} trades, ${byType.pump.wins} wins, ${byType.pump.totalPnl.toFixed(3)} SOL PnL
Ultra: ${byType.ultra.trades} trades, ${byType.ultra.wins} wins, ${byType.ultra.totalPnl.toFixed(3)} SOL PnL

Analyze this data and provide updated trading rules.
What patterns lead to the best outcomes?
Which signal type performs best?
What score range is most reliable?
What hold strategy should we use?

JSON only:
{
  "bestSignalType": "kol/pump/ultra",
  "bestScoreRange": "8-11",
  "bestMCRange": "15k-50k",
  "holdPatterns": ["pattern1", "pattern2", "pattern3"],
  "rugPatterns": ["pattern1", "pattern2"],
  "updatedSizing": {
    "score_10_11": 0.15,
    "score_8_9": 0.10,
    "score_5_7": 0.05
  },
  "updatedExits": {
    "score_10_11": {"tp1": 0.10, "tp1_at": 2, "tp2": 0.15, "tp2_at": 5, "holdPct": 0.75},
    "score_8_9": {"tp1": 0.25, "tp1_at": 2, "tp2": 0.25, "tp2_at": 3, "holdPct": 0.50},
    "score_5_7": {"tp1": 0.50, "tp1_at": 2, "tp2": 0.50, "tp2_at": 3, "holdPct": 0.00}
  },
  "summary": "2-3 sentence insight about what's working"
}`;

    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: prompt }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 15000 }
    );

    const text = res.data?.content?.[0]?.text || "";
    const insights = JSON.parse(text.replace(/```json|```/g, "").trim());

    // Update database with learned patterns
    db.patterns.bestSignalType = insights.bestSignalType;
    db.patterns.bestScoreRange = insights.bestScoreRange;
    db.patterns.bestMCRange = insights.bestMCRange;
    db.patterns.holdPatterns = insights.holdPatterns || [];
    db.patterns.rugPatterns = insights.rugPatterns || [];
    db.patterns.lastAnalyzed = Date.now();

    // Update sizing and exit rules
    if (insights.updatedSizing) {
      db.sizingRules.score_10_11 = insights.updatedSizing.score_10_11;
      db.sizingRules.score_8_9 = insights.updatedSizing.score_8_9;
      db.sizingRules.score_5_7 = insights.updatedSizing.score_5_7;
    }
    if (insights.updatedExits) {
      db.exitRules = { ...db.exitRules, ...insights.updatedExits };
    }

    saveDB(db);
    console.log(`Brain: Learning complete! ${insights.summary}`);
    return insights;
  } catch(e) {
    console.error("Weekly learning error:", e.message);
    return null;
  }
}

// ─── GET BRAIN REPORT ─────────────────────────────────────────────────────────
function getBrainReport(db) {
  const p = db.patterns;
  const s = db.stats;
  const winRate = s.totalTrades > 0 ? ((s.winners / s.totalTrades) * 100).toFixed(0) : 0;

  return (
    `🧠 Brain Report\n\n` +
    `Trades: ${s.totalTrades} | Win Rate: ${winRate}%\n` +
    `Total PnL: ${s.totalPnlSol > 0 ? "+" : ""}${s.totalPnlSol.toFixed(4)} SOL\n` +
    `Best: ${s.bestTrade ? `$${s.bestTrade.symbol} ${s.bestTrade.xGain}x` : "N/A"}\n\n` +
    `Learned Patterns:\n` +
    `Best Signal: ${p.bestSignalType || "Learning..."}\n` +
    `Best Score: ${p.bestScoreRange || "Learning..."}\n` +
    `Best MC Entry: ${p.bestMCRange || "Learning..."}\n\n` +
    `100x Watchlist: ${db.watchlist100x.length} tokens\n` +
    `${db.watchlist100x.slice(0, 3).map(t => `- $${t.symbol} (${t.holdStrategy})`).join("\n")}\n\n` +
    `Last Analysis: ${p.lastAnalyzed ? new Date(p.lastAnalyzed).toLocaleDateString() : "Pending 10+ trades"}`
  );
}

module.exports = {
  loadDB, saveDB, logTrade, closeTrade,
  getPositionSize, getExitRules,
  check100xPotential, weeklyLearning,
  getBrainReport,
};
