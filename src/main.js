import './styles.css';
import {
  CONTINUOUS_CONFIG,
  PAYOUT_MULTIPLIERS,
  applyPayout,
  createPlaneRun,
  deductStake,
  generateBotRun,
  getPayoutOptions,
  nextChargeAltitude,
  normalizeStake,
  randomInt,
  settleRun,
} from './game.js';

const STORAGE_KEYS = Object.freeze({
  balance: 'anti-aviator.balance',
  username: 'anti-aviator.username',
});

const USER_COLOR = '#f3043f';
const UI_REFRESH_MS = 160;
const BOT_MIN_GAP_MS = 700;
const BOT_MAX_GAP_MS = 1_900;
const HISTORY_LIMIT = 8;

const elements = {
  streamLabel: document.querySelector('#streamLabel'),
  phaseBadge: document.querySelector('#phaseBadge'),
  altitudeBadge: document.querySelector('#timerLabel'),
  balanceLabel: document.querySelector('#balanceLabel'),
  usernameInput: document.querySelector('#usernameInput'),
  stakeInput: document.querySelector('#stakeInput'),
  stakeRange: document.querySelector('#stakeRange'),
  stakeTimeLabel: document.querySelector('#stakeTimeLabel'),
  stakeCreditLabel: document.querySelector('#stakeCreditLabel'),
  payoutSelect: document.querySelector('#payoutSelect'),
  altitudeLabel: document.querySelector('#altitudeLabel'),
  chanceLabel: document.querySelector('#chanceLabel'),
  returnLabel: document.querySelector('#returnLabel'),
  placeBetButton: document.querySelector('#placeBetButton'),
  resetBalanceButton: document.querySelector('#resetBalanceButton'),
  betMessage: document.querySelector('#betMessage'),
  chartTitle: document.querySelector('#chartTitle'),
  canvas: document.querySelector('#gameCanvas'),
  playerList: document.querySelector('#playerList'),
  inspector: document.querySelector('#inspector'),
  historyList: document.querySelector('#historyList'),
};

const context = elements.canvas.getContext('2d');
const state = {
  balance: loadBalance(),
  currentAltitude: CONTINUOUS_CONFIG.initialAltitude,
  timeline: [],
  runs: [],
  history: [],
  hitboxes: [],
  selectedRunId: null,
  selectedPayout: null,
  nextBotAtMs: 0,
  lastTickAtMs: 0,
  lastUiRenderAt: 0,
  runSequence: 0,
  message: 'Airspace is live.',
};

function loadBalance() {
  const stored = Number.parseFloat(localStorage.getItem(STORAGE_KEYS.balance));
  return Number.isFinite(stored) && stored >= 0 ? stored : CONTINUOUS_CONFIG.startingBalance;
}

function saveBalance() {
  localStorage.setItem(STORAGE_KEYS.balance, String(state.balance));
}

function formatCredits(value) {
  return `${Math.round(value * 100) / 100}`;
}

function formatMultiplier(value) {
  return `${Number(value).toFixed(value % 1 === 0 ? 0 : 1)}x`;
}

function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatSeconds(value) {
  return `${Math.max(0, value).toFixed(1)}s`;
}

function formatOffset(offsetTicks) {
  if (offsetTicks === 0) {
    return 'current charge';
  }
  if (offsetTicks > 0) {
    return `+${offsetTicks} above charge`;
  }
  return `${offsetTicks} below charge`;
}

function statusLabel(status) {
  if (status === 'survived') {
    return 'Cleared';
  }
  if (status === 'hit') {
    return 'Exploded';
  }
  return 'Inbound';
}

function getCurrentStake() {
  return normalizeStake(elements.stakeInput.value, state.balance);
}

function getCurrentOptions() {
  return getPayoutOptions(state.currentAltitude);
}

