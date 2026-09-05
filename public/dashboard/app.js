// SettleLoop Dashboard — app.js
// Vanilla JS. Communicates exclusively with the Express API via same-origin fetch.
// No Supabase client. No Gemini credentials. No external frameworks.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ══════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════
const S = {
  runId: null,
  creating: false,
  running: false,
  hasRun: false,
  lastSeed: null,
  lastMandates: null,
  lastMaxDays: null,
};

// ══════════════════════════════════════════════════════════
// THEME
// ══════════════════════════════════════════════════════════
function initTheme() {
  // Clear any persistent dark mode from previous sessions so default is strictly LIGHT
  try { localStorage.removeItem('sl-theme'); } catch (_) {}
  const saved = sessionStorage.getItem('sl-theme');
  const theme = saved === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  sessionStorage.setItem('sl-theme', next);
}

// ══════════════════════════════════════════════════════════
// FORMATTERS (NaN / Infinity / Null Protected)
// ══════════════════════════════════════════════════════════

/** Format a fraction (0–1) as a percentage string. Returns '—' for invalid. */
function fmtPct(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || val === null || val === undefined) return '—';
  return (n * 100).toFixed(1) + '%';
}

/** Format a plain number with fixed decimals. Returns '—' for invalid. */
function fmtNum(val, decimals = 2) {
  const n = Number(val);
  if (!Number.isFinite(n) || val === null || val === undefined) return '—';
  return n.toFixed(decimals);
}

/** Format amount without currency symbol (no currency in mandate schema). */
function fmtAmount(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || val === null || val === undefined) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format virtual days. */
function fmtDays(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || val === null || val === undefined) return '—';
  const d = n.toFixed(1);
  return d + (n === 1 ? ' day' : ' days');
}

/** Format lift absolute value as ±pp. Returns null if unavailable. */
function fmtLiftAbs(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || val === null || val === undefined) return null;
  const pct = Math.abs(n * 100).toFixed(1);
  const sign = n >= 0 ? '+' : '−';
  return sign + pct + ' pp';
}

/** Format lift relative. Returns null if unavailable. */
function fmtLiftRel(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || val === null || val === undefined) return null;
  const pct = Math.abs(n * 100).toFixed(1);
  const sign = n >= 0 ? '+' : '−';
  return sign + pct + '% relative';
}

/** Sanitize string for innerHTML to prevent XSS. */
function esc(str) {
  const d = document.createElement('div');
  d.textContent = String(str ?? '');
  return d.innerHTML;
}

// ══════════════════════════════════════════════════════════
// PURPOSEFUL NUMERIC ANIMATION (Count-up)
// ══════════════════════════════════════════════════════════
function animateCount(elId, targetVal, durationMs, formatter) {
  const el = document.getElementById(elId);
  if (!el) return;

  const n = Number(targetVal);
  if (!Number.isFinite(n) || targetVal === null || targetVal === undefined) {
    el.textContent = '—';
    return;
  }

  // Check prefers-reduced-motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = formatter(n);
    return;
  }

  const startVal = 0;
  const startTime = performance.now();

  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    // Ease-out cubic
    const ease = 1 - Math.pow(1 - progress, 3);
    const current = startVal + (n - startVal) * ease;
    el.textContent = formatter(current);

    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      el.textContent = formatter(n); // Ensure exact final value
    }
  }

  requestAnimationFrame(tick);
}

// ══════════════════════════════════════════════════════════
// DOM UTILITIES
// ══════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const show = el => (typeof el === 'string' ? $(el) : el)?.classList.remove('hidden');
const hide = el => (typeof el === 'string' ? $(el) : el)?.classList.add('hidden');

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = String(text ?? '—');
}

function setHTML(id, html) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

function showAlert(containerId, type, html) {
  const el = $(containerId);
  if (!el) return;
  el.className = 'alert alert-' + type;
  el.innerHTML = html;
  show(el);
}

function hideAlert(id) { hide(id); }

