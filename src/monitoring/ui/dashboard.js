/* MCP Codebase Indexer – Live Dashboard (Vanilla JS + WebSocket) */

// ─── State ────────────────────────────────────────────────────────────────────

const MAX_CHART_POINTS = 20;
const state = {
  calls: [],
  cumulativeActual: 0,
  cumulativeSavings: 0,
  chart: null,
  ws: null,
  sessionId: null,
};

// ─── WebSocket Connection ─────────────────────────────────────────────────────

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    document.getElementById('statusDot').classList.add('connected');
  });

  ws.addEventListener('close', () => {
    document.getElementById('statusDot').classList.remove('connected');
    setTimeout(connect, 3000); // Reconnect
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
    state.cumulativeActual = event.cumulative_actual;
    state.cumulativeSavings = event.cumulative_savings;
    state.sessionId = event.session_id;

    updateStatsCards(event);
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

function updateStatsCards(event) {
  document.getElementById('tokensUsed').textContent = formatNumber(event.cumulative_actual);
  document.getElementById('tokensSaved').textContent = formatNumber(event.cumulative_savings);
  document.getElementById('savingsPercent').textContent = event.savings_percent.toFixed(1) + '%';
  document.getElementById('savingsBar').style.width = Math.min(100, event.savings_percent) + '%';
  document.getElementById('barTokenCount').textContent = formatNumber(event.cumulative_actual) + ' Token';
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
        x: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: '#1f2937' } },
        y: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: '#1f2937' } },
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
  const time = dayjs(event.timestamp).format('HH:mm:ss');

  const item = document.createElement('div');
  item.className = 'call-item';
  item.innerHTML = `
    <span class="call-time">${time}</span>
    <span class="call-tool">${event.tool}${event.query ? `("${event.query}")` : ''}</span>
    <span class="call-tokens"><span class="actual">${event.tokens_actual}</span> / ~${event.tokens_estimated}</span>
  `;

  // Prepend so newest is at top
  feed.insertBefore(item, feed.firstChild);

  // Keep only last 50 items in DOM
  while (feed.children.length > 50) {
    feed.removeChild(feed.lastChild);
  }
}

// ─── Session History ──────────────────────────────────────────────────────────

async function loadSessionHistory() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) return;
    const sessions = await res.json();

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
      row.innerHTML = `
        <td>${s.label || s.id.substring(0, 8)}</td>
        <td>${formatNumber(s.total_tokens)}</td>
        <td>${formatNumber(s.total_savings)}</td>
        <td>${pct}%</td>
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
  }
}

// ─── Clock ────────────────────────────────────────────────────────────────────

function updateClock() {
  document.getElementById('sessionTime').textContent = dayjs().format('HH:mm:ss');
}

// ─── Initialization ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  connect();
  loadSessionHistory();
  setInterval(updateClock, 1000);
  setInterval(loadSessionHistory, 30000);
  updateClock();
});