function getSelectedOption() {
  const options = getCurrentOptions();
  if (!options.length) {
    state.selectedPayout = null;
    return null;
  }

  const selectedValue = Number(elements.payoutSelect.value || state.selectedPayout);
  const selected = options.find((option) => option.payoutMultiplier === selectedValue) || options[0];
  state.selectedPayout = selected.payoutMultiplier;
  return selected;
}

function updateChargeTimeline(now) {
  if (!state.lastTickAtMs) {
    state.lastTickAtMs = now;
    state.timeline = [{ timeMs: now, altitudeTicks: state.currentAltitude }];
    return;
  }

  let iterations = 0;
  while (state.lastTickAtMs + CONTINUOUS_CONFIG.tickMs <= now && iterations < 240) {
    state.lastTickAtMs += CONTINUOUS_CONFIG.tickMs;
    state.currentAltitude = nextChargeAltitude(state.currentAltitude);
    state.timeline.push({ timeMs: state.lastTickAtMs, altitudeTicks: state.currentAltitude });
    iterations += 1;
  }

  if (iterations >= 240) {
    state.lastTickAtMs = now;
    state.timeline.push({ timeMs: now, altitudeTicks: state.currentAltitude });
  }

  const oldestVisible = now - (CONTINUOUS_CONFIG.exitAfterCenterSeconds + 6) * 1000;
  state.timeline = state.timeline.filter((point) => point.timeMs >= oldestVisible);
}

function createRun({ username, kind, color, stakeCredits, option, enteredAtMs }) {
  state.runSequence += 1;
  return createPlaneRun({
    id: `${kind}-${state.runSequence}`,
    username,
    kind,
    color,
    stakeCredits,
    option,
    enteredAtMs,
  });
}

function spawnBot(enteredAtMs = performance.now()) {
  state.runSequence += 1;
  const run = generateBotRun({
    id: `bot-${state.runSequence}`,
    currentChargeAltitude: state.currentAltitude,
    enteredAtMs,
  });
  state.runs.push(run);
  if (!state.selectedRunId) {
    state.selectedRunId = run.id;
  }
}

function seedInitialTraffic(now) {
  for (let index = 0; index < 10; index += 1) {
    spawnBot(now - randomInt(0, 11_500));
  }
  state.nextBotAtMs = now + randomInt(350, 900);
}

function updateBotTraffic(now) {
  if (!state.nextBotAtMs) {
    state.nextBotAtMs = now + randomInt(350, 900);
  }

  let spawned = 0;
  while (now >= state.nextBotAtMs && spawned < 6) {
    spawnBot(state.nextBotAtMs);
    state.nextBotAtMs += randomInt(BOT_MIN_GAP_MS, BOT_MAX_GAP_MS);
    spawned += 1;
  }

  if (spawned >= 6 && now >= state.nextBotAtMs) {
    state.nextBotAtMs = now + randomInt(BOT_MIN_GAP_MS, BOT_MAX_GAP_MS);
  }
}

function settleDueRuns(now) {
  state.runs = state.runs.map((run) => {
    if (run.status !== 'inbound' || now < run.impactTimeMs) {
      return run;
    }

    const settled = settleRun(run, state.currentAltitude, now);
    if (settled.kind === 'user') {
      const beforePayout = state.balance;
      state.balance = applyPayout(state.balance, settled);
      saveBalance();
      state.history.unshift({
        id: `history-${settled.id}`,
        runId: settled.id,
        status: settled.status,
        stakeCredits: settled.stakeCredits,
        payoutMultiplier: settled.payoutMultiplier,
        delta: Math.round((state.balance - beforePayout) * 100) / 100,
      });
      state.history = state.history.slice(0, HISTORY_LIMIT);
      state.message = settled.status === 'survived'
        ? 'Your plane cleared the flak.'
        : 'Your plane exploded in the flak.';
    }
    return settled;
  });
}

function pruneOldRuns(now) {
  state.runs = state.runs.filter((run) => (
    run.exitsAtMs + 2_000 >= now || run.id === state.selectedRunId
  ));
}