// ══════════════════════════════════════════════════════════
// LIFECYCLE INDICATOR
// ══════════════════════════════════════════════════════════
function setLifecycleStep(activeStepName) {
  const steps = ['configure', 'create', 'ready', 'run', 'results'];
  const activeIdx = steps.indexOf(activeStepName);
  if (activeIdx === -1) return;

  steps.forEach((name, idx) => {
    const el = $('step-' + name);
    if (!el) return;
    el.classList.remove('active', 'completed');
    if (idx < activeIdx) {
      el.classList.add('completed');
    } else if (idx === activeIdx) {
      el.classList.add('active');
    }
  });
}

// ══════════════════════════════════════════════════════════
// EXPERIMENT PREVIEW (Before Creation)
// ══════════════════════════════════════════════════════════
function updateExperimentPreview() {
  const mandates = $('input-mandates')?.value || '9';
  const days = $('input-maxdays')?.value || '7';
  setText('prev-mandates', mandates);
  setText('prev-days', days);
}

// ══════════════════════════════════════════════════════════
// API WRAPPERS
// ══════════════════════════════════════════════════════════
async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  }
  return data;
}

async function apiGet(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  }
  return data;
}

// ══════════════════════════════════════════════════════════
// CREATE SIMULATION
// ══════════════════════════════════════════════════════════
async function createSimulation() {
  if (S.creating || S.running) return;
  hideAlert('setup-alert');

  const seed = parseInt($('input-seed').value, 10);
  const mandateCount = parseInt($('input-mandates').value, 10);
  const maxDays = parseInt($('input-maxdays').value, 10);

  if (!Number.isFinite(seed)) {
    return showAlert('setup-alert', 'error', 'Seed must be a valid integer.');
  }
  if (!Number.isFinite(mandateCount) || mandateCount < 1 || mandateCount > 10000) {
    return showAlert('setup-alert', 'error', 'Mandate count must be an integer between 1 and 10,000.');
  }
  if (!Number.isFinite(maxDays) || maxDays < 1 || maxDays > 365) {
    return showAlert('setup-alert', 'error', 'Max virtual days must be an integer between 1 and 365.');
  }

  S.creating = true;
  setLifecycleStep('create');
  updateCreateBtn();
  updateRunBtn();
  showAlert('setup-alert', 'loading',
    '<div class="spinner"></div>&nbsp; Generating synthetic workload and initializing virtual clock in PostgreSQL&hellip;');

  try {
    const result = await apiPost('/api/simulations', { seed, mandateCount, maxDays });
    if (!result.runId) throw new Error('Server did not return a runId.');

    // Save state
    S.runId = result.runId;
    S.hasRun = false;
    S.lastSeed = seed;
    S.lastMandates = mandateCount;
    S.lastMaxDays = maxDays;

    // Display actual returned Run ID
    $('run-id-display').textContent = result.runId;
    updateRunStatusUI({ currentDay: 0, maxDays, status: 'created' }, null);
    hide('run-empty');
    show('run-info');

    // Reset results & set strategies to awaiting state
    hide('results-content');
    show('results-empty');
    resetStrategyMetricsToAwaiting();
    hideAlert('run-alert');

    showAlert('setup-alert', 'success',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>&nbsp; Simulation ready &mdash; Run ID: <code style="font-family:monospace;font-size:11.5px">' + esc(result.runId) + '</code>');

    setLifecycleStep('ready');
  } catch (err) {
    showAlert('setup-alert', 'error', 'Simulation creation failed: ' + esc(err.message));
    setLifecycleStep('configure');
  } finally {
    S.creating = false;
    updateCreateBtn();
    updateRunBtn();
  }
}

// ══════════════════════════════════════════════════════════
// RUN SIMULATION
// ══════════════════════════════════════════════════════════
async function runSimulation() {
  if (!S.runId || S.running || S.creating) return;
  hideAlert('run-alert');

  S.running = true;
  setLifecycleStep('run');
  updateRunBtn();
  showAlert('run-alert', 'loading',
    '<div class="spinner"></div>&nbsp; Executing recovery &mdash; Control &amp; Baseline processing deterministically; Smart arm invoking live Gemini. Please wait...');

  try {
    // Run all-arm recovery
    const runResult = await apiPost('/api/simulations/' + S.runId + '/run', {});
    S.hasRun = true;

    // Fetch fresh run state
    let runInfo = null;
    try { runInfo = await apiGet('/api/simulations/' + S.runId); } catch (_) { }

    // Update run info UI with execution result
    updateRunStatusUI(runInfo, runResult);

    // Fetch live metrics
    let metrics = null;
    try {
      metrics = await apiGet('/api/simulations/' + S.runId + '/metrics');
    } catch (mErr) {
      showAlert('run-alert', 'error',
        'Simulation completed but metrics could not be loaded: ' + esc(mErr.message));
      return;
    }

    // Render results with animated reveal
    renderResults(metrics);
    show('results-content');
    hide('results-empty');
    setLifecycleStep('results');

    // Label with run parameters
    if (S.lastSeed !== null) {
      const label = 'seed ' + S.lastSeed + ' · ' + (S.lastMandates ?? '?') + ' mandates · ' + (S.lastMaxDays ?? '?') + ' virtual days';
      setText('result-seed-label', label);
    }

    hideAlert('run-alert');
  } catch (err) {
    S.hasRun = false;
    showAlert('run-alert', 'error', 'Simulation run error: ' + esc(err.message));
    setLifecycleStep('ready');
  } finally {
    S.running = false;
    updateRunBtn();
  }
}

// ══════════════════════════════════════════════════════════
// UI STATE UPDATES
// ══════════════════════════════════════════════════════════
function updateCreateBtn() {
  const btn = $('btn-create');
  if (!btn) return;
  btn.disabled = S.creating || S.running;
  if (S.creating) {
    btn.innerHTML = '<div class="spinner"></div> Creating&hellip;';
  } else {
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Create Simulation';
  }
}

function updateRunBtn() {
  const btn = $('btn-run');
  if (!btn) return;
  const hasRunId = !!S.runId;
  btn.disabled = !hasRunId || S.running || S.creating || S.hasRun;

  if (S.running) {
    btn.innerHTML = '<div class="spinner"></div> Executing simulation&hellip;';
  } else if (S.hasRun) {
    btn.innerHTML = 'Simulation Complete — Create New to Run Again';
    btn.title = 'Create a new simulation to test different parameters.';
  } else {
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg> Run Full Simulation';
    btn.title = '';
  }
}

function updateRunStatusUI(runInfo, runResult) {
  // Persisted status from DB
  const statusEl = $('run-status');
  if (statusEl && runInfo) {
    const st = (runInfo.status || '').toLowerCase();
    statusEl.textContent = runInfo.status || '—';
    statusEl.className = 'status-pill status-' + (['running', 'created', 'completed'].includes(st) ? st : 'other');
  }

  // Virtual Day counter
  if (runInfo) {
    if (runInfo.currentDay !== undefined) setText('run-day', runInfo.currentDay);
    if (runInfo.maxDays !== undefined) setText('run-max', runInfo.maxDays);
  }

  // Execution result
  const execEl = $('exec-status');
  if (execEl) {
    if (runResult) {
      const reason = runResult.results?.terminatedReason || runResult.terminatedReason || '';
      const reasonLabel = {
        'reached_max_days': 'Completed — reached horizon',
        'no_future_actions_within_window': 'Completed — no pending actions',
        'zero_advance_guard': 'Completed — zero advance guard',
      }[reason] || 'Completed';
      execEl.textContent = reasonLabel;
      execEl.className = 'exec-pill exec-success';
    } else if (S.running) {
      execEl.textContent = 'Running…';
      execEl.className = 'exec-pill';
    } else if (!S.hasRun) {
      execEl.textContent = 'Not yet run';
      execEl.className = 'exec-pill';
    }
  }
}

// ══════════════════════════════════════════════════════════
// RENDER RESULTS
// ══════════════════════════════════════════════════════════
function renderResults(m) {
  if (!m) return;
  const arms = m.arms || {};
  const lift = m.lift || {};
  const safety = m.safety || null;

  renderStrategyCardsMetrics(arms);
  renderRateHighlights(arms);
  renderComparisonTable(arms);
  renderLift(lift);
  renderSafety(safety);
}

// ── Strategy cards awaiting vs metric view ────────────────
function resetStrategyMetricsToAwaiting() {
  ['ctrl', 'base', 'smart'].forEach(p => {
    show(p + '-awaiting');
    hide(p + '-metrics');
  });
}

function renderStrategyCardsMetrics(arms) {
  const defs = [
    { prefix: 'ctrl', arm: arms.control || {} },
    { prefix: 'base', arm: arms.baseline || {} },
    { prefix: 'smart', arm: arms.smart || {} },
  ];

  for (const { prefix, arm } of defs) {
    hide(prefix + '-awaiting');
    show(prefix + '-metrics');

    // Smooth count-up for recovery rate
    animateCount(prefix + '-rate', (arm.recoveryRate ?? 0) * 100, 700, v => v.toFixed(1) + '%');

    setText(prefix + '-recovered', arm.recoveredCount !== undefined
      ? (arm.recoveredCount + ' / ' + (arm.mandateCount ?? '—'))
      : '—');
    setText(prefix + '-attempts', fmtNum(arm.attemptsTotal, 0));
  }
}

// ── Rate highlights ────────────────────────────────────────
function renderRateHighlights(arms) {
  const ctrl = arms.control || {};
  const base = arms.baseline || {};
  const smart = arms.smart || {};

  // High-impact rate animations
  animateCount('r-ctrl-rate', (ctrl.recoveryRate ?? 0) * 100, 800, v => v.toFixed(1) + '%');
  animateCount('r-base-rate', (base.recoveryRate ?? 0) * 100, 800, v => v.toFixed(1) + '%');
  animateCount('r-smart-rate', (smart.recoveryRate ?? 0) * 100, 800, v => v.toFixed(1) + '%');

  setText('r-ctrl-rec', ctrl.recoveredCount ?? '—');
  setText('r-ctrl-total', ctrl.mandateCount ?? '—');

  setText('r-base-rec', base.recoveredCount ?? '—');
  setText('r-base-total', base.mandateCount ?? '—');

  setText('r-smart-rec', smart.recoveredCount ?? '—');
  setText('r-smart-total', smart.mandateCount ?? '—');
}

// ── Comparison Table ───────────────────────────────────────
function renderComparisonTable(arms) {
  const ctrl = arms.control || {};
  const base = arms.baseline || {};
  const smart = arms.smart || {};

  const rows = [
    { label: 'Recovery rate', ctrl: fmtPct(ctrl.recoveryRate), base: fmtPct(base.recoveryRate), smart: fmtPct(smart.recoveryRate) },
    { label: 'Mandates', ctrl: ctrl.mandateCount ?? null, base: base.mandateCount ?? null, smart: smart.mandateCount ?? null },
    { label: 'Recovered mandates', ctrl: ctrl.recoveredCount ?? null, base: base.recoveredCount ?? null, smart: smart.recoveredCount ?? null },
    { label: 'Total amount', ctrl: fmtAmount(ctrl.totalAmount), base: fmtAmount(base.totalAmount), smart: fmtAmount(smart.totalAmount) },
    { label: 'Recovered amount', ctrl: fmtAmount(ctrl.recoveredAmount), base: fmtAmount(base.recoveredAmount), smart: fmtAmount(smart.recoveredAmount) },
    { label: 'Executed attempts', ctrl: ctrl.attemptsTotal ?? null, base: base.attemptsTotal ?? null, smart: smart.attemptsTotal ?? null },
    { label: 'Attempts / mandate', ctrl: fmtNum(ctrl.attemptsPerMandate), base: fmtNum(base.attemptsPerMandate), smart: fmtNum(smart.attemptsPerMandate) },
    { label: 'Attempts / recovery', ctrl: fmtNum(ctrl.attemptsPerRecovery), base: fmtNum(base.attemptsPerRecovery), smart: fmtNum(smart.attemptsPerRecovery) },
    { label: 'Avg time to recovery', ctrl: fmtDays(ctrl.averageTimeToRecovery), base: fmtDays(base.averageTimeToRecovery), smart: fmtDays(smart.averageTimeToRecovery) },
  ];

  const tbody = $('comparison-tbody');
  if (!tbody) return;

  tbody.innerHTML = rows.map(r => {
    const fmtCell = v => {
      const str = (v === null || v === undefined) ? '—' : String(v);
      const isNA = str === '—';
      return `<td class="${isNA ? 'na' : ''}">${esc(str)}</td>`;
    };
    return `<tr><td>${esc(r.label)}</td>${fmtCell(r.ctrl)}${fmtCell(r.base)}${fmtCell(r.smart)}</tr>`;
  }).join('');
}

// ── Smart Lift ─────────────────────────────────────────────
function renderLift(lift) {
  renderLiftBox('lift-vs-control', lift.vsControl);
  renderLiftBox('lift-vs-baseline', lift.vsBaseline);
}

function renderLiftBox(boxId, liftObj) {
  const box = $(boxId);
  if (!box) return;

  const absEl = box.querySelector('.lift-stat-abs');
  const relEl = box.querySelector('.lift-stat-rel');
  if (!absEl || !relEl) return;

  if (!liftObj) {
    absEl.textContent = 'Comparison unavailable';
    absEl.className = 'lift-stat-abs lift-abs-na';
    relEl.textContent = '';
    return;
  }

  const abs = liftObj.absolute;
  const rel = liftObj.relative;

  const absStr = fmtLiftAbs(abs);
  const relStr = fmtLiftRel(rel);

  if (absStr === null) {
    absEl.textContent = 'Comparison unavailable';
    absEl.className = 'lift-stat-abs lift-abs-na';
    relEl.textContent = '';
    return;
  }

  const n = Number(abs);
  const cls = n > 0 ? 'lift-abs-pos' : n < 0 ? 'lift-abs-neg' : 'lift-abs-zero';
  absEl.className = 'lift-stat-abs ' + cls;

  // Animate absolute lift count-up
  animateCount(absEl.id || (boxId + '-abs-val'), n * 100, 700, v => {
    const sign = v >= 0 ? '+' : '−';
    return sign + Math.abs(v).toFixed(1) + ' pp';
  });

  relEl.textContent = relStr !== null ? relStr : 'Relative: N/A (base rate 0%)';
}

// ── Safety ─────────────────────────────────────────────────
function renderSafety(safety) {
  const banner = $('safety-status-banner');
  if (!banner) return;

  if (!safety) {
    banner.className = 'safety-banner safety-unknown';
    banner.innerHTML = safetyIcon('unknown') + ' Safety data unavailable';
    setHTML('safety-violations', '');
    return;
  }

  const safeVal = safety.safe;
  const total = safety.totalViolations;

  let bannerClass, bannerText;
  if (safeVal === true && total === 0) {
    bannerClass = 'safety-safe';
    bannerText = safetyIcon('safe') + ' <span><strong>SAFE</strong> &mdash; No tracked safety violations detected</span>';
  } else if (safeVal === false || (total !== undefined && total > 0)) {
    bannerClass = 'safety-unsafe';
    bannerText = safetyIcon('unsafe') + ' <span><strong>ATTENTION</strong> &mdash; Tracked safety violations detected</span>';
  } else if (safeVal === undefined && total === undefined) {
    bannerClass = 'safety-unknown';
    bannerText = safetyIcon('unknown') + ' <span>Safety data unavailable</span>';
  } else {
    bannerClass = 'safety-warn';
    bannerText = safetyIcon('warn') + ' <span>Safety data &mdash; verify counters below</span>';
  }

  banner.className = 'safety-banner ' + bannerClass;
  banner.innerHTML = bannerText;

  const fields = [
    { key: 'hardDeclineRetryViolations', label: 'Hard-decline retry violations' },
    { key: 'duplicateAttemptViolations', label: 'Duplicate-attempt violations' },
    { key: 'consentViolations', label: 'Consent violations' },
    { key: 'notificationViolations', label: 'Notification violations' },
    { key: 'totalViolations', label: 'Total violations' },
  ];

  const container = $('safety-violations');
  if (!container) return;

  container.innerHTML = fields.map(f => {
    const val = safety[f.key];
    let valHtml;
    if (val === undefined || val === null) {
      valHtml = `<span class="violation-val vval-na">Not tracked</span>`;
    } else {
      const n = Number(val);
      const cls = n === 0 ? 'vval-zero' : 'vval-nonzero';
      valHtml = `<span class="violation-val ${cls}">${esc(String(val))}</span>`;
    }
    const isTotalRow = f.key === 'totalViolations' ? ' style="font-weight:700;border-color:var(--border-2)"' : '';
    return `<div class="violation-row"${isTotalRow}><span class="violation-key">${esc(f.label)}</span>${valHtml}</div>`;
  }).join('');
}

function safetyIcon(type) {
  const icons = {
    safe: '<svg class="safety-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    unsafe: '<svg class="safety-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    warn: '<svg class="safety-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 9v4M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    unknown: '<svg class="safety-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  return icons[type] || icons.unknown;
}

// ══════════════════════════════════════════════════════════
// SMOOTH SCROLL FOR NAV LINKS
// ══════════════════════════════════════════════════════════
function initNavLinks() {
  document.querySelectorAll('a.nav-link[href^="#"], a.btn[href^="#"]').forEach(link => {
    link.addEventListener('click', e => {
      const targetId = link.getAttribute('href');
      if (targetId === '#') return;
      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

// ══════════════════════════════════════════════════════════
// ARCHITECTURE VISUALIZATION & MOTION FLOW
// ══════════════════════════════════════════════════════════
let archTimers = [];
let archHasPlayed = false;

function resetArchAnimation() {
  archTimers.forEach(t => clearTimeout(t));
  archTimers = [];

  const layers = ['arch-layer-1', 'arch-layer-2', 'arch-layer-3', 'arch-layer-4'];
  layers.forEach(id => {
    const el = $(id);
    if (el) el.classList.remove('revealed');
  });

  const pulseSelectors = [
    '#conn-1 .conn-pulse',
    '#conn-2 .branch-pulse-dot',
    '#conn-3 .converge-pulse-dot'
  ];
  pulseSelectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => el.classList.remove('animating'));
  });
}

function playArchAnimation() {
  resetArchAnimation();

  // Force reflow so restarted animations trigger cleanly
  const mapEl = $('arch-map');
  if (mapEl) void mapEl.offsetWidth;

  // Respect prefers-reduced-motion
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    ['arch-layer-1', 'arch-layer-2', 'arch-layer-3', 'arch-layer-4'].forEach(id => {
      const el = $(id);
      if (el) el.classList.add('revealed');
    });
    return;
  }

  // 1. Reveal Layer 1 (Simulation Runtime)
  const l1 = $('arch-layer-1');
  if (l1) l1.classList.add('revealed');

  // 2. Pulse conn-1, then reveal Layer 2 (Recovery Engine)
  archTimers.push(setTimeout(() => {
    const p1 = document.querySelector('#conn-1 .conn-pulse');
    if (p1) p1.classList.add('animating');
  }, 250));

  archTimers.push(setTimeout(() => {
    const l2 = $('arch-layer-2');
    if (l2) l2.classList.add('revealed');
  }, 550));

  // 3. Pulse conn-2 (branching to 3 parallel strategy arms), then reveal Layer 3
  archTimers.push(setTimeout(() => {
    document.querySelectorAll('#conn-2 .branch-pulse-dot').forEach(el => el.classList.add('animating'));
  }, 850));

  archTimers.push(setTimeout(() => {
    const l3 = $('arch-layer-3');
    if (l3) l3.classList.add('revealed');
  }, 1200));

  // 4. Pulse conn-3 (converging to atomic execution boundary), then reveal Layer 4
  archTimers.push(setTimeout(() => {
    document.querySelectorAll('#conn-3 .converge-pulse-dot').forEach(el => el.classList.add('animating'));
  }, 1650));

  archTimers.push(setTimeout(() => {
    const l4 = $('arch-layer-4');
    if (l4) l4.classList.add('revealed');
  }, 2050));
}

function initArchAnimation() {
  const archSection = $('architecture');
  if (!archSection) return;

  const replayBtn = $('btn-replay-arch');
  if (replayBtn) {
    replayBtn.addEventListener('click', () => {
      playArchAnimation();
    });
  }

  // Use IntersectionObserver to run ONCE when section enters viewport
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !archHasPlayed) {
          archHasPlayed = true;
          observer.unobserve(entry.target);
          playArchAnimation();
        }
      });
    }, {
      threshold: 0.15
    });

    observer.observe(archSection);
  } else {
    playArchAnimation();
  }
}

