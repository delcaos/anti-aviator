import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AVIATOR_RED,
  CONTINUOUS_CONFIG,
  applyPayout,
  createPlaneRun,
  deductStake,
  generateBotRun,
  generateChargePath,
  getPayoutOptions,
  maxSelectableAltitude,
  nextChargeAltitude,
  quoteAltitudeBet,
  randomPlaneColor,
  resolveRunStatus,
  settleRun,
  survivalChanceForAltitude,
} from '../src/game.js';

function hslHue(color) {
  return Number(color.match(/^hsl\((\d+),/)?.[1]);
}

test('anti-aircraft charge walk never goes below zero', () => {
  let altitude = 0;
  for (let index = 0; index < 25; index += 1) {
    altitude = nextChargeAltitude(altitude, 0.99);
    assert.equal(altitude, 0);
  }
});

test('generated charge path starts at current altitude and remains non-negative', () => {
  const path = generateChargePath(40, 20, () => 0.99);
  assert.equal(path.length, 41);
  assert.equal(path[0].altitudeTicks, 20);
  assert.ok(path.every((point) => point.altitudeTicks >= 0));
});

test('same-altitude entry is approximately a coin flip after the fixed ETA', () => {
  const steps = CONTINUOUS_CONFIG.entryEtaSeconds * 10;
  const chance = survivalChanceForAltitude(20, 20, steps);
  assert.ok(chance > 0.4);
  assert.ok(chance < 0.55);
});

test('payout options move planes lower or higher relative to the current charge', () => {
  const options = getPayoutOptions(20);
  const lowPayout = options.find((option) => option.payoutMultiplier === 1.2);
  const evenPayout = options.find((option) => option.payoutMultiplier === 2);
  const highPayout = options.find((option) => option.payoutMultiplier >= 10);

  assert.ok(lowPayout.altitudeTicks > evenPayout.altitudeTicks);
  assert.ok(highPayout.altitudeTicks < evenPayout.altitudeTicks);
  assert.ok(Math.abs(evenPayout.winChance - 0.5) < 0.15);
});

test('altitude quote derives payout from chosen altitude', () => {
  const risky = quoteAltitudeBet(20, 15);
  const safer = quoteAltitudeBet(20, 35);

  assert.ok(risky.valid);
  assert.ok(safer.valid);
  assert.equal(risky.altitudeTicks, 15);
  assert.equal(safer.altitudeTicks, 35);
  assert.ok(risky.payoutMultiplier > safer.payoutMultiplier);
  assert.ok(risky.winChance < safer.winChance);
});

test('altitude quote clamps to the selectable flight ceiling', () => {
  const quote = quoteAltitudeBet(20, 999);
  assert.equal(quote.altitudeTicks, maxSelectableAltitude(20));
  assert.ok(quote.valid);
});

test('plane run impact is scheduled 20 seconds after launch', () => {
  const option = getPayoutOptions(20).find((item) => item.payoutMultiplier === 2);
  const run = createPlaneRun({
    id: 'user-1',
    username: 'Pilot',
    kind: 'user',
    color: AVIATOR_RED,
    stakeCredits: 75,
    option,
    enteredAtMs: 1_000,
  });

  assert.equal(run.color, AVIATOR_RED);
  assert.equal(run.status, 'inbound');
  assert.equal(run.impactTimeMs, 21_000);
  assert.equal(run.exitsAtMs, 36_000);
});

test('settlement explodes planes at or below the flak altitude', () => {
  assert.equal(resolveRunStatus(19, 20), 'hit');
  assert.equal(resolveRunStatus(20, 20), 'hit');
  assert.equal(resolveRunStatus(21, 20), 'survived');
});

test('bot generation creates a valid inbound plane run', () => {
  let value = 0.13;
  const rng = () => {
    value = (value * 7.3 + 0.19) % 1;
    return value;
  };
  const bot = generateBotRun({
    id: 'bot-1',
    currentChargeAltitude: 20,
    enteredAtMs: 2_000,
    rng,
  });

  assert.equal(bot.id, 'bot-1');
  assert.equal(bot.kind, 'bot');
  assert.equal(bot.status, 'inbound');
  assert.match(bot.color, /^hsl\(\d+, \d+%, \d+%\)$/);
  assert.ok(hslHue(bot.color) >= 45 && hslHue(bot.color) <= 265);
  assert.ok(bot.altitudeTicks >= 1);
  assert.ok(bot.winChance > 0 && bot.winChance <= 1);
});

test('random plane color avoids aviator red-adjacent hues', () => {
  const values = [0, 0.5, 0.999];
  const color = randomPlaneColor(() => values.shift() ?? 0);
  const hue = hslHue(color);

  assert.equal(color, 'hsl(45, 84%, 66%)');
  assert.ok(hue >= 45 && hue <= 265);
  assert.notEqual(color.toLowerCase(), AVIATOR_RED);
});

test('balance deducts stake and pays stake times payout on survival', () => {
  const option = getPayoutOptions(20).find((item) => item.payoutMultiplier >= 2);
  const run = createPlaneRun({
    id: 'user-1',
    username: 'Pilot',
    kind: 'user',
    color: '#56cfe1',
    stakeCredits: 150,
    option,
    enteredAtMs: 1_000,
  });

  const afterStake = deductStake(1_000, run.stakeCredits);
  const hitRun = settleRun(run, run.altitudeTicks, 16_000);
  const survivedRun = settleRun(run, run.altitudeTicks - 1, 16_000);

  assert.equal(afterStake, 850);
  assert.equal(applyPayout(afterStake, hitRun), 850);
  assert.equal(applyPayout(afterStake, survivedRun), 850 + run.potentialPayout);
});
