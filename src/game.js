export const CONTINUOUS_CONFIG = Object.freeze({
  tickMs: 100,
  entryEtaSeconds: 20,
  exitAfterCenterSeconds: 15,
  maxStake: 300,
  startingBalance: 1_000,
  initialAltitude: 20,
  minAltitude: 0,
});

export const PAYOUT_MULTIPLIERS = Object.freeze([1.2, 1.5, 2, 3, 5, 8, 10, 15, 20, 30]);
export const MAX_DERIVED_PAYOUT = 999;
export const AVIATOR_RED = '#f3043f';

const BOT_COLOR_HUE_RANGES = Object.freeze([
  [45, 165],
  [185, 265],
]);

const BOT_NAMES = Object.freeze([
  'Aero',
  'Bandit',
  'Comet',
  'Dash',
  'Falcon',
  'Glider',
  'Halo',
  'Icarus',
  'Jet',
  'Kite',
  'Lancer',
  'Maverick',
  'Nomad',
  'Orbit',
  'Pilot',
  'Rocket',
  'Stratus',
  'Vector',
  'Warden',
  'Zephyr',
]);

const distributionCache = new Map();

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeStake(stakeCredits, balance = CONTINUOUS_CONFIG.maxStake) {
  const maxStake = Math.max(0, Math.min(CONTINUOUS_CONFIG.maxStake, Math.floor(balance)));
  if (maxStake < 1) {
    return 0;
  }
  return clamp(Math.round(Number(stakeCredits) || 1), 1, maxStake);
}

export function nextChargeAltitude(currentAltitude, randomValue = Math.random()) {
  return randomValue < 0.5
    ? currentAltitude + 1
    : Math.max(CONTINUOUS_CONFIG.minAltitude, currentAltitude - 1);
}

export function generateChargePath(
  steps = CONTINUOUS_CONFIG.entryEtaSeconds * 10,
  initialAltitude = CONTINUOUS_CONFIG.initialAltitude,
  rng = Math.random,
) {
  const points = [{ step: 0, altitudeTicks: initialAltitude }];
  let altitudeTicks = initialAltitude;

  for (let step = 1; step <= steps; step += 1) {
    altitudeTicks = nextChargeAltitude(altitudeTicks, rng());
    points.push({ step, altitudeTicks });
  }

  return points;
}

export function getFutureChargeDistribution(initialAltitude, steps) {
  const startAltitude = Math.max(0, Math.round(Number(initialAltitude) || 0));
  const normalizedSteps = Math.max(0, Math.round(Number(steps) || 0));
  const cacheKey = `${startAltitude}:${normalizedSteps}`;

  if (distributionCache.has(cacheKey)) {
    return distributionCache.get(cacheKey);
  }

  let probabilities = Array.from({ length: startAltitude + 1 }, () => 0);
  probabilities[startAltitude] = 1;

  for (let step = 0; step < normalizedSteps; step += 1) {
    const next = Array.from({ length: probabilities.length + 2 }, () => 0);
    probabilities.forEach((probability, altitude) => {
      if (probability === 0) {
        return;
      }
      next[altitude + 1] += probability * 0.5;
      next[Math.max(CONTINUOUS_CONFIG.minAltitude, altitude - 1)] += probability * 0.5;
    });
    probabilities = next;
  }

  distributionCache.set(cacheKey, probabilities);
  return probabilities;
}

export function survivalChanceForAltitude(initialChargeAltitude, planeAltitude, steps) {
  const altitude = Math.max(0, Math.round(Number(planeAltitude) || 0));
  if (altitude <= CONTINUOUS_CONFIG.minAltitude) {
    return 0;
  }

  return getFutureChargeDistribution(initialChargeAltitude, steps).reduce((sum, probability, chargeAltitude) => {
    return chargeAltitude < altitude ? sum + probability : sum;
  }, 0);
}