// ══════════════════════════════════════════════════════════
// HERO SCENARIO ANIMATION
// ══════════════════════════════════════════════════════════
let scenarioTimers = [];

function resetScenarioAnimation() {
  scenarioTimers.forEach(t => clearTimeout(t));
  scenarioTimers = [];

  const statusPulse = $('hero-status-pulse');
  const statusTitle = $('hero-status-title');
  const laptopPing = $('laptop-ping-anchor');
  const actionStatus = $('hero-action-status');
  const frictionStatus = $('hero-friction-status');

  const txChip = $('tx-chip');
  const txChipTag = $('tx-chip-tag');
  const txProgress = $('tx-track-progress');
  const txCheckpoint = $('tx-checkpoint');
  const nodeDest = $('tx-node-dest');
  const txStatusPill = $('tx-status-pill');
  const txStatusDetail = $('tx-status-detail');

  if (statusPulse) statusPulse.className = 'hero-status-pulse';
  if (statusTitle) statusTitle.textContent = 'PAYMENT ATTEMPT • REC-4921';
  if (laptopPing) laptopPing.className = 'laptop-ping-anchor';

  if (txChip) txChip.className = 'tx-chip state-init';
  if (txChipTag) txChipTag.textContent = 'PAYMENT';
  if (txProgress) txProgress.style.width = '10%';
  if (txCheckpoint) txCheckpoint.classList.remove('active');
  if (nodeDest) nodeDest.classList.remove('settled');

  if (txStatusPill) {
    txStatusPill.className = 'tx-status-pill pill-init';
    txStatusPill.textContent = 'ATTEMPT';
  }
  if (txStatusDetail) {
    txStatusDetail.textContent = 'Monthly recurring mandate ₹8,499 initiated';
  }

  if (actionStatus) actionStatus.textContent = 'Scheduled Mandate';
  if (frictionStatus) frictionStatus.textContent = '0 Retries Attempted';
}

