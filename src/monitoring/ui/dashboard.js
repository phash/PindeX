/* MCP Codebase Indexer – Live Dashboard (Vanilla JS + WebSocket, ESM module) */

import { escHtml } from './esc.js';

// ─── State ────────────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 20;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const state = {
  calls: [],
  cumulativeActual: 0,
  cumulativeSavings: 0,
  chart: null,
  ws: null,
  sessionId: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
};

// ─── WebSocket Connection ─────────────────────────────────────────────────────

/** Reflects connection state in the status dot + accessible text label (UX-06). */
function setConnState(connected, message) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const label = message || (connected ? 'Verbunden' : 'Getrennt');
  dot.classList.toggle('connected', connected);
  dot.setAttribute('aria-label', label);
  if (text) text.textContent = label;
}

/** Capped exponential backoff with jitter, instead of a fixed 3s loop (UX-05). */
function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** state.reconnectAttempts);
  const jitter = delay * 0.2 * Math.random();
  state.reconnectAttempts++;
  setConnState(false, 'Verbindung verloren – erneuter Versuch …');
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delay + jitter);
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.reconnectAttempts = 0;
    setConnState(true, 'Verbunden');
  });

  ws.addEventListener('close', () => {
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // A 'close' normally follows, but reflect the drop immediately.
    setConnState(false, 'Verbindungsfehler');
  });

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      handleEvent(data);
    } catch (e) {
      console.error('Failed to parse event:', e);
    }
  });
}

// ─── Event Handling ───────────────────────────────────────────────────────────

function handleEvent(event) {
  if (event.type === 'tool_call') {
    // The broadcast carries per-call figures; accumulate running totals here so
    // the KPI cards show a session total, not the last call's value (UX-01).
    state.cumulativeActual += event.tokens_actual || 0;
    state.cumulativeSavings += event.savings || 0;
    state.sessionId = event.session_id;

    updateStatsCards();
    updateChart(event);
    appendCallFeedItem(event);
  } else if (event.type === 'session_start' || event.type === 'session_update') {
    if (event.session) {
      document.getElementById('sessionLabel').textContent = event.session.label || event.session.id;
    }
  }
}

// ─── Stats Cards ──────────────────────────────────────────────────────────────

function formatNumber(n) {
  return n.toLocaleString('de-DE');
}

function updateStatsCards() {
  const actual = state.cumulativeActual;
  const saved = state.cumulativeSavings;
  const base = actual + saved;
  const pct = base > 0 ? (saved / base) * 100 : 0;
  document.getElementById('tokensUsed').textContent = formatNumber(actual);
  document.getElementById('tokensSaved').textContent = formatNumber(saved);
  document.getElementById('savingsPercent').textContent = pct.toFixed(1) + '%';
  document.getElementById('savingsBar').style.width = Math.min(100, pct) + '%';
  document.getElementById('barTokenCount').textContent = formatNumber(actual) + ' Token';
}

// ─── Chart ────────────────────────────────────────────────────────────────────

function initChart() {
  const ctx = document.getElementById('tokenChart').getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Tatsächlich',
          data: [],
          backgroundColor: 'rgba(59, 130, 246, 0.8)',
          borderRadius: 3,
        },
        {
          label: 'Ohne Index (geschätzt)',
          data: [],
          backgroundColor: 'rgba(75, 85, 99, 0.5)',
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#9ca3af', font: { size: 11 } } } },
      scales: {
        // #9ca3af matches the legend and clears WCAG AA on the chart bg (UX-02).
        x: { ticks: { color: '#9ca3af', font: { size: 11 } }, grid: { color: '#1f2937' } },
        y: { ticks: { color: '#9ca3af', font: { size: 11 } }, grid: { color: '#1f2937' } },
      },
    },
  });
}