export function nearestAltitudeForWinChance(initialChargeAltitude, desiredWinChance, steps) {
  const target = clamp(Number(desiredWinChance) || 0, 0, 1);
  const maxSearchAltitude = Math.max(
    initialChargeAltitude + steps + 2,
    CONTINUOUS_CONFIG.initialAltitude + steps + 2,
  );
  let best = {
    altitudeTicks: 1,
    winChance: survivalChanceForAltitude(initialChargeAltitude, 1, steps),
    error: Number.POSITIVE_INFINITY,
  };

  for (let altitudeTicks = 1; altitudeTicks <= maxSearchAltitude; altitudeTicks += 1) {
    const winChance = survivalChanceForAltitude(initialChargeAltitude, altitudeTicks, steps);
    const error = Math.abs(winChance - target);
    if (error < best.error) {
      best = { altitudeTicks, winChance, error };
    }
  }

  return best;
}

export function maxSelectableAltitude(
  currentChargeAltitude,
  etaSeconds = CONTINUOUS_CONFIG.entryEtaSeconds,
) {
  const initialChargeAltitude = Math.max(0, Math.round(Number(currentChargeAltitude) || 0));
  const steps = Math.round(etaSeconds * (1000 / CONTINUOUS_CONFIG.tickMs));
  return Math.max(
    CONTINUOUS_CONFIG.initialAltitude + 20,
    Math.ceil((initialChargeAltitude + steps + 8) / 5) * 5,
  );
}

export function normalizeAltitudeTicks(
  altitudeTicks,
  currentChargeAltitude = CONTINUOUS_CONFIG.initialAltitude,
  etaSeconds = CONTINUOUS_CONFIG.entryEtaSeconds,
) {
  const maxAltitude = maxSelectableAltitude(currentChargeAltitude, etaSeconds);
  return clamp(Math.round(Number(altitudeTicks) || 1), 1, maxAltitude);
}

export function quoteAltitudeBet(
  currentChargeAltitude,
  altitudeTicks,
  etaSeconds = CONTINUOUS_CONFIG.entryEtaSeconds,
) {
  const initialChargeAltitude = Math.max(0, Math.round(Number(currentChargeAltitude) || 0));
  const normalizedAltitude = normalizeAltitudeTicks(altitudeTicks, initialChargeAltitude, etaSeconds);
  const steps = Math.round(etaSeconds * (1000 / CONTINUOUS_CONFIG.tickMs));
  const winChance = survivalChanceForAltitude(initialChargeAltitude, normalizedAltitude, steps);
  const rawPayout = winChance > 0 ? 1 / winChance : Number.POSITIVE_INFINITY;
  const payoutMultiplier = Number.isFinite(rawPayout)
    ? Math.round(Math.min(rawPayout, MAX_DERIVED_PAYOUT) * 100) / 100
    : null;

  return {
    payoutMultiplier,
    desiredWinChance: winChance,
    altitudeTicks: normalizedAltitude,
    altitudeOffsetTicks: normalizedAltitude - initialChargeAltitude,
    winChance,
    capped: rawPayout > MAX_DERIVED_PAYOUT,
    valid: winChance > 0 && payoutMultiplier !== null,
  };
}

export function getPayoutOptions(
  currentChargeAltitude,
  multipliers = PAYOUT_MULTIPLIERS,
  etaSeconds = CONTINUOUS_CONFIG.entryEtaSeconds,
) {
  const initialChargeAltitude = Math.max(0, Math.round(Number(currentChargeAltitude) || 0));
  const steps = Math.round(etaSeconds * (1000 / CONTINUOUS_CONFIG.tickMs));

  return multipliers
    .map((payoutMultiplier) => {
      const desiredWinChance = 1 / payoutMultiplier;
      const nearest = nearestAltitudeForWinChance(initialChargeAltitude, desiredWinChance, steps);
      const tolerance = Math.max(0.035, desiredWinChance * 0.3);
      return {
        payoutMultiplier,
        desiredWinChance,
        altitudeTicks: nearest.altitudeTicks,
        altitudeOffsetTicks: nearest.altitudeTicks - initialChargeAltitude,
        winChance: nearest.winChance,
        error: nearest.error,
        valid: nearest.error <= tolerance,
      };
    })
    .filter((option) => option.valid)
    .sort((a, b) => a.payoutMultiplier - b.payoutMultiplier);
}