function updateSimulation(now) {
  updateChargeTimeline(now);
  updateBotTraffic(now);
  settleDueRuns(now);
  pruneOldRuns(now);
}

function placeUserBet() {
  const username = elements.usernameInput.value.trim() || 'Pilot';
  const stakeCredits = getCurrentStake();
  const option = getSelectedOption();
  const now = performance.now();

  if (stakeCredits < 1 || stakeCredits > state.balance) {
    state.message = 'Insufficient balance.';
    renderControls();
    return;
  }

  if (!option) {
    state.message = 'No fair payout is available at the current charge altitude.';
    renderControls();
    return;
  }

  state.balance = deductStake(state.balance, stakeCredits);
  saveBalance();
  localStorage.setItem(STORAGE_KEYS.username, username);

  const run = createRun({
    username,
    kind: 'user',
    color: USER_COLOR,
    stakeCredits,
    option,
    enteredAtMs: now,
  });

  state.runs.unshift(run);
  state.selectedRunId = run.id;
  state.message = `Plane launched. Impact ETA ${CONTINUOUS_CONFIG.entryEtaSeconds}s.`;
  renderControls();
  renderPlayerList(now);
  renderInspector(now);
}

function resetBalance() {
  state.balance = CONTINUOUS_CONFIG.startingBalance;
  saveBalance();
  syncStakeBounds();
  renderControls();
}

function syncStakeBounds() {
  const maxStake = Math.max(0, Math.min(CONTINUOUS_CONFIG.maxStake, Math.floor(state.balance)));
  const previousStake = Number(elements.stakeInput.value) || 75;
  const nextStake = maxStake < 1 ? 0 : normalizeStake(previousStake, state.balance);

  elements.stakeInput.max = String(Math.max(1, maxStake));
  elements.stakeRange.max = String(Math.max(1, maxStake));
  elements.stakeInput.value = String(nextStake);
  elements.stakeRange.value = String(Math.max(1, nextStake));
}

function renderPayoutOptions() {
  const previousPayout = Number(elements.payoutSelect.value || state.selectedPayout);
  const currentValues = Array.from(elements.payoutSelect.options).map((option) => Number(option.value));
  const optionsAreCurrent = currentValues.length === PAYOUT_MULTIPLIERS.length
    && currentValues.every((value, index) => value === PAYOUT_MULTIPLIERS[index]);

  if (optionsAreCurrent) {
    return;
  }

  elements.payoutSelect.innerHTML = '';

  PAYOUT_MULTIPLIERS.forEach((payoutMultiplier) => {
    const item = document.createElement('option');
    item.value = String(payoutMultiplier);
    item.textContent = formatMultiplier(payoutMultiplier);
    elements.payoutSelect.append(item);
  });

  const selected = PAYOUT_MULTIPLIERS.includes(previousPayout) ? previousPayout : PAYOUT_MULTIPLIERS[0];
  elements.payoutSelect.value = String(selected);
  state.selectedPayout = selected;
}

function renderControls() {
  syncStakeBounds();
  renderPayoutOptions();

  const stakeCredits = getCurrentStake();
  const option = getSelectedOption();
  const canBet = Boolean(stakeCredits >= 1 && stakeCredits <= state.balance && option);

  elements.balanceLabel.textContent = formatCredits(state.balance);
  elements.stakeTimeLabel.textContent = `ETA ${CONTINUOUS_CONFIG.entryEtaSeconds}s`;
  elements.stakeCreditLabel.textContent = `${stakeCredits} credits`;
  elements.altitudeLabel.textContent = option
    ? `${option.altitudeTicks} ticks (${formatOffset(option.altitudeOffsetTicks)})`
    : '-';
  elements.chanceLabel.textContent = option ? formatPercent(option.winChance) : '-';
  elements.returnLabel.textContent = option
    ? `${formatCredits(stakeCredits * option.payoutMultiplier)} credits`
    : '-';
  elements.placeBetButton.disabled = !canBet;
  elements.betMessage.textContent = state.message;
}