function playScenarioAnimation() {
  resetScenarioAnimation();

  const frame = $('hero-visual-frame');
  if (frame) void frame.offsetWidth; // Force reflow

  const statusPulse = $('hero-status-pulse');
  const statusTitle = $('hero-status-title');
  const laptopPing = $('laptop-ping-anchor');
  const actionStatus = $('hero-action-status');
  const frictionStatus = $('hero-friction-status');

  const txChip = $('tx-chip');
  const txChipTag = $('tx-chip-tag');
  const txProgress = $('tx-track-progress');
  const txCheckpoint = $('tx-checkpoint');
  const nodeDest = $('tx-node-dest');
  const txStatusPill = $('tx-status-pill');
  const txStatusDetail = $('tx-status-detail');

  // Helper for static final recovered state
  const setFinalRecoveredState = () => {
    if (statusPulse) statusPulse.className = 'hero-status-pulse resolved';
    if (statusTitle) statusTitle.textContent = 'PAYMENT RECOVERED • SETTLEMENT COMPLETE';
    if (laptopPing) laptopPing.className = 'laptop-ping-anchor resolved';
    if (txChip) txChip.className = 'tx-chip state-recovered';
    if (txChipTag) txChipTag.textContent = 'RECOVERED';
    if (txProgress) txProgress.style.width = '100%';
    if (txCheckpoint) txCheckpoint.classList.add('active');
    if (nodeDest) nodeDest.classList.add('settled');
    if (txStatusPill) {
      txStatusPill.className = 'tx-status-pill pill-recovered';
      txStatusPill.textContent = 'RECOVERED';
    }
    if (txStatusDetail) {
      txStatusDetail.textContent = 'Mandate successfully recovered • ₹8,499 settled';
    }
    if (actionStatus) actionStatus.textContent = 'Recovered on D+1';
    if (frictionStatus) frictionStatus.textContent = '100% Friction-Free';
  };

  // Respect prefers-reduced-motion: immediate static resolved presentation
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setFinalRecoveredState();
    return;
  }

  // Step 1 (0.2s): Payment moves forward along track
  scenarioTimers.push(setTimeout(() => {
    if (txProgress) txProgress.style.width = '28%';
  }, 200));

  // Step 2 (1.2s): Payment fails (tasteful failure: insufficient balance, blind retry suppressed)
  scenarioTimers.push(setTimeout(() => {
    if (statusPulse) statusPulse.className = 'hero-status-pulse failed';
    if (statusTitle) statusTitle.textContent = 'PAYMENT FAILED • INSUFFICIENT BALANCE';
    if (laptopPing) laptopPing.className = 'laptop-ping-anchor failed';
    if (txChip) txChip.className = 'tx-chip state-failed';
    if (txChipTag) txChipTag.textContent = 'FAILED';
    if (txStatusPill) {
      txStatusPill.className = 'tx-status-pill pill-failed';
      txStatusPill.textContent = 'FAILED';
    }
    if (txStatusDetail) {
      txStatusDetail.textContent = 'Debit failed (insufficient balance) • Blind retry suppressed';
    }
    if (actionStatus) actionStatus.textContent = 'Analyzing Safe Window';
    if (frictionStatus) frictionStatus.textContent = '0 Blind Retries';
  }, 1200));

  // Step 3 (2.8s): SettleLoop intervenes — safe recovery action scheduled
  scenarioTimers.push(setTimeout(() => {
    if (statusPulse) statusPulse.className = 'hero-status-pulse recovering';
    if (statusTitle) statusTitle.textContent = 'SETTLELOOP INTELLIGENCE • OPTIMAL WINDOW FOUND';
    if (laptopPing) laptopPing.className = 'laptop-ping-anchor recovering';
    if (txChip) txChip.className = 'tx-chip state-recovery';
    if (txChipTag) txChipTag.textContent = 'RECOVERY';
    if (txProgress) txProgress.style.width = '52%';
    if (txCheckpoint) txCheckpoint.classList.add('active');
    if (txStatusPill) {
      txStatusPill.className = 'tx-status-pill pill-recovery';
      txStatusPill.textContent = 'RECOVERY';
    }
    if (txStatusDetail) {
      txStatusDetail.textContent = 'Deposit pattern detected • Auto-rescheduled for D+1';
    }
    if (actionStatus) actionStatus.textContent = 'Scheduled D+1 Window';
    if (frictionStatus) frictionStatus.textContent = '0 Harassment Triggers';
  }, 2800));

  // Step 4 (4.6s): Payment succeeds / Mandate recovered at Merchant
  scenarioTimers.push(setTimeout(() => {
    setFinalRecoveredState();
  }, 4600));
}