function updateChart(event) {
  const chart = state.chart;
  const label = event.tool;
  chart.data.labels.push(label);
  chart.data.datasets[0].data.push(event.tokens_actual);
  chart.data.datasets[1].data.push(event.tokens_estimated);

  // Keep only last N points
  if (chart.data.labels.length > MAX_CHART_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
    chart.data.datasets[1].data.shift();
  }

  chart.update('none');
}

// ─── Calls Feed ───────────────────────────────────────────────────────────────

function appendCallFeedItem(event) {
  const feed = document.getElementById('callsFeed');
  // Drop the "no calls yet" placeholder once real data arrives (UX-04).
  feed.querySelector('.memory-empty')?.remove();
  const time = dayjs(event.timestamp).format('HH:mm:ss');

  const item = document.createElement('div');
  item.className = 'call-item';
  // event.tool and event.query derive from MCP tool arguments — escape both
  // before they touch innerHTML (SEC-07).
  const toolLabel = escHtml(event.tool) + (event.query ? `("${escHtml(event.query)}")` : '');
  item.innerHTML = `
    <span class="call-time">${escHtml(time)}</span>
    <span class="call-tool">${toolLabel}</span>
    <span class="call-tokens"><span class="actual">${escHtml(event.tokens_actual)}</span> / ~${escHtml(event.tokens_estimated)}</span>
  `;

  // Prepend so newest is at top
  feed.insertBefore(item, feed.firstChild);

  // Keep only last 50 items in DOM
  while (feed.children.length > 50) {
    feed.removeChild(feed.lastChild);
  }
}

// ─── Session History ──────────────────────────────────────────────────────────

/** Renders a single full-width message row + dashes in the totals (UX-04). */
function setHistoryMessage(msg) {
  document.getElementById('historyBody').innerHTML =
    `<tr><td colspan="4" class="memory-empty">${escHtml(msg)}</td></tr>`;
  document.getElementById('histTotalTokens').textContent = '-';
  document.getElementById('histTotalSaved').textContent = '-';
  document.getElementById('histTotalPct').textContent = '-';
}

async function loadSessionHistory() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) { setHistoryMessage('Fehler beim Laden der Session History'); return; }
    const sessions = await res.json();

    if (!sessions.length) { setHistoryMessage('Noch keine Sessions'); return; }

    const tbody = document.getElementById('historyBody');
    tbody.innerHTML = '';

    let totalTokens = 0;
    let totalSaved = 0;

    for (const s of sessions) {
      const pct = s.total_tokens + s.total_savings > 0
        ? ((s.total_savings / (s.total_tokens + s.total_savings)) * 100).toFixed(1)
        : '0.0';

      totalTokens += s.total_tokens;
      totalSaved += s.total_savings;

      const row = document.createElement('tr');
      // s.label is attacker-influenceable (start_comparison tool arg) — escape it
      // and every other interpolated value before it touches innerHTML (SEC-02).
      row.innerHTML = `
        <td>${escHtml(s.label || s.id.substring(0, 8))}</td>
        <td>${escHtml(formatNumber(s.total_tokens))}</td>
        <td>${escHtml(formatNumber(s.total_savings))}</td>
        <td>${escHtml(pct)}%</td>
      `;
      tbody.appendChild(row);
    }

    const grandTotal = totalTokens + totalSaved;
    const grandPct = grandTotal > 0 ? ((totalSaved / grandTotal) * 100).toFixed(1) : '0.0';
    document.getElementById('histTotalTokens').textContent = formatNumber(totalTokens);
    document.getElementById('histTotalSaved').textContent = formatNumber(totalSaved);
    document.getElementById('histTotalPct').textContent = grandPct + '%';
  } catch (e) {
    console.error('Failed to load session history:', e);
    setHistoryMessage('Fehler beim Laden der Session History');
  }
}

// ─── Clock ────────────────────────────────────────────────────────────────────

function updateClock() {
  document.getElementById('sessionTime').textContent = dayjs().format('HH:mm:ss');
}

// ─── Refresh Rate Control ─────────────────────────────────────────────────────

let historyInterval = null;

