# Session Feature – Implementierungsplan

## Ziel
Das GUI-Dashboard soll Token-Savings **pro Session** anzeigen statt kumulativ:
1. **Recent Sessions Grid** (2×6 = 12 Kacheln) zwischen Overview-Cards und Chart
2. **Sessions-Tab** im Projekt-Modal mit Prev/Next-Navigation (6 Sessions/Seite)

---

## Datenstatus (verifiziert)

- `sessions.total_tokens` und `sessions.total_savings` werden in `insertTokenLog` aktuell gehalten
  (kein JOIN mit `token_log` nötig — direkte Quelle)
- Einzige zu ändernde Datei: **`src/gui/server.ts`**

---

## Benötigte Änderungen

### 1. Neuer API-Endpoint: `GET /api/sessions/recent`

In `createGuiApp()`, vor `app.get('/', ...)` einfügen:

```typescript
app.get('/api/sessions/recent', (_req, res) => {
  const registry = new GlobalRegistry();
  type SRow = { id: string; started_at: string; mode: string; label: string | null; total_tokens: number; total_savings: number };
  const all: Array<SRow & { projectName: string; projectHash: string }> = [];

  for (const entry of registry.list()) {
    const dbPath = getProjectIndexPath(entry.path);
    if (!existsSync(dbPath)) continue;
    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const rows = db
        .prepare('SELECT id, started_at, mode, label, total_tokens, total_savings FROM sessions ORDER BY started_at DESC LIMIT 12')
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
    };
  });
  return res.json(result);
});
```

---

### 2. CSS-Ergänzungen (in `buildDashboardHtml`)

```css
/* Sections (sessions + projects) */
.section{padding:0 24px 24px}
.section h2{color:var(--muted);font-size:.85rem;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}

/* Session grid */
.sessions-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.session-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;cursor:pointer;transition:border-color .15s}
.session-card:hover{border-color:var(--accent)}
.session-card .sc-proj{font-size:.68rem;color:var(--muted);margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-card .sc-saved{font-size:1.4rem;font-weight:700;color:var(--green)}
.session-card .sc-pct{font-size:.75rem;color:var(--muted);margin-top:2px}
.session-card .sc-date{font-size:.68rem;color:var(--muted);margin-top:6px;border-top:1px solid var(--border);padding-top:6px}
.session-card.empty{cursor:default;display:flex;align-items:center;justify-content:center;min-height:90px;border-style:dashed}
.session-card.empty span{color:var(--border);font-size:1.5rem}

/* Modal session pagination */
.sess-nav{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.sess-nav button{background:var(--border);border:none;color:var(--text);padding:4px 12px;border-radius:4px;cursor:pointer;font-size:.8rem}
.sess-nav button:disabled{opacity:.4;cursor:default}
.sess-nav button:not(:disabled):hover{background:var(--accent);color:#000}
.sess-nav .sess-label{color:var(--muted);font-size:.8rem;flex:1;text-align:center}
```

Außerdem `.projects` → `.section` umbenennen.

---

### 3. HTML-Änderungen

**Neuen Abschnitt** zwischen Overview-Cards und Chart einfügen:
```html
<div class="section">
  <h2>Recent Sessions</h2>
  <div class="sessions-grid" id="sessions-grid"></div>
</div>
```

**Projects-div** umstellen:
```html
<div class="section">  <!-- war: class="projects" -->
  <h2>Projects &#x2014; click for details</h2>
  ...
```

**Sessions-Tab im Modal** (nach Overview-Button einfügen):
```html
<button class="tab" onclick="switchTab('tab-sessions',this)">Sessions</button>
...
<div id="tab-sessions" class="tab-panel"></div>
```

---

### 4. JavaScript-Änderungen

**Globale Variablen ergänzen:**
```javascript
let _modalSessions = [], _sessPage = 0;
const SESS_PER_PAGE = 6;
```

**`load()` parallel fetchen:**
```javascript
async function load() {
  const [ovData, sessions] = await Promise.all([
    fetch('/api/overview').then(r => r.json()),
    fetch('/api/sessions/recent').then(r => r.json()).catch(() => []),
  ]);
  // ... (rest wie bisher, plus:)
  renderSessionGrid(sessions);
}
```

**Neue Funktion `renderSessionGrid(sessions)`:**
```javascript
function renderSessionGrid(sessions) {
  const grid = document.getElementById('sessions-grid');
  grid.textContent = '';
  for (let i = 0; i < 12; i++) {
    const card = document.createElement('div');
    if (i < sessions.length) {
      const s = sessions[i];
      card.className = 'session-card';
      card.onclick = () => openDetail(s.projectHash, s.projectName);
      card.appendChild(el('div', 'sc-proj', s.projectName));
      card.appendChild(el('div', 'sc-saved', fmt(s.tokensSaved)));
      card.appendChild(el('div', 'sc-pct', s.savingsPercent + '% saved \u2022 ' + fmt(s.tokensActual) + ' used'));
      card.appendChild(el('div', 'sc-date', fmtDate(s.startedAt)));
    } else {
      card.className = 'session-card empty';
      card.appendChild(el('span', '', '\u2014'));
    }
    grid.appendChild(card);
  }
}
```

**`openDetail()` Sessions parallel laden:**
```javascript
async function openDetail(hash, name) {
  // ... (bestehender Code bis srvEl ...)
  const [detail, sessions] = await Promise.all([
    fetch('/api/projects/' + hash + '/detail').then(r => r.json()),
    fetch('/api/projects/' + hash + '/sessions').then(r => r.json()).catch(() => []),
  ]);
  renderOv(proj, detail);
  renderModalSessions(sessions);   // NEU
  renderFiles(detail.files);
  renderSymbols(detail.symbols);
  renderTok(detail.tokenLog);
}
```

**Neue Funktionen `renderModalSessions` + `renderSessionPage`:**
```javascript
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
```

---

## Nach der Implementierung

```bash
npm run build
```

Dann Claude Code neu starten (damit der neue pindex-server mit dem path-fix aktiv wird).