function initHeroScenarioAnimation() {
  const replayBtn = $('btn-replay-hero');
  if (replayBtn) {
    replayBtn.addEventListener('click', () => {
      playScenarioAnimation();
    });
  }

  // Play once on initial load
  playScenarioAnimation();
}

// ══════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════
function init() {
  initTheme();
  initNavLinks();
  initArchAnimation();
  initHeroScenarioAnimation();

  // Set initial IDs for lift abs animations
  const absControl = $('lift-vs-control')?.querySelector('.lift-stat-abs');
  if (absControl) absControl.id = 'lift-vs-control-abs-val';
  const absBaseline = $('lift-vs-baseline')?.querySelector('.lift-stat-abs');
  if (absBaseline) absBaseline.id = 'lift-vs-baseline-abs-val';

  // Initial UI state
  setLifecycleStep('configure');
  hide('run-info');
  show('run-empty');
  hide('results-content');
  show('results-empty');
  hideAlert('setup-alert');
  hideAlert('run-alert');
  resetStrategyMetricsToAwaiting();
  updateExperimentPreview();

  // Button handlers
  $('theme-toggle').addEventListener('click', toggleTheme);
  $('btn-create').addEventListener('click', createSimulation);
  $('btn-run').addEventListener('click', runSimulation);

  // Input changes for live preview
  $('input-mandates')?.addEventListener('input', updateExperimentPreview);
  $('input-maxdays')?.addEventListener('input', updateExperimentPreview);

  // Enter key in inputs creates simulation
  ['input-seed', 'input-mandates', 'input-maxdays'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') createSimulation(); });
  });

  updateCreateBtn();
  updateRunBtn();
}

document.addEventListener('DOMContentLoaded', init);

