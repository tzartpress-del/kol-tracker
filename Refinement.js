// ============================================================
// KOL TRACKER V11 - REFINEMENT MODULE
// Add this file to your project as:
// refinements.js
// ============================================================

// ------------------------------------------------------------
// HARD FILTER
// Reduces Claude API usage + removes weak garbage tokens
// ------------------------------------------------------------
function hardFilter(token) {
  const holders = token.holder_count || token.holders || 0;
  const liq = token.liquidity || 0;
  const rug = token.rug_ratio || 1;
  const bundle = token.bundler_trader_amount_rate || 1;
  const smart = token.smart_degen_count || 0;
  const top10 = token.top_10_holder_rate || 0;

  if (holders < 40) return false;
  if (liq < 7000) return false;
  if (rug > 0.18) return false;
  if (bundle > 0.25) return false;
  if (smart === 0) return false;
  if (top10 > 0.35) return false;

  return true;
}

// ------------------------------------------------------------
// VOLUME VELOCITY
// Detects momentum acceleration
// ------------------------------------------------------------
function getVelocity(token) {
  const vol5m = token.volume_5m || token.buy_volume_5m || 0;
  const vol1h = token.volume || token.volume_1h || 0;

  if (!vol1h || vol1h <= 0) {
    return {
      velocity: 0,
      label: "DEAD"
    };
  }

  const velocity = (vol5m * 12) / vol1h;

  let label = "NORMAL";

  if (velocity >= 2.5) label = "EXPLOSIVE 🔥🔥🔥";
  else if (velocity >= 1.5) label = "STRONG 🔥🔥";
  else if (velocity >= 1.0) label = "GOOD 🔥";
  else if (velocity >= 0.7) label = "WEAK ⚠️";
  else label = "DYING ❌";

  return {
    velocity: Number(velocity.toFixed(2)),
    label
  };
}

// ------------------------------------------------------------
// SOCIAL SCORE
// Extra confidence if socials exist
// ------------------------------------------------------------
function getSocialScore(token) {
  const twitter = token.twitter || token.twitter_username;
  const telegram = token.telegram;
  const website = token.website;

  const score =
    (twitter ? 1 : 0) +
    (telegram ? 1 : 0) +
    (website ? 1 : 0);

  return {
    score,
    hasTwitter: !!twitter,
    hasTelegram: !!telegram,
    hasWebsite: !!website,
  };
}

// ------------------------------------------------------------
// INSIDER CONVERGENCE
// Detects multiple proven wallets entering same token
// ------------------------------------------------------------
function getInsiderStrength(insiderWallets = []) {
  const count = insiderWallets.length;

  let label = "NONE";
  let score = 0;

  if (count >= 4) {
    label = "LEGENDARY CONVERGENCE 🔥🔥🔥";
    score = 5;
  } else if (count >= 3) {
    label = "VERY STRONG 🔥🔥";
    score = 4;
  } else if (count >= 2) {
    label = "STRONG 🔥";
    score = 3;
  } else if (count >= 1) {
    label = "MINOR ✅";
    score = 1;
  }

  return {
    count,
    label,
    score,
  };
}

// ------------------------------------------------------------
// DISTRIBUTION DETECTOR
// Warns if sellers overwhelm buyers
// ------------------------------------------------------------
function detectDistribution(token) {
  const buys = token.buy_5m || token.swaps_5m || 0;
  const sells = token.sell_5m || token.sells_5m || 0;

  if (sells > buys * 2 && sells > 10) {
    return {
      warning: true,
      message: "⚠️ Distribution detected"
    };
  }

  return {
    warning: false,
    message: "Healthy flow"
  };
}

// ------------------------------------------------------------
// ANTI FARM DETECTOR
// Attempts to catch fake activity
// ------------------------------------------------------------
function detectFarm(token) {
  const holders = token.holder_count || 0;
  const volume = token.volume || 0;
  const smart = token.smart_degen_count || 0;

  // suspicious holder count with no real volume
  if (holders > 500 && volume < 10000) {
    return true;
  }

  // huge volume with no smart money
  if (volume > 100000 && smart === 0) {
    return true;
  }

  return false;
}

