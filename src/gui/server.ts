/**
 * pindex-gui: Aggregated dashboard server.
 * Reads all registered projects from ~/.pindex/registry.json and their
 * SQLite databases directly (no running pindex-server required).
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import express from 'express';
import Database from 'better-sqlite3';
import {
  GlobalRegistry,
  getProjectIndexPath,
  type RegistryEntry,
} from '../cli/project-detector.js';

// ─── Per-project stats ─────────────────────────────────────────────────────

export interface ProjectStats {
  entry: RegistryEntry;
  fileCount: number;
  symbolCount: number;
  totalTokensSaved: number;
  totalTokensActual: number;
  savingsPercent: number;
  sessionCount: number;
  dbExists: boolean;
  lastIndexed: string | null;
}

export function loadProjectStats(entry: RegistryEntry): ProjectStats {
  const dbPath = getProjectIndexPath(entry.path);

  if (!existsSync(dbPath)) {
    return {
      entry, fileCount: 0, symbolCount: 0,
      totalTokensSaved: 0, totalTokensActual: 0,
      savingsPercent: 0, sessionCount: 0,
      dbExists: false, lastIndexed: null,
    };
  }

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    const fileCount = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n;
    const symbolCount = (db.prepare('SELECT COUNT(*) as n FROM symbols').get() as { n: number }).n;
    const sessionCount = (db.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number }).n;
    const lastIndexedRow = db
      .prepare('SELECT MAX(last_indexed) as ts FROM files')
      .get() as { ts: string | null };
    const tokenTotals = db
      .prepare(`SELECT
          COALESCE(SUM(tokens_used), 0)           AS actual,
          COALESCE(SUM(tokens_without_index), 0)  AS estimated
        FROM token_log`)
      .get() as { actual: number; estimated: number };

    const saved = tokenTotals.estimated - tokenTotals.actual;
    const pct = tokenTotals.estimated > 0
      ? Math.round((saved / tokenTotals.estimated) * 100) : 0;

    return {
      entry, fileCount, symbolCount,
      totalTokensSaved: Math.max(0, saved),
      totalTokensActual: tokenTotals.actual,
      savingsPercent: Math.max(0, pct),
      sessionCount, dbExists: true,
      lastIndexed: lastIndexedRow.ts ?? null,
    };
  } catch {
    return {
      entry, fileCount: 0, symbolCount: 0,
      totalTokensSaved: 0, totalTokensActual: 0,
      savingsPercent: 0, sessionCount: 0,
      dbExists: false, lastIndexed: null,
    };
  } finally {
    db?.close();
  }
}

// ─── Express App ───────────────────────────────────────────────────────────

export function createGuiApp(): express.Application {
  const app = express();
  app.use(express.json());

  app.get('/api/projects', (_req, res) => {
    const registry = new GlobalRegistry();
    const projects = registry.list().map(loadProjectStats);
    res.json(projects);
  });

  app.get('/api/projects/:hash/sessions', (req, res) => {
    const registry = new GlobalRegistry();
    const entry = registry.list().find((p) => p.hash === req.params.hash);
    if (!entry) return res.status(404).json({ error: 'project not found' });

    const dbPath = getProjectIndexPath(entry.path);
    if (!existsSync(dbPath)) return res.json([]);

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const sessions = db
        .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 50')
        .all();
      return res.json(sessions);
    } catch {
      return res.json([]);
    } finally {
      db?.close();
    }
  });

  app.get('/api/overview', (_req, res) => {
    const registry = new GlobalRegistry();
    const stats = registry.list().map(loadProjectStats);
    const overview = {
      totalProjects: stats.length,
      totalFiles: stats.reduce((s, p) => s + p.fileCount, 0),
      totalSymbols: stats.reduce((s, p) => s + p.symbolCount, 0),
      totalTokensSaved: stats.reduce((s, p) => s + p.totalTokensSaved, 0),
      totalTokensActual: stats.reduce((s, p) => s + p.totalTokensActual, 0),
      totalSessions: stats.reduce((s, p) => s + p.sessionCount, 0),
      avgSavingsPercent: stats.length > 0
        ? Math.round(stats.reduce((s, p) => s + p.savingsPercent, 0) / stats.length)
        : 0,
    };
    res.json({ overview, projects: stats });
  });

  app.get('/', (_req, res) => {
    res.send(buildDashboardHtml());
  });

  return app;
}

export interface GuiServer {
  httpServer: ReturnType<typeof createServer>;
  close(): Promise<void>;
}

export function startGuiServer(port: number): GuiServer {
  const app = createGuiApp();
  const httpServer = createServer(app);

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`  [pindex-gui] Port ${port} is already in use. Try: GUI_PORT=<other> pindex-gui`);
    } else {
      console.error(`  [pindex-gui] Server error: ${err.message}`);
    }
    // Don't crash — log and keep running (other connections still work)
  });

  httpServer.listen(port);
  return {
    httpServer,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

// ─── Inline Dashboard HTML ─────────────────────────────────────────────────

function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PindeX Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg:#0d1117;--surface:#161b22;--border:#30363d;
      --text:#c9d1d9;--muted:#8b949e;--accent:#58a6ff;
      --green:#3fb950;--yellow:#d29922;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',monospace}
    header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:12px}
    header h1{font-size:1.2rem;color:var(--accent)}
    header span{color:var(--muted);font-size:.85rem}
    .overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;padding:24px}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px}
    .card .value{font-size:2rem;font-weight:700;color:var(--accent)}
    .card .label{color:var(--muted);font-size:.8rem;margin-top:4px}
    .savings .value{color:var(--green)}
    .chart-wrap{max-width:600px;padding:0 24px 24px}
    .projects{padding:0 24px 24px}
    .projects h2{color:var(--muted);font-size:.85rem;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
    .project-row{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:10px;display:grid;grid-template-columns:1fr auto auto auto auto;gap:16px;align-items:center}
    .project-name{font-weight:600}
    .project-path{font-size:.75rem;color:var(--muted);margin-top:2px}
    .badge{background:var(--border);border-radius:4px;padding:2px 8px;font-size:.75rem;white-space:nowrap}
    .badge.green{background:#1c3829;color:var(--green)}
    .badge.blue{background:#1c2a3e;color:var(--accent)}
    .no-data{color:var(--muted);font-size:.85rem;padding:32px;text-align:center}
  </style>
</head>
<body>
<header>
  <h1>PindeX</h1>
  <span>MCP Codebase Indexer &mdash; Dashboard</span>
</header>

<div class="overview">
  <div class="card"><div class="value" id="ov-projects">—</div><div class="label">Projects</div></div>
  <div class="card"><div class="value" id="ov-files">—</div><div class="label">Indexed Files</div></div>
  <div class="card"><div class="value" id="ov-symbols">—</div><div class="label">Symbols</div></div>
  <div class="card savings"><div class="value" id="ov-savings">—</div><div class="label">Avg Token Savings</div></div>
  <div class="card"><div class="value" id="ov-sessions">—</div><div class="label">Total Sessions</div></div>
</div>

<div class="chart-wrap">
  <canvas id="chart" height="160"></canvas>
</div>

<div class="projects">
  <h2>Projects</h2>
  <div id="project-list"><div class="no-data">Loading&hellip;</div></div>
</div>

<script>
const fmt = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
let chart = null;

async function load() {
  const { overview, projects } = await fetch('/api/overview').then(r => r.json());
  document.getElementById('ov-projects').textContent = overview.totalProjects;
  document.getElementById('ov-files').textContent = fmt(overview.totalFiles);
  document.getElementById('ov-symbols').textContent = fmt(overview.totalSymbols);
  document.getElementById('ov-savings').textContent = overview.avgSavingsPercent + '%';
  document.getElementById('ov-sessions').textContent = overview.totalSessions;

  const ctx = document.getElementById('chart').getContext('2d');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: projects.map(p => p.entry.name),
      datasets: [
        { label: 'Tokens Saved', data: projects.map(p => p.totalTokensSaved), backgroundColor: '#3fb95099' },
        { label: 'Tokens Used',  data: projects.map(p => p.totalTokensActual), backgroundColor: '#58a6ff99' },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#c9d1d9' } } },
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }
      }
    }
  });

  const list = document.getElementById('project-list');
  if (!projects.length) {
    list.innerHTML = '<div class="no-data">No projects registered yet.<br>Run <code>pindex</code> in a project directory.</div>';
    return;
  }
  list.innerHTML = projects.map(p => \`
    <div class="project-row">
      <div>
        <div class="project-name">\${p.entry.name}</div>
        <div class="project-path">\${p.entry.path}</div>
      </div>
      <span class="badge blue">\${fmt(p.fileCount)} files</span>
      <span class="badge blue">\${fmt(p.symbolCount)} symbols</span>
      <span class="badge \${p.savingsPercent >= 50 ? 'green' : ''}">\${p.savingsPercent}% saved</span>
      <span class="badge">\${p.sessionCount} sessions</span>
    </div>
  \`).join('');
}

load().catch(console.error);
setInterval(load, 15000);
</script>
</body>
</html>`;
}