function setRefreshInterval(seconds) {
  if (historyInterval) clearInterval(historyInterval);
  historyInterval = setInterval(() => {
    loadSessionHistory();
    loadSessionMemory();
  }, seconds * 1000);
}

// ─── Session Memory (Anti-Patterns & Observations) ───────────────────────────

const AP_LABELS = {
  thrash_detected:  'Thrashing',
  dead_end:         'Sackgasse',
  failed_search:    'Fehlsuche',
  tool_error:       'Tool-Fehler',
  index_blind_spot: 'Index-Blindspot',
  redundant_access: 'Redundanter Zugriff',
};

function renderAntiPatterns(items) {
  const feed = document.getElementById('antiPatternsFeed');
  const countEl = document.getElementById('apCount');
  countEl.textContent = items.length ? `(${items.length})` : '';

  if (!items.length) {
    feed.innerHTML = '<div class="memory-empty">Keine Anti-Patterns erkannt</div>';
    return;
  }

  feed.innerHTML = items.map((item) => {
    let description = item.event_type;
    try {
      const extra = JSON.parse(item.extra_json || '{}');
      if (extra.description) description = extra.description;
    } catch { /* ignore */ }

    const label   = AP_LABELS[item.event_type] || item.event_type;
    const cssType = item.event_type.replace(/_/g, '-');
    const time    = dayjs(item.timestamp).format('DD.MM HH:mm');
    const meta    = [item.file_path, item.symbol_name].filter(Boolean).join(' › ');

    return `
      <div class="memory-item ap-${escHtml(cssType)}">
        <div class="memory-item-header">
          <span class="memory-badge">${escHtml(label)}</span>
          <span class="memory-session">${escHtml((item.session_id || '').substring(0, 8))}</span>
          <span class="memory-time">${time}</span>
        </div>
        <div class="memory-text">${escHtml(description)}</div>
        ${meta ? `<div class="memory-meta">${escHtml(meta)}</div>` : ''}
      </div>`;
  }).join('');
}

function renderObservations(items) {
  const feed = document.getElementById('observationsFeed');
  const countEl = document.getElementById('obsCount');
  countEl.textContent = items.length ? `(${items.length})` : '';

  if (!items.length) {
    feed.innerHTML = '<div class="memory-empty">Keine Beobachtungen vorhanden</div>';
    return;
  }

  feed.innerHTML = items.map((item) => {
    const time  = dayjs(item.created_at).format('DD.MM HH:mm');
    const meta  = [item.file_path, item.symbol_name].filter(Boolean).join(' › ');
    const stale = item.stale === 1;

    return `
      <div class="memory-item obs-item${stale ? ' stale' : ''}">
        <div class="memory-item-header">
          <span class="memory-badge obs-badge">${escHtml(item.type)}</span>
          <span class="memory-session">${escHtml((item.session_id || '').substring(0, 8))}</span>
          <span class="memory-time">${time}</span>
          ${stale ? '<span class="stale-badge">veraltet</span>' : ''}
        </div>
        <div class="memory-text">${escHtml(item.observation)}</div>
        ${meta ? `<div class="memory-meta">${escHtml(meta)}</div>` : ''}
      </div>`;
  }).join('');
}

async function loadSessionMemory() {
  try {
    const res = await fetch('/api/session-memory');
    if (!res.ok) return;
    const { anti_patterns, observations } = await res.json();
    renderAntiPatterns(anti_patterns);
    renderObservations(observations);
  } catch (e) {
    console.error('Failed to load session memory:', e);
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  connect();
  loadSessionHistory();
  loadSessionMemory();
  setInterval(updateClock, 1000);
  setRefreshInterval(30);
  updateClock();

  const slider = document.getElementById('refreshSlider');
  const label = document.getElementById('refreshLabel');
  slider.addEventListener('input', () => {
    const s = Number(slider.value);
    label.textContent = s + 's';
    setRefreshInterval(s);
  });
});