function renderTopbar() {
  elements.streamLabel.textContent = 'Live airspace';
  elements.phaseBadge.textContent = 'Streaming';
  elements.phaseBadge.dataset.phase = 'live';
  elements.altitudeBadge.textContent = `Altitude ${state.currentAltitude}`;
  elements.chartTitle.textContent = 'Flak impact locked center';
}

function getVisibleRuns(now) {
  return state.runs
    .filter((run) => run.exitsAtMs + 2_000 >= now || run.id === state.selectedRunId)
    .sort((a, b) => a.impactTimeMs - b.impactTimeMs);
}

function getLaunchPreview(now = performance.now()) {
  const stakeCredits = getCurrentStake();
  const option = getSelectedOption();

  if (!option || stakeCredits < 1 || stakeCredits > state.balance) {
    return null;
  }

  return {
    id: 'launch-preview',
    username: elements.usernameInput.value.trim() || 'Pilot',
    kind: 'preview',
    color: USER_COLOR,
    stakeCredits,
    payoutMultiplier: option.payoutMultiplier,
    potentialPayout: Math.round(stakeCredits * option.payoutMultiplier * 100) / 100,
    impactTimeMs: now + CONTINUOUS_CONFIG.entryEtaSeconds * 1000,
    altitudeTicks: option.altitudeTicks,
    altitudeOffsetTicks: option.altitudeOffsetTicks,
    winChance: option.winChance,
    status: 'preview',
  };
}

function etaForRun(run, now) {
  return (run.impactTimeMs - now) / 1000;
}

function renderPlayerList(now = performance.now()) {
  const runs = getVisibleRuns(now);
  elements.playerList.innerHTML = '';

  if (!runs.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Planes are launching from the left.';
    elements.playerList.append(empty);
    return;
  }

  runs.forEach((run) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `player-row ${state.selectedRunId === run.id ? 'selected' : ''}`;
    item.dataset.status = run.status;
    item.addEventListener('click', () => {
      state.selectedRunId = run.id;
      renderPlayerList(now);
      renderInspector(now);
    });

    const marker = document.createElement('span');
    marker.className = 'player-marker';
    marker.style.background = run.color;

    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = run.username;

    const etaText = run.status === 'inbound'
      ? `ETA ${formatSeconds(etaForRun(run, now))}`
      : `flak ${run.chargeAltitudeAtImpact}`;
    const meta = document.createElement('span');
    meta.className = 'player-meta';
    meta.textContent = `${run.stakeCredits} cr | ${formatMultiplier(run.payoutMultiplier)} | ${etaText}`;

    const status = document.createElement('span');
    status.className = 'player-status';
    status.textContent = statusLabel(run.status);

    item.append(marker, name, meta, status);
    elements.playerList.append(item);
  });
}