export function createPlaneRun({
  id,
  username,
  kind,
  color,
  stakeCredits,
  option,
  enteredAtMs,
  etaSeconds = CONTINUOUS_CONFIG.entryEtaSeconds,
}) {
  if (!option) {
    throw new Error('A valid payout option is required to create a plane run.');
  }

  const normalizedStake = normalizeStake(stakeCredits, CONTINUOUS_CONFIG.maxStake);
  const potentialPayout = Math.round(normalizedStake * option.payoutMultiplier * 100) / 100;

  return {
    id,
    username: username || 'Pilot',
    kind,
    color,
    stakeCredits: normalizedStake,
    payoutMultiplier: option.payoutMultiplier,
    potentialPayout,
    enteredAtMs,
    impactTimeMs: enteredAtMs + etaSeconds * 1000,
    exitsAtMs: enteredAtMs + (etaSeconds + CONTINUOUS_CONFIG.exitAfterCenterSeconds) * 1000,
    altitudeTicks: option.altitudeTicks,
    altitudeOffsetTicks: option.altitudeOffsetTicks,
    winChance: option.winChance,
    status: 'inbound',
    chargeAltitudeAtImpact: null,
    settledAtMs: null,
  };
}

export function resolveRunStatus(planeAltitude, chargeAltitude) {
  return planeAltitude <= chargeAltitude ? 'hit' : 'survived';
}

export function settleRun(run, chargeAltitude, settledAtMs) {
  return {
    ...run,
    status: resolveRunStatus(run.altitudeTicks, chargeAltitude),
    chargeAltitudeAtImpact: chargeAltitude,
    settledAtMs,
  };
}

export function deductStake(balance, stakeCredits) {
  const stake = normalizeStake(stakeCredits, CONTINUOUS_CONFIG.maxStake);
  if (stake > balance) {
    throw new Error('Stake exceeds balance.');
  }
  return Math.round((balance - stake) * 100) / 100;
}

export function applyPayout(balance, run) {
  if (run.status !== 'survived') {
    return balance;
  }
  return Math.round((balance + run.potentialPayout) * 100) / 100;
}

export function randomInt(min, max, rng = Math.random) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function randomPlaneColor(rng = Math.random) {
  const hueCount = BOT_COLOR_HUE_RANGES.reduce((sum, [min, max]) => sum + (max - min + 1), 0);
  let hueIndex = randomInt(0, hueCount - 1, rng);
  let hue = BOT_COLOR_HUE_RANGES[0][0];

  for (const [min, max] of BOT_COLOR_HUE_RANGES) {
    const rangeSize = max - min + 1;
    if (hueIndex < rangeSize) {
      hue = min + hueIndex;
      break;
    }
    hueIndex -= rangeSize;
  }

  const saturation = randomInt(72, 96, rng);
  const lightness = randomInt(54, 66, rng);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

export function generateBotRun({
  id,
  currentChargeAltitude,
  enteredAtMs,
  rng = Math.random,
} = {}) {
  const stakeCredits = randomInt(10, CONTINUOUS_CONFIG.maxStake, rng);
  const options = getPayoutOptions(currentChargeAltitude);
  const fallback = nearestAltitudeForWinChance(
    currentChargeAltitude,
    0.5,
    CONTINUOUS_CONFIG.entryEtaSeconds * 10,
  );
  const option = options.length
    ? options[randomInt(0, options.length - 1, rng)]
    : {
        payoutMultiplier: 2,
        altitudeTicks: fallback.altitudeTicks,
        altitudeOffsetTicks: fallback.altitudeTicks - currentChargeAltitude,
        winChance: fallback.winChance,
      };
  const name = BOT_NAMES[randomInt(0, BOT_NAMES.length - 1, rng)];

  return createPlaneRun({
    id,
    username: name,
    kind: 'bot',
    color: randomPlaneColor(rng),
    stakeCredits,
    option,
    enteredAtMs,
  });
}
