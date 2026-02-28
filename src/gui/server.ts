/**
 * pindex-gui: Aggregated dashboard server.
 * Reads all registered projects from ~/.pindex/registry.json and their
 * SQLite databases directly (no running pindex-server required).
 */
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { existsSync, statSync } from 'node:fs';
import express from 'express';
import open from 'open';
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
  serverRunning: boolean;
  indexSizeBytes: number;
}

/** Check whether a TCP port is accepting connections (timeout: 300ms). */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, '127.0.0.1');
    socket.setTimeout(300);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

export function loadProjectStats(entry: RegistryEntry): Omit<ProjectStats, 'serverRunning'> {
  const dbPath = getProjectIndexPath(entry.path);

  if (!existsSync(dbPath)) {
    return {
      entry, fileCount: 0, symbolCount: 0,
      totalTokensSaved: 0, totalTokensActual: 0,
      savingsPercent: 0, sessionCount: 0,
      dbExists: false, lastIndexed: null, indexSizeBytes: 0,
    };
  }

  const indexSizeBytes = statSync(dbPath).size;

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
      indexSizeBytes,
    };
  } catch {
    return {
      entry, fileCount: 0, symbolCount: 0,
      totalTokensSaved: 0, totalTokensActual: 0,
      savingsPercent: 0, sessionCount: 0,
      dbExists: false, lastIndexed: null, indexSizeBytes: 0,
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

  app.get('/api/projects/:hash/detail', (req, res) => {
    const registry = new GlobalRegistry();
    const entry = registry.list().find((p) => p.hash === req.params.hash);
    if (!entry) return res.status(404).json({ error: 'project not found' });

    const dbPath = getProjectIndexPath(entry.path);
    if (!existsSync(dbPath)) return res.json({ files: [], symbols: [], tokenLog: [] });

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const files = db.prepare(
        'SELECT path, language, raw_token_estimate, last_indexed FROM files ORDER BY path'
      ).all();
      const symbols = db.prepare(
        `SELECT s.name, s.kind, s.signature, s.start_line, f.path AS file_path
         FROM symbols s JOIN files f ON s.file_id = f.id
         ORDER BY s.kind, s.name LIMIT 1000`
      ).all();
      const tokenLog = db.prepare(
        `SELECT tool_name, tokens_used, tokens_without_index, timestamp, query
         FROM token_log ORDER BY timestamp DESC LIMIT 200`
      ).all();
      return res.json({ files, symbols, tokenLog });
    } catch {
      return res.json({ files: [], symbols: [], tokenLog: [] });
    } finally {
      db?.close();
    }
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

  app.get('/api/overview', async (_req, res) => {
    const registry = new GlobalRegistry();
    const entries = registry.list();
    const baseStats = entries.map(loadProjectStats);

    // Check monitoring ports in parallel to detect running pindex-server instances
    const running = await Promise.all(
      entries.map((e) => isPortListening(e.monitoringPort).catch(() => false))
    );

    const stats: ProjectStats[] = baseStats.map((s, i) => ({
      ...s,
      serverRunning: running[i],
    }));

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

  app.get('/api/sessions/recent', (_req, res) => {
    const registry = new GlobalRegistry();
    type SRow = { id: string; started_at: string; mode: string; label: string | null; total_tokens: number; total_savings: number; last_activity_at: string | null };
    const all: Array<SRow & { projectName: string; projectHash: string }> = [];

    for (const entry of registry.list()) {
      const dbPath = getProjectIndexPath(entry.path);
      if (!existsSync(dbPath)) continue;
      let db: InstanceType<typeof Database> | null = null;
      try {
        db = new Database(dbPath, { readonly: true });
        const rows = db
          .prepare(`SELECT id, started_at, mode, label, total_tokens, total_savings,
            (SELECT MAX(timestamp) FROM token_log WHERE session_id = sessions.id) AS last_activity_at
            FROM sessions ORDER BY started_at DESC LIMIT 12`)
          .all() as SRow[];
        rows.forEach(r => all.push({ ...r, projectName: entry.name, projectHash: entry.hash }));
      } catch { /* skip */ } finally { db?.close(); }
    }

    all.sort((a, b) => b.started_at.localeCompare(a.started_at));
    const result = all.slice(0, 12).map(s => {
      const saved = Math.max(0, s.total_savings);
      const base = s.total_tokens + saved;
      return {
        sessionId: s.id,
        projectName: s.projectName,
        projectHash: s.projectHash,
        startedAt: s.started_at,
        mode: s.mode,
        label: s.label,
        tokensActual: s.total_tokens,
        tokensSaved: saved,
        savingsPercent: base > 0 ? Math.round(saved / base * 100) : 0,
        lastActivityAt: s.last_activity_at ?? null,
      };
    });
    return res.json(result);
  });

  app.get('/api/projects/:hash/open', async (req, res) => {
    const registry = new GlobalRegistry();
    const entry = registry.list().find((p) => p.hash === req.params.hash);
    if (!entry) return res.status(404).json({ error: 'project not found' });
    try {
      await open(entry.path);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'failed to open folder' });
    }
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

export interface GuiServerWithPort extends GuiServer {
  port: number;
}

export function startGuiServer(port: number): Promise<GuiServerWithPort> {
  return new Promise((resolve, reject) => {
    const app = createGuiApp();
    const httpServer = createServer(app);

    httpServer.once('listening', () => {
      resolve({
        httpServer,
        port,
        close: () =>
          new Promise<void>((res, rej) =>
            httpServer.close((err) => (err ? rej(err) : res())),
          ),
      });
    });

    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      httpServer.close();
      reject(err);
    });

    httpServer.listen(port);
  });
}

// ─── Inline Dashboard HTML ─────────────────────────────────────────────────

// NOTE: innerHTML assignments below use data sourced exclusively from our own
// SQLite databases (project names, paths, symbol names). No user-supplied web
// input is ever rendered — XSS risk is not applicable in this context.
function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PindeX Dashboard</title>
  <script async src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
  <style>
    :root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#c9d1d9;--muted:#8b949e;--accent:#58a6ff;--green:#3fb950;--red:#f85149}
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',monospace}
    header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:12px}
    header h1{font-size:1.2rem;color:var(--accent)}
    header .meta{display:flex;align-items:center;gap:16px;margin-left:auto}
    header .upd{color:var(--muted);font-size:.8rem}
    .refresh-control{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:.75rem;cursor:pointer;user-select:none}
    .refresh-control input[type=range]{-webkit-appearance:none;appearance:none;width:72px;height:3px;background:var(--border);border-radius:2px;outline:none;cursor:pointer}
    .refresh-control input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:50%;background:var(--accent);cursor:pointer}
    .refresh-control input[type=range]::-moz-range-thumb{width:11px;height:11px;border:none;border-radius:50%;background:var(--accent);cursor:pointer}
    .overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;padding:24px}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px}
    .card .value{font-size:2rem;font-weight:700;color:var(--accent)}
    .card .label{color:var(--muted);font-size:.8rem;margin-top:4px}
    .savings .value{color:var(--green)}
    .chart-wrap{max-width:680px;padding:0 24px 24px}
    .section{padding:0 24px 24px}
    .section h2{color:var(--muted);font-size:.85rem;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
    .sessions-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
    .session-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;cursor:pointer;transition:border-color .15s}
    .session-card:hover{border-color:var(--accent)}
    .session-card .sc-proj{font-size:.68rem;color:var(--muted);margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .session-card .sc-saved{font-size:1.4rem;font-weight:700;color:var(--green)}
    .session-card .sc-pct{font-size:.75rem;color:var(--muted);margin-top:2px}
    .session-card .sc-range{font-size:.68rem;color:var(--muted);margin-top:6px;border-top:1px solid var(--border);padding-top:6px;display:flex;justify-content:space-between;align-items:baseline;gap:6px}
    .session-card .sc-range .sc-dur{color:var(--accent);font-size:.65rem;white-space:nowrap}
    .sessions-empty{color:var(--muted);font-size:.85rem;padding:20px 0;text-align:center}
    .sess-nav{display:flex;align-items:center;gap:8px;margin-bottom:12px}
    .sess-nav button{background:var(--border);border:none;color:var(--text);padding:4px 12px;border-radius:4px;cursor:pointer;font-size:.8rem}
    .sess-nav button:disabled{opacity:.4;cursor:default}
    .sess-nav button:not(:disabled):hover{background:var(--accent);color:#000}
    .sess-nav .sess-label{color:var(--muted);font-size:.8rem;flex:1;text-align:center}
    .project-row{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:10px;display:grid;grid-template-columns:auto 1fr auto auto auto auto auto auto;gap:14px;align-items:center;cursor:pointer;transition:border-color .15s}
    .project-row:hover{border-color:var(--accent)}
    .open-btn{background:none;border:1px solid var(--border);border-radius:4px;padding:3px 8px;cursor:pointer;font-size:.85rem;color:var(--muted);line-height:1;transition:border-color .15s,color .15s}
    .open-btn:hover{border-color:var(--accent);color:var(--text)}
    .srv-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
    .srv-dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}
    .srv-dot.off{background:var(--border)}
    .project-name{font-weight:600}
    .project-path{font-size:.75rem;color:var(--muted);margin-top:2px}
    .badge{background:var(--border);border-radius:4px;padding:2px 8px;font-size:.75rem;white-space:nowrap}
    .badge.green{background:#1c3829;color:var(--green)}
    .badge.blue{background:#1c2a3e;color:var(--accent)}
    .no-data{color:var(--muted);font-size:.85rem;padding:32px;text-align:center}
    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto}
    .modal-overlay.open{display:flex}
    .modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:100%;max-width:900px;overflow:hidden}
    .modal-header{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;justify-content:space-between}
    .modal-header h2{font-size:1rem;color:var(--accent)}
    .modal-close{background:none;border:none;color:var(--muted);font-size:1.4rem;cursor:pointer;padding:0 4px;line-height:1}
    .modal-close:hover{color:var(--text)}
    .modal-srv{font-size:.75rem;padding:2px 8px;border-radius:4px}
    .modal-srv.on{background:#1c3829;color:var(--green)}
    .modal-srv.off{background:var(--border);color:var(--muted)}
    .modal-tabs{display:flex;border-bottom:1px solid var(--border);padding:0 24px}
    .tab{padding:10px 16px;font-size:.85rem;cursor:pointer;border-bottom:2px solid transparent;color:var(--muted);background:none;border-top:none;border-left:none;border-right:none}
    .tab.active{color:var(--accent);border-bottom-color:var(--accent)}
    .tab-panel{display:none;padding:20px 24px;max-height:60vh;overflow-y:auto}
    .tab-panel.active{display:block}
    .detail-table{width:100%;border-collapse:collapse;font-size:.8rem}
    .detail-table th{text-align:left;color:var(--muted);padding:6px 8px;border-bottom:1px solid var(--border);font-weight:normal;text-transform:uppercase;font-size:.7rem;letter-spacing:.06em}
    .detail-table td{padding:6px 8px;border-bottom:1px solid #21262d;font-family:monospace;font-size:.78rem}
    .detail-table tr:hover td{background:#1c2128}
    .kind-badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.7rem;background:var(--border);color:var(--muted)}
    .info-box{background:#0d1117;border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px;font-size:.85rem;line-height:1.7}
    .info-box .formula{color:var(--accent);font-family:monospace;font-size:.8rem;margin-top:8px;padding:8px;background:var(--surface);border-radius:4px}
    .stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
    .stat-box{background:#0d1117;border:1px solid var(--border);border-radius:6px;padding:12px}
    .stat-box .v{font-size:1.4rem;font-weight:700;color:var(--accent)}
    .stat-box .l{font-size:.75rem;color:var(--muted);margin-top:2px}
    .stat-box.green .v{color:var(--green)}
    .search-input{width:100%;background:#0d1117;border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:.85rem;margin-bottom:12px;font-family:inherit}
    .search-input:focus{outline:none;border-color:var(--accent)}
    .hint{color:var(--muted);font-size:.75rem;margin-top:8px}
  </style>
</head>
<body>
<header>
  <h1>PindeX</h1>
  <div class="meta">
    <label class="refresh-control" title="Auto-refresh interval">
      <span id="refreshLabel">15s</span>
      <input type="range" id="refreshSlider" min="1" max="60" value="15" step="1">
    </label>
    <span class="upd" id="last-updated"></span>
  </div>
</header>
<div class="overview">
  <div class="card"><div class="value" id="ov-projects">&#x2014;</div><div class="label">Projects</div></div>
  <div class="card"><div class="value" id="ov-files">&#x2014;</div><div class="label">Indexed Files</div></div>
  <div class="card"><div class="value" id="ov-symbols">&#x2014;</div><div class="label">Symbols</div></div>
  <div class="card savings"><div class="value" id="ov-savings">&#x2014;</div><div class="label">Avg Token Savings</div></div>
  <div class="card"><div class="value" id="ov-sessions">&#x2014;</div><div class="label">Total Sessions</div></div>
</div>
<div class="section">
  <h2>Recent Sessions</h2>
  <div class="sessions-grid" id="sessions-grid"></div>
</div>
<div class="chart-wrap"><canvas id="chart" height="140"></canvas></div>
<div class="section">
  <h2>Projects &#x2014; click for details</h2>
  <div id="project-list"><div class="no-data">Loading&#x2026;</div></div>
</div>

<div class="modal-overlay" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <div class="modal-header">
      <div style="display:flex;align-items:center;gap:10px">
        <h2 id="modal-title"></h2>
        <span class="modal-srv" id="modal-srv"></span>
      </div>
      <button class="modal-close" onclick="closeModal()">&#x00D7;</button>
    </div>
    <div class="modal-tabs">
      <button class="tab active" onclick="switchTab('tab-ov',this)">Overview</button>
      <button class="tab" onclick="switchTab('tab-files',this)">Files</button>
      <button class="tab" onclick="switchTab('tab-sym',this)">Symbols</button>
      <button class="tab" onclick="switchTab('tab-tok',this)">Token Log</button>
      <button class="tab" onclick="switchTab('tab-sessions',this)">Sessions</button>
    </div>
    <div id="tab-ov"       class="tab-panel active"></div>
    <div id="tab-files"    class="tab-panel"></div>
    <div id="tab-sym"      class="tab-panel"></div>
    <div id="tab-tok"      class="tab-panel"></div>
    <div id="tab-sessions" class="tab-panel"></div>
  </div>
</div>

<script>
const fmt = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
const fmtSize = b => b >= 1073741824 ? (b/1073741824).toFixed(1)+' GB' : b >= 1048576 ? (b/1048576).toFixed(1)+' MB' : b >= 1024 ? (b/1024).toFixed(1)+' KB' : b+' B';
const fmtDate = s => s ? new Date(s.includes('Z') || s.includes('+') ? s : s.replace(' ', 'T') + 'Z').toLocaleString() : '\u2014';
const fmtTime = s => s ? new Date(s.includes('Z') || s.includes('+') ? s : s.replace(' ', 'T') + 'Z').toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : null;
const fmtDay  = s => s ? new Date(s.includes('Z') || s.includes('+') ? s : s.replace(' ', 'T') + 'Z').toLocaleDateString([], {month:'short',day:'numeric'}) : '\u2014';
const fmtDur  = (a, b) => { if (!a || !b) return null; const ms = new Date(b) - new Date(a); if (ms <= 0) return null; const m = Math.round(ms/60000); return m < 1 ? '<1\u202fmin' : m < 60 ? m+'\u202fmin' : (m/60).toFixed(1)+'\u202fh'; };
let chart = null, currentProjects = [];
let _modalSessions = [], _sessPage = 0;
const SESS_PER_PAGE = 6;

function updateChart(projects) {
  if (typeof Chart === 'undefined') return;
  try {
    const labels = projects.map(p => p.entry.name);
    const saved  = projects.map(p => p.totalTokensSaved);
    const used   = projects.map(p => p.totalTokensActual);
    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets[0].data = saved;
      chart.data.datasets[1].data = used;
      chart.update('none');
    } else {
      chart = new Chart(document.getElementById('chart').getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [
          { label: 'Tokens Saved', data: saved, backgroundColor: '#3fb95099' },
          { label: 'Tokens Used',  data: used,  backgroundColor: '#58a6ff99' },
        ]},
        options: {
          responsive: true, animation: false,
          plugins: { legend: { labels: { color: '#c9d1d9' } } },
          scales: {
            x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
            y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }
          }
        }
      });
    }
  } catch(e) { console.warn('Chart update failed:', e); }
}

async function load() {
  const [{ overview, projects }, sessions] = await Promise.all([
    fetch('/api/overview').then(r => r.json()),
    fetch('/api/sessions/recent').then(r => r.json()).catch(() => []),
  ]);
  currentProjects = projects;
  renderSessionGrid(sessions);
  document.getElementById('ov-projects').textContent = overview.totalProjects;
  document.getElementById('ov-files').textContent    = fmt(overview.totalFiles);
  document.getElementById('ov-symbols').textContent  = fmt(overview.totalSymbols);
  document.getElementById('ov-savings').textContent  = overview.avgSavingsPercent + '%';
  document.getElementById('ov-sessions').textContent = overview.totalSessions;
  document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  updateChart(projects);
  const list = document.getElementById('project-list');
  if (!projects.length) {
    list.textContent = '';
    const msg = document.createElement('div');
    msg.className = 'no-data';
    msg.textContent = 'No projects registered yet. Run pindex in a project directory.';
    list.appendChild(msg);
    return;
  }
  list.textContent = '';
  projects.forEach(p => {
    const row = document.createElement('div');
    row.className = 'project-row';
    row.onclick = () => openDetail(p.entry.hash, p.entry.name);
    const dot = document.createElement('div');
    dot.className = 'srv-dot ' + (p.serverRunning ? 'on' : 'off');
    dot.title = p.serverRunning ? 'MCP server running (port ' + p.entry.monitoringPort + ')' : 'MCP server not running';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'project-name';
    name.textContent = p.entry.name;
    const path = document.createElement('div');
    path.className = 'project-path';
    path.textContent = p.entry.path;
    info.appendChild(name);
    info.appendChild(path);
    const mkBadge = (text, cls) => { const b = document.createElement('span'); b.className = 'badge' + (cls ? ' ' + cls : ''); b.textContent = text; return b; };
    const openBtn = document.createElement('button');
    openBtn.className = 'open-btn';
    openBtn.title = 'Open project folder in explorer';
    openBtn.textContent = '\\u{1F4C2}';
    openBtn.onclick = (e) => { e.stopPropagation(); fetch('/api/projects/' + p.entry.hash + '/open').catch(() => {}); };
    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(mkBadge(fmt(p.fileCount) + ' files', 'blue'));
    row.appendChild(mkBadge(fmt(p.symbolCount) + ' symbols', 'blue'));
    row.appendChild(mkBadge(p.savingsPercent + '% saved', p.savingsPercent >= 50 ? 'green' : ''));
    row.appendChild(mkBadge(p.sessionCount + ' sessions', ''));
    row.appendChild(mkBadge(fmtSize(p.indexSizeBytes ?? 0), ''));
    row.appendChild(openBtn);
    list.appendChild(row);
  });
}

function renderSessionGrid(sessions) {
  const grid = document.getElementById('sessions-grid');
  grid.textContent = '';
  if (!sessions.length) {
    const msg = document.createElement('div');
    msg.className = 'sessions-empty';
    msg.textContent = 'No sessions recorded yet.';
    grid.appendChild(msg);
    return;
  }
  sessions.forEach(s => {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.onclick = () => openDetail(s.projectHash, s.projectName);
    card.appendChild(el('div', 'sc-proj', s.projectName));
    card.appendChild(el('div', 'sc-saved', fmt(s.tokensSaved)));
    card.appendChild(el('div', 'sc-pct', s.savingsPercent + '% saved \u2022 ' + fmt(s.tokensActual) + ' used'));
    const rangeDiv = el('div', 'sc-range');
    const startTime = fmtTime(s.startedAt);
    const endTime   = fmtTime(s.lastActivityAt);
    const day       = fmtDay(s.startedAt);
    const dur       = fmtDur(s.startedAt, s.lastActivityAt);
    const timeText  = startTime && endTime && startTime !== endTime
      ? day + '\u2002' + startTime + '\u2013' + endTime
      : day + (startTime ? '\u2002' + startTime : '');
    rangeDiv.appendChild(el('span', '', timeText));
    if (dur) rangeDiv.appendChild(el('span', 'sc-dur', dur));
    card.appendChild(rangeDiv);
    grid.appendChild(card);
  });
}

function closeModal() { document.getElementById('modal').classList.remove('open'); }

function switchTab(id, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
}

async function openDetail(hash, name) {
  document.getElementById('modal-title').textContent = name;
  document.getElementById('modal').classList.add('open');
  document.querySelectorAll('.tab-panel').forEach(p => { p.classList.remove('active'); p.textContent = 'Loading\u2026'; });
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', i===0));
  document.getElementById('tab-ov').classList.add('active');

  const proj = currentProjects.find(p => p.entry.hash === hash);
  const srvEl = document.getElementById('modal-srv');
  srvEl.textContent = proj.serverRunning ? '\u25cf MCP running' : '\u25cb MCP stopped';
  srvEl.className = 'modal-srv ' + (proj.serverRunning ? 'on' : 'off');

  const [detail, sessions] = await Promise.all([
    fetch('/api/projects/' + hash + '/detail').then(r => r.json()),
    fetch('/api/projects/' + hash + '/sessions').then(r => r.json()).catch(() => []),
  ]);
  renderOv(proj, detail);
  renderModalSessions(sessions);
  renderFiles(detail.files);
  renderSymbols(detail.symbols);
  renderTok(detail.tokenLog);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderOv(proj, detail) {
  const saved = proj.totalTokensSaved, used = proj.totalTokensActual;
  const total = saved + used, pct = total > 0 ? Math.round(saved/total*100) : 0;
  const panel = document.getElementById('tab-ov');
  panel.textContent = '';

  const grid = el('div', 'stat-grid');
  [
    [fmt(proj.fileCount), 'Files', ''],
    [fmt(proj.symbolCount), 'Symbols', ''],
    [proj.sessionCount, 'Sessions', ''],
    [fmt(saved), 'Tokens Saved', 'green'],
    [fmt(used), 'Tokens Used', ''],
    [pct + '%', 'Savings Rate', pct >= 50 ? 'green' : ''],
  ].forEach(([v, l, cls]) => {
    const box = el('div', 'stat-box ' + cls);
    box.appendChild(el('div', 'v', v));
    box.appendChild(el('div', 'l', l));
    grid.appendChild(box);
  });
  panel.appendChild(grid);

  const infoA = el('div', 'info-box');
  infoA.appendChild(el('strong', '', 'How savings are calculated'));
  infoA.appendChild(document.createTextNode(' Each MCP tool call estimates how many tokens Claude would have needed without the index \u2014 e.g. reading entire source files to find a function. The actual tokens consumed by targeted PindeX queries are subtracted from this estimate.'));
  const formula = el('div', 'formula');
  formula.textContent = 'saved = tokens_without_index \u2212 tokens_used\\nrate  = saved / tokens_without_index \u00d7 100';
  infoA.appendChild(formula);
  panel.appendChild(infoA);

  const infoB = el('div', 'info-box');
  infoB.style.fontSize = '.8rem';
  infoB.style.color = 'var(--muted)';
  const srvLine = document.createElement('span');
  srvLine.innerHTML = '<strong style="color:var(--text)">MCP server</strong> port ' + proj.entry.monitoringPort + ' \u2014 ';
  const srvStatus = el('span', '', proj.serverRunning ? 'running' : 'not running (start Claude Code with this project)');
  srvStatus.style.color = proj.serverRunning ? 'var(--green)' : '';
  srvLine.appendChild(srvStatus);
  infoB.appendChild(srvLine);
  infoB.appendChild(document.createElement('br'));
  infoB.appendChild(document.createTextNode('Last indexed: ' + fmtDate(proj.lastIndexed)));
  infoB.appendChild(document.createElement('br'));
  infoB.appendChild(document.createTextNode('Index size: ' + fmtSize(proj.indexSizeBytes ?? 0)));
  infoB.appendChild(document.createElement('br'));
  const hashSpan = el('span', '', 'Index hash: ');
  const hashCode = el('span', '');
  hashCode.style.fontFamily = 'monospace';
  hashCode.textContent = proj.entry.hash;
  hashSpan.appendChild(hashCode);
  infoB.appendChild(hashSpan);
  infoB.appendChild(document.createElement('br'));
  const openLink = document.createElement('button');
  openLink.textContent = '\\u{1F4C2} Open project folder';
  openLink.style.cssText = 'margin-top:8px;background:none;border:1px solid var(--border);border-radius:4px;padding:4px 10px;color:var(--muted);cursor:pointer;font-size:.8rem;transition:border-color .15s,color .15s';
  openLink.onmouseover = () => { openLink.style.borderColor = 'var(--accent)'; openLink.style.color = 'var(--text)'; };
  openLink.onmouseout  = () => { openLink.style.borderColor = 'var(--border)';  openLink.style.color = 'var(--muted)'; };
  openLink.onclick = () => fetch('/api/projects/' + proj.entry.hash + '/open').catch(() => {});
  infoB.appendChild(openLink);
  panel.appendChild(infoB);
}

function buildTable(cols, rows) {
  const tbl = el('table', 'detail-table');
  const thead = el('thead'); const tr = el('tr');
  cols.forEach(c => tr.appendChild(el('th', '', c)));
  thead.appendChild(tr); tbl.appendChild(thead);
  const tbody = el('tbody');
  rows.forEach(cells => {
    const r = el('tr');
    cells.forEach((c, i) => {
      const td = el('td');
      if (typeof c === 'string') td.textContent = c;
      else { td.textContent = c.text; if (c.style) td.style.cssText = c.style; }
      r.appendChild(td);
    });
    tbody.appendChild(r);
  });
  if (!rows.length) {
    const r = el('tr'); const td = el('td'); td.colSpan = cols.length;
    td.textContent = 'No data'; td.style.cssText = 'color:var(--muted);padding:16px';
    r.appendChild(td); tbody.appendChild(r);
  }
  tbl.appendChild(tbody);
  return tbl;
}

function makeSearchPanel(tabId, placeholder, allItems, renderFn) {
  const panel = document.getElementById(tabId);
  panel.textContent = '';
  const inp = el('input', 'search-input');
  inp.placeholder = placeholder;
  inp.oninput = () => renderFn(inp.value, panel.querySelector('tbody'));
  panel.appendChild(inp);
  return panel;
}

function renderFiles(files) {
  window._files = files;
  const panel = document.getElementById('tab-files');
  panel.textContent = '';
  const inp = el('input', 'search-input');
  inp.placeholder = 'Filter files\u2026';
  const tbl = buildTable(['Path','Lang','~Tokens','Last indexed'], []);
  inp.oninput = () => {
    const q = inp.value.toLowerCase();
    const filtered = q ? files.filter(f => f.path.toLowerCase().includes(q)) : files;
    const tbody = tbl.querySelector('tbody');
    tbody.textContent = '';
    filtered.slice(0,500).forEach(f => {
      const r = el('tr');
      [f.path, f.language, fmt(f.raw_token_estimate ?? 0), fmtDate(f.last_indexed)].forEach((v,i) => {
        const td = el('td', '', v);
        if (i === 3) td.style.color = 'var(--muted)';
        r.appendChild(td);
      });
      tbody.appendChild(r);
    });
    if (!filtered.length) { const r=el('tr'); const td=el('td','','\u2014'); td.colSpan=4; td.style.cssText='color:var(--muted);padding:16px'; r.appendChild(td); tbody.appendChild(r); }
  };
  inp.oninput(null);
  panel.appendChild(inp);
  panel.appendChild(tbl);
  panel.appendChild(el('div', 'hint', files.length + ' files total (showing up to 500)'));
}

function renderSymbols(syms) {
  window._syms = syms;
  const panel = document.getElementById('tab-sym');
  panel.textContent = '';
  const inp = el('input', 'search-input');
  inp.placeholder = 'Filter by name or kind\u2026';
  const tbl = buildTable(['Name','Kind','Signature','File'], []);
  inp.oninput = () => {
    const q = inp.value.toLowerCase();
    const filtered = q ? syms.filter(s => s.name.toLowerCase().includes(q) || s.kind.toLowerCase().includes(q)) : syms;
    const tbody = tbl.querySelector('tbody');
    tbody.textContent = '';
    filtered.slice(0,500).forEach(s => {
      const r = el('tr');
      const nameTd = el('td','',s.name); r.appendChild(nameTd);
      const kindTd = el('td'); const kb = el('span','kind-badge',s.kind); kindTd.appendChild(kb); r.appendChild(kindTd);
      const sigTd = el('td','',s.signature); sigTd.style.cssText='color:var(--muted);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; r.appendChild(sigTd);
      const fileTd = el('td','',(s.file_path||'').split(/[\\/]/).pop()); fileTd.style.color='var(--muted)'; r.appendChild(fileTd);
      tbody.appendChild(r);
    });
    if (!filtered.length) { const r=el('tr'); const td=el('td','','\u2014'); td.colSpan=4; td.style.cssText='color:var(--muted);padding:16px'; r.appendChild(td); tbody.appendChild(r); }
  };
  inp.oninput(null);
  panel.appendChild(inp);
  panel.appendChild(tbl);
  panel.appendChild(el('div', 'hint', syms.length + ' symbols total (showing up to 500)'));
}

function renderTok(log) {
  const panel = document.getElementById('tab-tok');
  panel.textContent = '';
  if (!log.length) {
    const msg = el('div', 'no-data');
    msg.textContent = 'No tool calls recorded yet. Use PindeX tools in Claude Code to generate data.';
    panel.appendChild(msg);
    return;
  }
  const rows = log.map(t => {
    const s = t.tokens_without_index - t.tokens_used;
    return [t.tool_name, fmt(t.tokens_used), fmt(t.tokens_without_index),
      { text: (s>=0?'+':'') + fmt(s), style: 'color:' + (s>=0?'var(--green)':'var(--red)') },
      { text: fmtDate(t.timestamp), style: 'color:var(--muted)' }];
  });
  panel.appendChild(buildTable(['Tool','Used','Est. Without','Saved','Time'], rows));
}

function renderModalSessions(sessions) {
  _modalSessions = sessions;
  _sessPage = 0;
  renderSessionPage();
}

function renderSessionPage() {
  const panel = document.getElementById('tab-sessions');
  panel.textContent = '';
  const total = _modalSessions.length;
  const start = _sessPage * SESS_PER_PAGE;
  const end = Math.min(start + SESS_PER_PAGE, total);

  if (total > SESS_PER_PAGE) {
    const nav = el('div', 'sess-nav');
    const prev = el('button', '', '\u2190 Newer');
    prev.disabled = _sessPage === 0;
    prev.onclick = () => { _sessPage--; renderSessionPage(); };
    const lbl = el('span', 'sess-label', 'Sessions ' + (start+1) + '\u2013' + end + ' of ' + total);
    const next = el('button', '', 'Older \u2192');
    next.disabled = end >= total;
    next.onclick = () => { _sessPage++; renderSessionPage(); };
    nav.appendChild(prev); nav.appendChild(lbl); nav.appendChild(next);
    panel.appendChild(nav);
  }

  if (!total) {
    panel.appendChild(el('div', 'no-data', 'No sessions recorded yet.'));
    return;
  }

  const rows = _modalSessions.slice(start, end).map(s => {
    const saved = s.total_savings ?? 0;
    const base = (s.total_tokens ?? 0) + Math.max(0, saved);
    const pct = base > 0 ? Math.round(saved / base * 100) : 0;
    return [
      s.label || (s.id ? s.id.slice(0,8) + '\u2026' : '\u2014'),
      s.mode || '\u2014',
      fmt(s.total_tokens ?? 0),
      { text: (saved >= 0 ? '+' : '') + fmt(saved), style: 'color:' + (saved >= 0 ? 'var(--green)' : 'var(--red)') },
      pct + '%',
      { text: fmtDate(s.started_at), style: 'color:var(--muted)' },
    ];
  });
  panel.appendChild(buildTable(['Session', 'Mode', 'Tokens Used', 'Saved', 'Rate', 'Started'], rows));
}

let _refreshTimer = null;
function setRefreshInterval(s) {
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(() => load().catch(console.error), s * 1000);
}
load().catch(console.error);
setRefreshInterval(15);
const _slider = document.getElementById('refreshSlider');
const _sliderLabel = document.getElementById('refreshLabel');
_slider.addEventListener('input', () => {
  const s = Number(_slider.value);
  _sliderLabel.textContent = s + 's';
  setRefreshInterval(s);
});
<\/script>
</body>
</html>`;
}