function renderInspector(now = performance.now()) {
  const selected = state.runs.find((run) => run.id === state.selectedRunId);
  elements.inspector.innerHTML = '';

  if (!selected) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Select a plane on the chart or traffic list.';
    elements.inspector.append(empty);
    return;
  }

  const title = document.createElement('div');
  title.className = 'inspect-title';
  const swatch = document.createElement('span');
  swatch.style.background = selected.color;
  const name = document.createElement('strong');
  name.textContent = selected.username;
  title.append(swatch, name);

  const eta = etaForRun(selected, now);
  const list = document.createElement('dl');
  list.className = 'inspect-grid';
  const rows = [
    ['Stake', `${selected.stakeCredits} credits`],
    ['Payout', formatMultiplier(selected.payoutMultiplier)],
    ['Return', `${formatCredits(selected.potentialPayout)} credits`],
    ['Altitude', `${selected.altitudeTicks} ticks`],
    ['Offset', formatOffset(selected.altitudeOffsetTicks)],
    ['Win chance', formatPercent(selected.winChance)],
    ['ETA', selected.status === 'inbound' ? formatSeconds(eta) : 'resolved'],
    ['Status', statusLabel(selected.status)],
  ];

  if (selected.chargeAltitudeAtImpact !== null) {
    rows.splice(6, 0, ['Flak altitude', `${selected.chargeAltitudeAtImpact} ticks`]);
  }

  rows.forEach(([label, value]) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<dt>${label}</dt><dd>${value}</dd>`;
    list.append(wrapper);
  });

  elements.inspector.append(title, list);
}

function renderHistory() {
  elements.historyList.innerHTML = '';
  if (!state.history.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No resolved user flights.';
    elements.historyList.append(empty);
    return;
  }

  state.history.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = 'history-row';
    item.dataset.status = entry.status;
    item.innerHTML = `
      <span>Flight ${state.history.length - index}</span>
      <strong>${statusLabel(entry.status)}</strong>
      <small>${entry.stakeCredits} cr at ${formatMultiplier(entry.payoutMultiplier)}</small>
      <em>${entry.delta >= 0 ? '+' : ''}${formatCredits(entry.delta)}</em>
    `;
    elements.historyList.append(item);
  });
}

function renderUi(now) {
  renderTopbar();
  renderControls();
  renderPlayerList(now);
  renderInspector(now);
  renderHistory();
}

function resizeCanvas() {
  const canvas = elements.canvas;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(320, Math.floor(rect.height));

  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  return { width, height };
}

function getMaxAltitude(now) {
  const recentAltitude = state.timeline.reduce((max, point) => Math.max(max, point.altitudeTicks), state.currentAltitude);
  const runAltitude = getVisibleRuns(now).reduce((max, run) => Math.max(max, run.altitudeTicks), 0);
  const previewAltitude = getLaunchPreview(now)?.altitudeTicks ?? 0;
  return Math.max(40, Math.ceil((Math.max(recentAltitude, runAltitude, previewAltitude) + 8) / 10) * 10);
}

function createChartMapper(width, height, maxAltitude) {
  const padding = {
    left: 62,
    right: 36,
    top: 62,
    bottom: 58,
  };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const centerX = padding.left + plotWidth / 2;
  const rightX = width - padding.right;
  const leftX = padding.left;
  const bottomY = height - padding.bottom;
  const pxPerSecond = (centerX - leftX) / CONTINUOUS_CONFIG.entryEtaSeconds;

  return {
    padding,
    plotWidth,
    plotHeight,
    centerX,
    rightX,
    leftX,
    bottomY,
    pxPerSecond,
    xForImpactTime(impactTimeMs, now) {
      return centerX - ((impactTimeMs - now) / 1000) * pxPerSecond;
    },
    xForTimelineTime(timeMs, now) {
      return centerX + ((timeMs - now) / 1000) * pxPerSecond;
    },
    yForAltitude(altitudeTicks) {
      return bottomY - (altitudeTicks / maxAltitude) * plotHeight;
    },
  };
}

function drawCanvas(now = performance.now()) {
  const { width, height } = resizeCanvas();
  const maxAltitude = getMaxAltitude(now);
  const map = createChartMapper(width, height, maxAltitude);

  state.hitboxes = [];
  context.clearRect(0, 0, width, height);
  drawSky(width, height, map, now);
  drawGrid(width, height, map, maxAltitude);
  drawKillZone(map, now);
  drawChargePath(map, now);
  drawPlanes(map, now);
  drawLaunchPreview(map, now);
  drawAntiAircraftGun(map);
}

function drawSky(width, height, map, now) {
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#191512');
  sky.addColorStop(0.48, '#12110f');
  sky.addColorStop(1, '#050504');
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  context.save();
  context.globalAlpha = 0.22;
  context.strokeStyle = '#f3043f';
  context.lineWidth = 1;
  for (let y = map.padding.top; y <= map.bottomY; y += 34) {
    context.beginPath();
    context.moveTo(map.leftX, y + Math.sin((now / 600) + y) * 2);
    context.lineTo(map.rightX, y + Math.cos((now / 700) + y) * 2);
    context.stroke();
  }
  context.restore();
}

function drawGrid(width, height, map, maxAltitude) {
  context.save();
  context.strokeStyle = 'rgba(243, 4, 63, 0.18)';
  context.fillStyle = 'rgba(245, 245, 240, 0.76)';
  context.lineWidth = 1;
  context.font = '12px Inter, system-ui, sans-serif';

  for (let seconds = -15; seconds <= 15; seconds += 5) {
    const x = map.centerX + seconds * map.pxPerSecond;
    context.beginPath();
    context.moveTo(x, map.padding.top);
    context.lineTo(x, map.bottomY);
    context.stroke();
    const label = seconds === 0 ? 'impact' : `${seconds > 0 ? '+' : ''}${seconds}s`;
    context.fillText(label, x - 18, height - 25);
  }

  const altitudeStep = maxAltitude <= 50 ? 10 : 20;
  for (let altitude = 0; altitude <= maxAltitude; altitude += altitudeStep) {
    const y = map.yForAltitude(altitude);
    context.beginPath();
    context.moveTo(map.leftX, y);
    context.lineTo(map.rightX, y);
    context.stroke();
    context.fillText(`${altitude}`, 22, y + 4);
  }

  context.strokeStyle = 'rgba(243, 4, 63, 0.72)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(map.centerX, map.padding.top);
  context.lineTo(map.centerX, map.bottomY);
  context.stroke();

  context.fillStyle = 'rgba(245, 245, 240, 0.9)';
  context.font = '600 12px Inter, system-ui, sans-serif';
  context.fillText('impact timeline', width - 126, height - 25);
  context.save();
  context.translate(18, map.padding.top + map.plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText('altitude ticks', 0, 0);
  context.restore();

  context.strokeStyle = 'rgba(243, 4, 63, 0.75)';
  context.lineWidth = 1.5;
  context.strokeRect(map.leftX, map.padding.top, map.plotWidth, map.plotHeight);
  context.restore();
}

function visibleChargePoints(map, now) {
  return state.timeline
    .map((point) => ({
      ...point,
      x: map.xForTimelineTime(point.timeMs, now),
      y: map.yForAltitude(point.altitudeTicks),
    }))
    .filter((point) => point.x >= map.leftX - 40 && point.x <= map.centerX + 2);
}

function drawKillZone(map, now) {
  const points = visibleChargePoints(map, now);
  if (points.length < 2) {
    return;
  }

  const first = points[0];
  const last = points[points.length - 1];

  context.save();
  context.beginPath();
  context.moveTo(first.x, map.bottomY);
  points.forEach((point) => {
    context.lineTo(point.x, point.y);
  });
  context.lineTo(last.x, map.bottomY);
  context.closePath();
  context.fillStyle = 'rgba(243, 4, 63, 0.22)';
  context.fill();
  context.restore();
}

function drawChargePath(map, now) {
  const points = visibleChargePoints(map, now);
  if (!points.length) {
    return;
  }

  context.save();
  context.lineWidth = 3;
  context.strokeStyle = '#f3043f';
  context.shadowColor = 'rgba(243, 4, 63, 0.65)';
  context.shadowBlur = 12;
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  });
  context.stroke();
  context.restore();

  context.save();
  const recent = points.slice(-14);
  recent.forEach((point, index) => {
    context.globalAlpha = 0.25 + (index / recent.length) * 0.75;
    drawExplosion(point.x, point.y, 5 + index / 4, '#f3043f');
  });
  context.restore();
}

function drawAntiAircraftGun(map) {
  const gunX = map.rightX - 34;
  const gunY = map.bottomY - 12;
  const targetX = map.centerX;
  const targetY = map.yForAltitude(state.currentAltitude);

  context.save();
  context.strokeStyle = 'rgba(243, 4, 63, 0.7)';
  context.lineWidth = 2;
  context.setLineDash([8, 7]);
  context.beginPath();
  context.moveTo(gunX, gunY - 20);
  context.lineTo(targetX, targetY);
  context.stroke();
  context.setLineDash([]);
  drawExplosion(targetX, targetY, 10, '#f3043f');

  context.translate(gunX, gunY);
  context.fillStyle = '#f3043f';
  context.strokeStyle = '#111';
  context.lineWidth = 2;
  roundedRect(-28, -10, 58, 18, 5);
  context.fill();
  context.stroke();
  context.fillRect(-6, -30, 12, 24);
  context.strokeRect(-6, -30, 12, 24);
  context.beginPath();
  context.moveTo(-16, 8);
  context.lineTo(-28, 28);
  context.moveTo(16, 8);
  context.lineTo(30, 28);
  context.stroke();
  context.restore();
}

function drawPlanes(map, now) {
  getVisibleRuns(now).forEach((run) => {
    const x = map.xForImpactTime(run.impactTimeMs, now);
    if (x < map.leftX - 80 || x > map.rightX + 80) {
      return;
    }

    const y = map.yForAltitude(run.altitudeTicks);
    const selected = state.selectedRunId === run.id;

    drawPlane({
      x,
      y,
      color: run.status === 'hit'
        ? '#9a1f33'
        : run.status === 'survived'
          ? '#56cfe1'
          : run.color,
      selected,
      exploded: run.status === 'hit',
      label: run.username,
    });

    state.hitboxes.push({
      runId: run.id,
      x: x - 34,
      y: y - 24,
      width: 68,
      height: 48,
    });
  });
}

function drawLaunchPreview(map, now) {
  const preview = getLaunchPreview(now);
  if (!preview) {
    return;
  }

  const actualEntryX = map.xForImpactTime(preview.impactTimeMs, now);
  const x = Math.max(map.leftX + 24, actualEntryX);
  const y = map.yForAltitude(preview.altitudeTicks);
  const centerY = map.yForAltitude(state.currentAltitude);

  context.save();
  context.setLineDash([8, 7]);
  context.lineWidth = 1.5;
  context.strokeStyle = 'rgba(243, 4, 63, 0.65)';
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(map.centerX, y);
  context.stroke();
  context.setLineDash([4, 6]);
  context.strokeStyle = 'rgba(245, 245, 240, 0.48)';
  context.beginPath();
  context.moveTo(map.centerX, Math.min(y, centerY));
  context.lineTo(map.centerX, Math.max(y, centerY));
  context.stroke();
  context.restore();

  drawPlane({
    x,
    y,
    color: USER_COLOR,
    selected: true,
    preview: true,
    label: `${preview.username} preview`,
    meta: `${formatMultiplier(preview.payoutMultiplier)} | ${formatOffset(preview.altitudeOffsetTicks)}`,
  });
}

function drawPlane({ x, y, color, selected = false, exploded = false, preview = false, label, meta }) {
  context.save();
  context.translate(x, y);
  context.globalAlpha = preview ? 0.5 : exploded ? 0.78 : 1;
  context.shadowColor = selected ? 'rgba(243, 4, 63, 0.75)' : 'transparent';
  context.shadowBlur = selected ? 18 : 0;

  context.fillStyle = color;
  context.strokeStyle = selected ? '#fff4f7' : 'rgba(10, 8, 8, 0.9)';
  context.lineWidth = selected ? 3 : 2;
  if (preview) {
    context.setLineDash([5, 4]);
  }

  context.beginPath();
  context.moveTo(28, 0);
  context.lineTo(-18, -13);
  context.lineTo(-8, -3);
  context.lineTo(-30, -2);
  context.lineTo(-30, 2);
  context.lineTo(-8, 3);
  context.lineTo(-18, 13);
  context.closePath();
  context.fill();
  context.stroke();

  context.beginPath();
  context.moveTo(-18, 0);
  context.lineTo(-31, -13);
  context.lineTo(-25, 0);
  context.lineTo(-31, 13);
  context.closePath();
  context.fill();
  context.stroke();

  if (exploded) {
    context.restore();
    drawExplosion(x, y, 17, '#ffb000');
  } else {
    context.restore();
  }

  context.save();
  context.font = selected ? '700 13px Inter, system-ui, sans-serif' : '600 12px Inter, system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillStyle = '#f5f5f0';
  context.strokeStyle = 'rgba(3, 2, 2, 0.86)';
  context.lineWidth = 3;
  context.strokeText(label, x, y - 24);
  context.fillText(label, x, y - 24);
  if (meta) {
    context.font = '700 11px Inter, system-ui, sans-serif';
    context.strokeText(meta, x, y + 30);
    context.fillText(meta, x, y + 30);
  }
  context.restore();
}

function drawExplosion(x, y, radius, color) {
  context.save();
  context.translate(x, y);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.shadowColor = color;
  context.shadowBlur = 12;
  context.lineWidth = 2;
  for (let ray = 0; ray < 8; ray += 1) {
    const angle = (Math.PI * 2 * ray) / 8;
    context.beginPath();
    context.moveTo(Math.cos(angle) * (radius * 0.45), Math.sin(angle) * (radius * 0.45));
    context.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    context.stroke();
  }
  context.beginPath();
  context.arc(0, 0, radius * 0.35, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function roundedRect(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function handleCanvasClick(event) {
  const rect = elements.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = [...state.hitboxes].reverse().find((box) => (
    x >= box.x
      && x <= box.x + box.width
      && y >= box.y
      && y <= box.y + box.height
  ));

  if (hit) {
    state.selectedRunId = hit.runId;
    renderPlayerList(performance.now());
    renderInspector(performance.now());
  }
}

function syncStakeInputs(source) {
  const value = source === 'range' ? elements.stakeRange.value : elements.stakeInput.value;
  const stake = normalizeStake(value, state.balance);
  elements.stakeInput.value = String(stake);
  elements.stakeRange.value = String(Math.max(1, stake));
  renderControls();
}

function bindEvents() {
  elements.placeBetButton.addEventListener('click', placeUserBet);
  elements.resetBalanceButton.addEventListener('click', resetBalance);
  elements.stakeInput.addEventListener('input', () => syncStakeInputs('input'));
  elements.stakeRange.addEventListener('input', () => syncStakeInputs('range'));
  elements.payoutSelect.addEventListener('change', () => {
    state.selectedPayout = Number(elements.payoutSelect.value);
    renderControls();
  });
  elements.usernameInput.addEventListener('input', () => {
    localStorage.setItem(STORAGE_KEYS.username, elements.usernameInput.value.trim());
  });
  elements.canvas.addEventListener('click', handleCanvasClick);
  window.addEventListener('resize', () => drawCanvas(performance.now()));
}

function animationLoop(now) {
  updateSimulation(now);
  drawCanvas(now);

  if (now - state.lastUiRenderAt > UI_REFRESH_MS) {
    renderUi(now);
    state.lastUiRenderAt = now;
  }

  requestAnimationFrame(animationLoop);
}

function init() {
  const now = performance.now();
  elements.usernameInput.value = localStorage.getItem(STORAGE_KEYS.username) || 'Pilot';
  elements.stakeInput.value = '75';
  elements.stakeRange.value = '75';
  state.lastTickAtMs = now;
  state.timeline = [{ timeMs: now, altitudeTicks: state.currentAltitude }];
  bindEvents();
  syncStakeBounds();
  seedInitialTraffic(now);
  renderUi(now);
  requestAnimationFrame(animationLoop);
}

init();