// ------------------------------------------------------------
// FINAL SCORING ENGINE
// Main quality ranking system
// ------------------------------------------------------------
function calculateFinalScore({
  token,
  aiResult,
  velocity,
  insiderStrength,
  socialScore,
  signalScore,
}) {
  let score = 0;

  score += signalScore || 0;

  // Claude confidence boost
  score += (aiResult?.confidence || 0) / 20;

  // Momentum bonus
  score += velocity?.velocity || 0;

  // Insider bonus
  score += insiderStrength?.score || 0;

  // Socials bonus
  score += socialScore?.score || 0;

  // Liquidity bonus
  const liq = token.liquidity || 0;
  if (liq > 25000) score += 2;
  else if (liq > 15000) score += 1;

  // Holder bonus
  const holders = token.holder_count || 0;
  if (holders > 300) score += 2;
  else if (holders > 100) score += 1;

  // Penalties
  if (token.is_wash_trading) score -= 5;
  if ((token.rug_ratio || 0) > 0.15) score -= 3;
  if ((token.bundler_trader_amount_rate || 0) > 0.2) score -= 2;

  return Number(score.toFixed(2));
}

// ------------------------------------------------------------
// GLOBAL ALERT DEDUPE
// Prevents same token appearing in multiple scanners
// ------------------------------------------------------------
const globalAlerted = new Map();

function alreadyAlerted(mint, cooldownMs = 3600000) {
  const ts = globalAlerted.get(mint);

  if (!ts) return false;

  return Date.now() - ts < cooldownMs;
}

function markAlerted(mint) {
  globalAlerted.set(mint, Date.now());
}

function cleanupAlerts(cooldownMs = 3600000) {
  const now = Date.now();

  for (const [mint, ts] of globalAlerted.entries()) {
    if (now - ts > cooldownMs) {
      globalAlerted.delete(mint);
    }
  }
}

// ------------------------------------------------------------
// BLACKLIST SYSTEM
// Learns from rugs over time
// ------------------------------------------------------------
const blacklist = {
  deployers: new Set(),
  wallets: new Set(),
};

function addToBlacklist(deployer, wallets = []) {
  if (deployer) blacklist.deployers.add(deployer);

  for (const w of wallets) {
    blacklist.wallets.add(w);
  }
}

function isBlacklisted(token) {
  const deployer = token.creator || token.deployer_address;

  if (deployer && blacklist.deployers.has(deployer)) {
    return true;
  }

  return false;
}

// ------------------------------------------------------------
// MEMORY CLEANUP
// Prevents long term memory leaks
// ------------------------------------------------------------
function cleanupMap(map, maxAgeMs = 86400000) {
  const now = Date.now();

  for (const [key, value] of map.entries()) {
    const ts = value?.timestamp || value;

    if (typeof ts === "number" && now - ts > maxAgeMs) {
      map.delete(key);
    }
  }
}

// ------------------------------------------------------------
// SAFE ASYNC BATCH CLAUDE
// Faster than sequential AI processing
// ------------------------------------------------------------
async function processClaudeBatch(tokens, claudeFilter) {
  const results = await Promise.allSettled(
    tokens.map(async (token) => {
      const aiResult = await claudeFilter(token);

      return {
        token,
        aiResult,
      };
    })
  );

  return results
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);
}

// ------------------------------------------------------------
// SORT SIGNALS BY QUALITY
// ------------------------------------------------------------
function sortSignals(signals) {
  return signals.sort((a, b) => b.finalScore - a.finalScore);
}

// ------------------------------------------------------------
// PROCESS SIGNAL PIPELINE
// Main advanced ranking pipeline
// ------------------------------------------------------------
function enrichSignal(token, aiResult, signalScore, insiderWallets = []) {
  const velocity = getVelocity(token);
  const socialScore = getSocialScore(token);
  const insiderStrength = getInsiderStrength(insiderWallets);

  const finalScore = calculateFinalScore({
    token,
    aiResult,
    velocity,
    insiderStrength,
    socialScore,
    signalScore,
  });

  return {
    token,
    aiResult,
    velocity,
    socialScore,
    insiderStrength,
    finalScore,
  };
}

// ------------------------------------------------------------
// NODE SAFETY
// ------------------------------------------------------------
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

// ------------------------------------------------------------
// EXPORTS
// ------------------------------------------------------------
module.exports = {
  hardFilter,
  getVelocity,
  getSocialScore,
  getInsiderStrength,
  detectDistribution,
  detectFarm,
  calculateFinalScore,
  alreadyAlerted,
  markAlerted,
  cleanupAlerts,
  addToBlacklist,
  isBlacklisted,
  cleanupMap,
  processClaudeBatch,
  sortSignals,
  enrichSignal,
};

