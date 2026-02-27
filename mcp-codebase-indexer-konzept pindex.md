# MCP Codebase Indexer – Konzept & Implementierungsplan

## Ziel

Einen MCP-Server bauen, der eine Codebase strukturiert indexiert und über gezielte Tools nur die minimal nötigen Informationen liefert – anstatt ganze Dateien in den Kontext zu laden. Ziel: **80–90% Token-Reduktion** bei typischen Coding-Aufgaben.

---

## Architektur-Überblick

```
┌─────────────────────────────────────────────────────┐
│                    Claude / LLM                     │
└────────────────────┬────────────────────────────────┘
                     │ MCP Protocol
┌────────────────────▼────────────────────────────────┐
│              MCP Codebase Indexer Server            │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  │
│  │  Index Layer │  │ Query Layer  │  │ FS Watch │  │
│  │  (SQLite)    │  │  (Tools)     │  │ (Update) │  │
│  └──────────────┘  └──────────────┘  └──────────┘  │
│                                                     │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ Token Logger │  │   WebSocket Event Emitter    │ │
│  │  (per call)  │  │   (live updates → UI)        │ │
│  └──────────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
          │                        │
┌─────────▼──────────┐   ┌────────▼───────────────────┐
│   Codebase (Disk)  │   │  Monitoring UI (localhost) │
└────────────────────┘   │  http://localhost:7842      │
                         └────────────────────────────┘
```

---

## Projektstruktur

```
mcp-codebase-indexer/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              ← MCP Server Entry Point
│   ├── server.ts             ← Server-Setup & Tool-Registrierung
│   ├── indexer/
│   │   ├── index.ts          ← Indexer Orchestrator
│   │   ├── parser.ts         ← Code-Parsing via tree-sitter
│   │   ├── summarizer.ts     ← LLM-Summary Generierung (optional)
│   │   └── watcher.ts        ← File-System Watcher
│   ├── db/
│   │   ├── schema.ts         ← SQLite Schema (inkl. token_log Tabelle)
│   │   └── queries.ts        ← DB Query Helpers
│   ├── tools/
│   │   ├── get_symbol.ts
│   │   ├── get_file_summary.ts
│   │   ├── get_context.ts
│   │   ├── search_symbols.ts
│   │   ├── find_usages.ts
│   │   ├── get_dependencies.ts
│   │   └── reindex.ts
│   ├── monitoring/
│   │   ├── server.ts         ← Express + WebSocket Server (Port 7842)
│   │   ├── token-logger.ts   ← Logging jedes Tool-Calls + Token-Schätzung
│   │   ├── estimator.ts      ← Hypothetischer "ohne Index"-Vergleich
│   │   └── ui/
│   │       ├── index.html    ← Single-Page Monitoring Dashboard
│   │       ├── dashboard.js  ← Live-Charts via Chart.js (CDN)
│   │       └── styles.css    ← Minimales Styling
├── .mcp.json                 ← MCP Konfiguration
└── README.md
```

---

## Datenbank-Schema (SQLite)

```sql
-- Dateien
CREATE TABLE files (
  id          INTEGER PRIMARY KEY,
  path        TEXT UNIQUE NOT NULL,      -- relativ zum Projekt-Root
  language    TEXT NOT NULL,             -- ts, py, go, etc.
  summary     TEXT,                      -- LLM-generierte Zusammenfassung
  last_indexed DATETIME,
  hash        TEXT,                      -- MD5 des Inhalts (für Change Detection)
  raw_token_estimate INTEGER             -- geschätzte Token wenn Datei direkt geladen würde
);

-- Symbole (Funktionen, Klassen, Variablen, Exports)
CREATE TABLE symbols (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER REFERENCES files(id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- function | class | method | const | type | interface
  signature   TEXT NOT NULL,            -- z.B. "createUser(email: string): Promise<User>"
  summary     TEXT,                      -- 1-2 Satz Beschreibung
  start_line  INTEGER,
  end_line    INTEGER,
  is_exported BOOLEAN DEFAULT 0
);

-- Abhängigkeiten / Imports
CREATE TABLE dependencies (
  id          INTEGER PRIMARY KEY,
  from_file   INTEGER REFERENCES files(id),
  to_file     INTEGER REFERENCES files(id),
  symbol_name TEXT                       -- welches Symbol konkret importiert wird
);

-- Symbol-Usages (wer ruft wen auf)
CREATE TABLE usages (
  id           INTEGER PRIMARY KEY,
  symbol_id    INTEGER REFERENCES symbols(id),
  used_in_file INTEGER REFERENCES files(id),
  used_at_line INTEGER
);

-- Volltext-Suche
CREATE VIRTUAL TABLE symbols_fts USING fts5(
  name, summary, signature, content=symbols
);

-- Token-Logging (für Monitoring UI)
CREATE TABLE token_log (
  id                  INTEGER PRIMARY KEY,
  timestamp           DATETIME DEFAULT CURRENT_TIMESTAMP,
  session_id          TEXT,                    -- UUID pro Claude-Session
  tool_name           TEXT NOT NULL,           -- welches MCP Tool aufgerufen wurde
  tokens_used         INTEGER NOT NULL,        -- tatsächlich verbrauchte Token (geschätzt)
  tokens_without_index INTEGER NOT NULL,       -- hypothetischer Verbrauch ohne Index
  files_touched       TEXT,                    -- JSON Array der betroffenen Dateien
  query               TEXT                     -- die ursprüngliche Anfrage (optional)
);

-- Session-Aggregation für Vergleichs-Dashboard
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,              -- UUID
  started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  mode          TEXT NOT NULL,                 -- 'indexed' | 'baseline'
  label         TEXT,                          -- frei wählbares Label z.B. "Feature: Auth-Refactor"
  total_tokens  INTEGER DEFAULT 0,
  total_savings INTEGER DEFAULT 0
);
```

---

## MCP Tools

### 1. `search_symbols`
**Zweck:** Einstiegspunkt – findet relevante Symbole ohne Code zu laden.

```typescript
Input:  { query: string, limit?: number }
Output: Array<{ name, kind, signature, summary, file, line }>
Tokens: ~20 Input / ~100 Output (statt 2000+ für ganze Dateien)
```

---

### 2. `get_symbol`
**Zweck:** Details zu einem einzelnen Symbol – Signatur, Summary, Ort.

```typescript
Input:  { name: string, file?: string }
Output: { name, kind, signature, summary, file, startLine, endLine, dependencies[] }
Tokens: ~15 Input / ~80 Output
```

---

### 3. `get_context`
**Zweck:** Lädt **nur** einen definierten Zeilenbereich einer Datei.

```typescript
Input:  { file: string, line: number, range?: number } // range default: 30
Output: { code: string, language: string, startLine: number }
Tokens: ~20 Input / ~200 Output (nur relevante Zeilen, nicht ganze Datei)
```

---

### 4. `get_file_summary`
**Zweck:** Überblick über eine Datei ohne ihren Inhalt zu laden.

```typescript
Input:  { file: string }
Output: { summary, language, symbols: Array<{ name, kind, signature }>, imports[], exports[] }
Tokens: ~15 Input / ~150 Output
```

---

### 5. `find_usages`
**Zweck:** Wo wird ein Symbol verwendet?

```typescript
Input:  { symbol: string }
Output: Array<{ file, line, context: string }> // context = 1 Zeile Umgebung
Tokens: ~15 Input / ~100 Output
```

---

### 6. `get_dependencies`
**Zweck:** Import-Graph für ein Symbol oder eine Datei.

```typescript
Input:  { target: string, direction?: "imports" | "imported_by" | "both" }
Output: { imports: string[], importedBy: string[] }
Tokens: ~15 Input / ~80 Output
```

---

### 7. `get_project_overview`
**Zweck:** Initiale Orientierung – Projektstruktur auf hohem Level.

```typescript
Input:  {}
Output: { 
  rootPath, language, entryPoints: string[],
  modules: Array<{ path, summary, symbolCount }>,
  stats: { totalFiles, totalSymbols }
}
Tokens: ~5 Input / ~200 Output
```

---

### 8. `reindex`
**Zweck:** Index für eine Datei oder das ganze Projekt neu aufbauen.

```typescript
Input:  { target?: string } // leer = alles
Output: { indexed: number, updated: number, errors: string[] }
```

---

### 9. `get_token_stats`
**Zweck:** Aktuelle Session-Statistiken für das Monitoring abrufen.

```typescript
Input:  { session_id?: string } // leer = aktuelle Session
Output: {
  session_id, started_at,
  tokens_used: number,
  tokens_saved: number,
  savings_percent: number,
  calls: Array<{ tool, tokens_used, tokens_without_index, timestamp }>
}
```

---

### 10. `start_comparison`
**Zweck:** Einen A/B-Vergleich zwischen indexierter und nicht-indexierter Session starten.

```typescript
Input:  { label: string, mode: "indexed" | "baseline" }
Output: { session_id: string, monitoring_url: string }
// Öffnet automatisch den Browser mit dem Vergleichs-Dashboard
```

---

## Monitoring UI

### Überblick

Ein lokaler Webserver (Express + WebSocket) läuft parallel zum MCP Server und stellt ein Live-Dashboard bereit.

**URL:** `http://localhost:7842`

### Dashboard-Bereiche

#### 1. Live Session Overview (Hauptscreen)
```
┌─────────────────────────────────────────────────────────┐
│  🟢 Session aktiv  |  Label: "Auth-Refactor"  |  12:34  │
├───────────────┬───────────────┬────────────────────────┤
│  Token genutzt│  Token gespart│     Effizienz           │
│    1.240       │    9.760       │   ████████░░  88.7%    │
│  (mit Index)  │  (geschätzt)  │                         │
├───────────────┴───────────────┴────────────────────────┤
│  Live Token-Verlauf (letzte 20 Tool-Calls)              │
│  ↑                                                      │
│  │ ░░  ░░░  ░░  ░░                                     │
│  │ ██  ███  ██  ██  (blau = tatsächlich, grau = ohne)  │
│  └─────────────────────────────────────────────────────│
├─────────────────────────────────────────────────────────┤
│  Letzte Aufrufe                                          │
│  12:34:01  search_symbols("login")    18 / ~850 Token   │
│  12:34:03  get_symbol("AuthService")  72 / ~1200 Token  │
│  12:34:05  get_context(auth.ts, 87)  145 / ~980 Token   │
└─────────────────────────────────────────────────────────┘
```

#### 2. Vergleichs-Dashboard (A/B View)
```
┌─────────────────────────────────────────────────────────┐
│  Session Vergleich: "Auth-Refactor"                      │
├──────────────────────┬──────────────────────────────────┤
│  MIT Index           │  OHNE Index (Baseline)            │
│  ──────────────────  │  ──────────────────────────────  │
│  Token: 1.240        │  Token: 11.400 (simuliert)        │
│  Aufrufe: 14         │  Aufrufe: ~8 (größer aber mehr)   │
│  Ø/Aufruf: 88        │  Ø/Aufruf: ~1.425                 │
│                      │                                   │
│  [██████████░░░░░░]  │  [████████████████████████████]   │
│       11%            │              100%                  │
├──────────────────────┴──────────────────────────────────┤
│  Geschätzte Kosteneinsparung: $0.024 / Session           │
│  Hochgerechnet auf 100 Sessions: ~$2.40                  │
│  (Basis: claude-sonnet @ $3 / 1M Input-Token)            │
└─────────────────────────────────────────────────────────┘
```

#### 3. Session History
```
┌─────────────────────────────────────────────────────────┐
│  Session History (letzte 30 Tage)                        │
├────────────────┬──────────────┬─────────────┬──────────┤
│  Label         │  Token used  │  Saved      │  %       │
├────────────────┼──────────────┼─────────────┼──────────┤
│  Auth-Refactor │     1.240    │    9.760    │  88.7%   │
│  Fix: DB-Query │       680    │    5.320    │  88.7%   │
│  Feature: API  │     2.100    │   14.900    │  87.6%   │
│  Baseline-Test │    11.400    │        -    │   0.0%   │
├────────────────┼──────────────┼─────────────┼──────────┤
│  GESAMT        │     5.020    │   30.480    │  85.8%   │
│  Kosten gespart: ~$0.091                                │
└─────────────────────────────────────────────────────────┘
```

### Token-Schätzungs-Logik (`estimator.ts`)

Die Kernfrage: Wie viele Token hätte ein Request **ohne** den Index benötigt?

```typescript
// Heuristik für hypothetischen Token-Verbrauch ohne Index
function estimateWithoutIndex(toolCall: ToolCall): number {
  switch (toolCall.tool) {
    
    case 'search_symbols':
      // Ohne Index: Claude hätte alle potenziell relevanten Dateien geladen
      // Schätzung: Durchschnitt der Dateigröße × Anzahl wahrscheinlich betroffener Dateien
      const affectedFiles = findFilesMatchingQuery(toolCall.query);
      return affectedFiles.reduce((sum, f) => sum + f.raw_token_estimate, 0);

    case 'get_symbol':
      // Ohne Index: Mindestens die Host-Datei vollständig laden
      const hostFile = findFileForSymbol(toolCall.name);
      return hostFile.raw_token_estimate;

    case 'get_context':
      // Ohne Index: Ganze Datei laden (nicht nur den Ausschnitt)
      const file = getFile(toolCall.file);
      return file.raw_token_estimate;

    case 'get_dependencies':
      // Ohne Index: Alle Dateien im Import-Baum laden
      const deps = getAllTransitiveDeps(toolCall.target);
      return deps.reduce((sum, f) => sum + f.raw_token_estimate, 0);

    default:
      return toolCall.tokens_used * 10; // Fallback: 10x Multiplikator
  }
}

// Token-Schätzung für eine Datei (einmal beim Indexieren berechnet)
function estimateFileTokens(content: string): number {
  // Grobe Heuristik: ~4 Zeichen pro Token (GPT/Claude Standard)
  return Math.ceil(content.length / 4);
}
```

### WebSocket Event-Schema

```typescript
// Jeder Tool-Call sendet dieses Event an verbundene UI-Clients
interface TokenEvent {
  type: 'tool_call';
  session_id: string;
  timestamp: string;
  tool: string;
  query?: string;
  tokens_actual: number;       // tatsächlich verbraucht
  tokens_estimated: number;    // ohne Index geschätzt
  savings: number;             // Differenz
  savings_percent: number;
  cumulative_actual: number;   // Session-Gesamt
  cumulative_savings: number;
}

// Session-Updates
interface SessionEvent {
  type: 'session_update' | 'session_start' | 'session_end';
  session: Session;
}
```

### UI-Technologie-Stack

Bewusst **minimale Dependencies** – läuft ohne Build-Step direkt aus `dist/`:

```html
<!-- index.html lädt alles via CDN -->
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dayjs"></script>

<!-- Vanilla JS + WebSocket – kein React/Vue nötig -->
<!-- CSS: einfaches Dark-Theme mit CSS Grid -->
```

---

## A/B Vergleichs-Modus

### Wie es funktioniert

Der Vergleich basiert nicht auf zwei echten Sessions (das wäre aufwändig), sondern auf **Simulation**: Für jeden indexierten Tool-Call wird parallel berechnet, wie ein äquivalenter Request ohne Index ausgesehen hätte.

```
Ablauf:

1. User startet Session mit Label:
   → mcp tool: start_comparison({ label: "Fix: Login-Bug", mode: "indexed" })

2. Während der Arbeit loggt token-logger.ts jeden Tool-Call:
   → tatsächliche Token (MCP Response-Größe schätzen)
   → hypothetische Token (estimator.ts Heuristik)

3. Dashboard zeigt beide Werte in Echtzeit nebeneinander

4. Optional: "Baseline-Session" aufnehmen
   → mode: "baseline" – MCP Tools sind deaktiviert
   → Claude liest Dateien direkt
   → Claude Code protokolliert file_read Events
   → Token werden direkt gemessen (keine Schätzung nötig)
```

### Baseline-Session (echter Vergleich)

Für einen **echten** Vergleich (statt Simulation) kann eine Baseline-Session mit deaktiviertem Index laufen:

```typescript
// In server.ts: Baseline-Mode deaktiviert alle Query-Tools
if (process.env.BASELINE_MODE === 'true') {
  // Tools geben nur Fehlermeldung zurück → Claude liest Dateien direkt
  // Token-Logger misst trotzdem alle Aktivität
  tools.forEach(tool => tool.handler = () => ({ 
    error: "Index deaktiviert für Baseline-Messung" 
  }));
}
```

Der Monitoring-Server kann dann zwei Sessions direkt nebeneinander zeigen – eine indexiert, eine Baseline – und die echte Ersparnis berechnen.

---

## Implementierungs-Phasen

### Phase 1 – Core (MVP)
- [ ] MCP Server Setup mit `@modelcontextprotocol/sdk`
- [ ] SQLite DB mit Schema initialisieren (inkl. `token_log` + `sessions`)
- [ ] Parser mit `tree-sitter` für TypeScript/JavaScript
- [ ] Statische Analyse: Symbole + Signaturen extrahieren, `raw_token_estimate` pro Datei berechnen
- [ ] Tools: `search_symbols`, `get_symbol`, `get_context`, `get_file_summary`
- [ ] CLI: `mcp-indexer init <path>` zum ersten Indexieren

### Phase 2 – Usages & Dependencies
- [ ] Import-Graph aufbauen und in DB speichern
- [ ] Usage-Tracking: Wer ruft welche Funktion auf?
- [ ] Tools: `find_usages`, `get_dependencies`, `get_project_overview`
- [ ] Volltext-Suche via FTS5 aktivieren

### Phase 3 – Monitoring UI
- [ ] Token-Logger: jeden Tool-Call mit tatsächlichen + geschätzten Token loggen
- [ ] `estimator.ts`: Heuristik für hypothetischen "ohne Index"-Verbrauch
- [ ] Express + WebSocket Server auf Port 7842
- [ ] Dashboard HTML/JS: Live-Charts (Chart.js via CDN), Tool-Call Feed
- [ ] Session-Verwaltung: Start/Stop, Label vergeben
- [ ] Tools: `get_token_stats`, `start_comparison`
- [ ] Browser automatisch öffnen bei `start_comparison`

### Phase 4 – A/B Vergleich & Baseline
- [ ] Baseline-Mode: MCP Tools deaktivierbar via Env-Variable
- [ ] Vergleichs-Dashboard: zwei Sessions nebeneinander
- [ ] Session History mit persistenter Auswertung
- [ ] Kostenschätzung konfigurierbar (Preis/Token einstellbar)
- [ ] Export: Session-Report als JSON/CSV

### Phase 5 – Auto-Update & Multi-Language
- [ ] File-System Watcher mit `chokidar`
- [ ] Inkrementelles Re-Indexieren (nur geänderte Dateien via Hash-Vergleich)
- [ ] Git-Hook Integration (pre-commit)
- [ ] Python Support via `tree-sitter-python`
- [ ] Go, Rust, Java Support
- [ ] Optionale LLM-Summaries (einmaliger API-Call pro Symbol, gecacht)

---

## Setup & Konfiguration

### `.mcp.json` (Projekt-Root)
```json
{
  "mcpServers": {
    "codebase-indexer": {
      "command": "node",
      "args": ["./node_modules/.bin/mcp-codebase-indexer"],
      "env": {
        "INDEX_PATH": "./.codebase-index/index.db",
        "PROJECT_ROOT": ".",
        "LANGUAGES": "typescript,javascript",
        "AUTO_REINDEX": "true",
        "GENERATE_SUMMARIES": "false",
        "MONITORING_PORT": "7842",
        "MONITORING_AUTO_OPEN": "true",
        "BASELINE_MODE": "false",
        "TOKEN_PRICE_PER_MILLION": "3.00"
      }
    }
  }
}
```

### `package.json` (Basis)
```json
{
  "name": "mcp-codebase-indexer",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "mcp-codebase-indexer": "./dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^9.0.0",
    "tree-sitter": "^0.21.0",
    "tree-sitter-typescript": "^0.21.0",
    "tree-sitter-python": "^0.21.0",
    "chokidar": "^3.6.0",
    "glob": "^10.0.0",
    "express": "^4.18.0",
    "ws": "^8.16.0",
    "open": "^9.1.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^4.17.0",
    "@types/ws": "^8.5.0",
    "@types/uuid": "^9.0.0",
    "@types/node": "^20.0.0"
  }
}
```

---

## Beispiel-Nutzung (Claude Code Workflow)

**Vorher (ohne Indexer):**
```
→ Lese auth/service.ts        (1200 Token)
→ Lese auth/middleware.ts      (800 Token)
→ Lese types/user.ts           (400 Token)
→ Lese utils/jwt.ts            (600 Token)
Gesamt: ~3000 Token
```

**Nachher (mit Indexer):**
```
→ search_symbols("login")                    (50 Token)
→ get_symbol("AuthService.login")            (80 Token)
→ get_context("auth/service.ts", 87, 25)    (150 Token)
Gesamt: ~280 Token  →  91% Ersparnis
```

---

## Wichtige Design-Entscheidungen

**Warum SQLite statt JSON-Files?**
→ Volltext-Suche (FTS5), schnelle Queries, ACID-safe bei Concurrent Updates. Auch das Token-Log ist persistent und survives MCP Server Restarts.

**Warum tree-sitter statt Regex/eigener Parser?**
→ Präzise, schnell, battle-tested, für 50+ Sprachen verfügbar.

**Warum keine verpflichtenden LLM-Summaries?**
→ Statische Analyse liefert sofort 80% des Nutzens. Summaries sind optional und kostenintensiv beim Setup – sinnvoll erst bei größeren Codebasen (>100 Dateien).

**Inkrementelles Indexieren via MD5-Hash:**
→ Bei jedem File-Change wird der Hash verglichen. Nur geänderte Dateien werden neu geparst – macht Re-Indexing in <100ms pro Datei.

**Token-Schätzung als Heuristik – nicht exakt:**
→ Die "ohne Index"-Werte sind Schätzungen, keine Messungen. Sie sind bewusst konservativ kalkuliert (real wäre die Ersparnis oft noch größer, da Claude ohne Index oft mehrere Runden braucht). Der Baseline-Mode liefert echte Messwerte.

**Warum Vanilla JS im Dashboard statt React/Vue?**
→ Kein Build-Step, keine Node-Dependencies im Browser, sofort lauffähig. Chart.js via CDN reicht für alle benötigten Visualisierungen.

---

## Erweiterungsmöglichkeiten (Backlog)

- **Embedding-basierte Suche:** Symbole als Vektoren indexieren für semantische Ähnlichkeitssuche
- **Call-Graph Visualisierung:** Abhängigkeiten als Graph exportieren
- **Test-Coverage Mapping:** Welche Symbole haben Tests, welche nicht?
- **Changelog-Tracking:** Welche Symbole haben sich seit letztem Commit geändert?
- **Cross-Repo Indexing:** Mehrere Repos in einem Index zusammenführen
- **Monitoring: Team-Mode:** Mehrere Entwickler teilen ein Dashboard, aggregierte Team-Statistiken
- **Monitoring: Alerts:** Benachrichtigung wenn Token-Verbrauch pro Session einen Threshold überschreitet
- **Monitoring: Trends:** Langzeit-Chart über Wochen/Monate, Korrelation mit Codebase-Wachstum

---

## Onboarding-Prozess

### Ziel des Onboardings

Ein User installiert das Tool **einmalig global**, startet es **einmalig**, und ab dann funktioniert es **automatisch** für jedes Projekt in dem Claude Code geöffnet wird – ohne weitere Konfiguration.

```
User-Erfahrung in 3 Schritten:

  1.  npm install -g mcp-codebase-indexer     (~30 Sekunden)
  2.  mcp-indexer setup                        (~10 Sekunden, einmalig)
  3.  claude code .                            → alles automatisch ✓
```

---

### Schritt 1: Globale Installation

```bash
npm install -g mcp-codebase-indexer
```

Das Paket registriert zwei globale CLI-Commands:
- `mcp-indexer` – Haupt-CLI
- `mcp-indexer-daemon` – Background-Daemon (wird von `setup` gestartet)

---

### Schritt 2: Einmaliges Setup (`mcp-indexer setup`)

Das Setup-Script läuft **einmalig** und richtet alles ein:

```
$ mcp-indexer setup

  ╔══════════════════════════════════════════════╗
  ║     MCP Codebase Indexer – Setup             ║
  ╚══════════════════════════════════════════════╝

  ✓ Node.js v20.11.0 gefunden
  ✓ Claude Code CLI gefunden (claude v1.x.x)

  [1/4] Globale Konfiguration anlegen...
        → ~/.mcp-indexer/config.json         ✓

  [2/4] MCP Server in Claude Code registrieren...
        → ~/.claude/claude_code_config.json  ✓
        (MCP Server "codebase-indexer" global eingetragen)

  [3/4] Daemon als Autostart einrichten...
        macOS:   ~/Library/LaunchAgents/com.mcp-indexer.plist  ✓
        Linux:   ~/.config/systemd/user/mcp-indexer.service    ✓
        Windows: Startup-Eintrag in der Registry               ✓

  [4/4] Daemon starten...
        → mcp-indexer-daemon läuft auf Port 7841 (MCP)
        → Monitoring UI verfügbar auf Port 7842
        → http://localhost:7842                                 ✓

  ════════════════════════════════════════════════
  ✅  Setup abgeschlossen!

  Starte jetzt Claude Code in einem Projekt:
    cd /dein/projekt
    claude code .

  Der Indexer erkennt das Projekt automatisch.
  ════════════════════════════════════════════════
```

#### Was `setup` im Detail tut

**Globale Konfig (`~/.mcp-indexer/config.json`):**
```json
{
  "version": "1.0.0",
  "daemon": {
    "mcpPort": 7841,
    "monitoringPort": 7842,
    "autoStart": true
  },
  "indexing": {
    "languages": ["typescript", "javascript", "python"],
    "ignore": ["node_modules", ".git", "dist", "build", ".next"],
    "generateSummaries": false
  },
  "tokenPrice": {
    "inputPerMillion": 3.00,
    "model": "claude-sonnet"
  }
}
```

**Claude Code global registrieren (`~/.claude/claude_code_config.json`):**
```json
{
  "mcpServers": {
    "codebase-indexer": {
      "command": "mcp-indexer-daemon",
      "args": ["--client-mode"],
      "env": {}
    }
  }
}
```

> Claude Code liest diese globale Config automatisch und verbindet sich beim Start mit dem MCP Server. Kein `.mcp.json` im Projekt nötig.

**Daemon als Systemdienst (macOS Beispiel, LaunchAgent):**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mcp-indexer</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/mcp-indexer-daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>~/.mcp-indexer/daemon.log</string>
</dict>
</plist>
```

---

### Schritt 3: Claude Code starten – alles passiert automatisch

```bash
cd /mein/typescript-projekt
claude code .
```

#### Automatischer Ablauf beim Claude Code Start

```
Claude Code startet
       │
       ▼
Claude Code liest ~/.claude/claude_code_config.json
       │
       ▼
Verbindet sich mit mcp-indexer-daemon (Port 7841)
       │
       ▼
MCP Server empfängt Verbindung + übergibt CWD (/mein/typescript-projekt)
       │
       ▼
project-detector.ts prüft: Ist dieses Projekt bereits indexiert?
       ├── JA, Index aktuell → direkt bereit (< 1s)
       ├── JA, aber veraltet → inkrementelles Update (Hintergrund)
       └── NEIN → Auto-Indexing startet (Hintergrund, non-blocking)
                        │
                        ▼
              Initiales Indexing läuft parallel
              (Claude Code kann bereits arbeiten,
               Index wird live befüllt)
                        │
                        ▼
              Indexing abgeschlossen: MCP Tools vollständig verfügbar
              Monitoring UI zeigt neues Projekt an
```

#### Auto-Indexing Feedback in Claude Code

Das MCP Tool `get_project_overview` liefert während des Indexings einen Status-Hinweis, den Claude Code anzeigen kann:

```
[MCP: codebase-indexer] Projekt erkannt: my-typescript-projekt
Indexing läuft... 47/312 Dateien (15%) – Tools bereits nutzbar
```

Sobald der Index vollständig ist:
```
[MCP: codebase-indexer] ✓ Index bereit: 312 Dateien, 1.847 Symbole
Monitoring: http://localhost:7842
```

---

### Daemon-Architektur

Der Daemon läuft **persistent im Hintergrund** und verwaltet mehrere Projekte gleichzeitig:

```
mcp-indexer-daemon
       │
       ├── MCP Server (Port 7841)        ← Claude Code verbindet sich hier
       │     └── Multi-Projekt Router    ← leitet Requests ans richtige Projekt
       │
       ├── Monitoring HTTP+WS (Port 7842)← Browser Dashboard
       │
       └── Projekt-Manager
             ├── Projekt A: /Users/max/project-a  [aktiv, 312 Dateien]
             ├── Projekt B: /Users/max/project-b  [idle, 89 Dateien]
             └── Projekt C: /Users/max/project-c  [indexiert am 2026-02-20]
```

**Projekt-Erkennung:** Der Daemon erkennt das aktuelle Projekt anhand des `cwd` (current working directory) das Claude Code beim MCP-Handshake übergibt.

**Mehrere Projekte parallel:** Jedes Projekt hat seinen eigenen SQLite-Index unter:
```
~/.mcp-indexer/projects/
  ├── a1b2c3d4/          ← Hash des Projekt-Pfads
  │   ├── index.db
  │   └── meta.json      ← { "path": "/Users/max/project-a", "lastIndexed": "..." }
  └── e5f6g7h8/
      ├── index.db
      └── meta.json
```

---

### Vollständige Dateistruktur nach Setup

```
~/.mcp-indexer/
├── config.json                   ← Globale Konfiguration
├── daemon.log                    ← Daemon-Logs
├── daemon.pid                    ← PID des laufenden Daemons
└── projects/
    ├── a1b2c3d4/                 ← Projekt-Index (Hash des Pfads)
    │   ├── index.db
    │   └── meta.json
    └── ...

~/.claude/
└── claude_code_config.json       ← MCP Server Registrierung (von setup geschrieben)
```

---

### CLI-Übersicht

```bash
# Einmaliges Setup (MCP registrieren, Daemon einrichten)
mcp-indexer setup

# Daemon-Verwaltung
mcp-indexer start              # Daemon manuell starten
mcp-indexer stop               # Daemon stoppen
mcp-indexer restart            # Daemon neustarten
mcp-indexer status             # Status + alle Projekte anzeigen

# Projekt-Verwaltung
mcp-indexer index [path]       # Aktuelles Verzeichnis (oder Pfad) manuell indexieren
mcp-indexer index --force      # Komplettes Re-Indexing erzwingen
mcp-indexer list               # Alle indexierten Projekte anzeigen
mcp-indexer remove [path]      # Projekt aus dem Index entfernen

# Monitoring
mcp-indexer monitor            # Browser mit Dashboard öffnen
mcp-indexer stats              # Token-Stats der aktuellen Session im Terminal

# Deinstallation
mcp-indexer uninstall          # Alles rückgängig machen (Autostart, Config, Daemon)
```

---

### Edge Cases & Fehlerbehandlung

**Daemon läuft nicht wenn Claude Code startet:**
```typescript
// client-mode.ts: Wenn Daemon nicht erreichbar → Fallback: Server inline starten
if (!await isDaemonRunning()) {
  console.warn('[mcp-indexer] Daemon nicht gefunden – starte inline...');
  await startInlineServer();  // Läuft im selben Prozess wie Claude Code
}
```

**Kein Node.js installiert:**
→ `setup` erkennt fehlendes Node.js und zeigt klare Fehlermeldung mit Installationslink.

**Kein Claude Code CLI:**
→ Setup schlägt fehl mit Hinweis: `Claude Code nicht gefunden. Installiere es mit: npm install -g @anthropic-ai/claude-code`

**Projekt zu groß (>10.000 Dateien):**
→ Setup fragt interaktiv: "Das Projekt hat >10.000 Dateien. Soll der Indexer nur `src/` berücksichtigen?" → User kann Includes/Excludes konfigurieren.

**Port bereits belegt:**
→ Automatisch nächsten freien Port suchen (7841+1, 7841+2, ...) und Config aktualisieren.

---

### Implementierungs-Details: `setup`-Script

```typescript
// src/cli/setup.ts
export async function runSetup() {
  const ui = new SetupUI();  // Schöne Terminal-Ausgabe mit Checkmarks

  // 1. Voraussetzungen prüfen
  await ui.step('Voraussetzungen prüfen', async () => {
    await checkNodeVersion('>=18.0.0');
    await checkClaudeCodeCLI();
  });

  // 2. Globale Config anlegen
  await ui.step('Konfiguration anlegen', async () => {
    await fs.mkdir(MCP_INDEXER_HOME, { recursive: true });
    await writeDefaultConfig(MCP_INDEXER_HOME + '/config.json');
  });

  // 3. Claude Code global konfigurieren
  await ui.step('Claude Code konfigurieren', async () => {
    await registerMcpServer(CLAUDE_CODE_CONFIG_PATH, {
      name: 'codebase-indexer',
      command: 'mcp-indexer-daemon',
      args: ['--client-mode']
    });
  });

  // 4. Autostart einrichten
  await ui.step('Autostart einrichten', async () => {
    const platform = process.platform;
    if (platform === 'darwin') await installLaunchAgent();
    else if (platform === 'linux') await installSystemdService();
    else if (platform === 'win32') await installWindowsStartup();
  });

  // 5. Daemon starten
  await ui.step('Daemon starten', async () => {
    await startDaemon();
    await waitForDaemon(timeout: 5000);
  });

  ui.success(`
Setup abgeschlossen!
Starte Claude Code in einem Projekt: claude code .
Monitoring Dashboard: http://localhost:7842
  `);
}
```

---

### Update-Mechanismus

```bash
# Update auf neue Version
npm update -g mcp-codebase-indexer

# Der Daemon erkennt beim Neustart automatisch neue Versionen
# und migriert die SQLite-Schemas falls nötig (via Migrations-System)
```

Schema-Migrationen:
```typescript
// db/migrations.ts
const migrations = [
  { version: 1, up: (db) => db.exec('ALTER TABLE files ADD COLUMN ...') },
  { version: 2, up: (db) => db.exec('CREATE INDEX ...') },
];

export async function runMigrations(db: Database) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of migrations.filter(m => m.version > current)) {
    m.up(db);
    db.pragma(`user_version = ${m.version}`);
  }
}
```

---

### Onboarding Phase im Implementierungsplan

Diese Phase wird als **Phase 0** vor allen anderen umgesetzt, da sie die Grundlage für die Nutzererfahrung bildet:

**Phase 0 – Onboarding & Distribution**
- [ ] `setup`-Command mit Terminal-UI (Schritt-für-Schritt mit Checkmarks)
- [ ] Plattform-Detection: macOS / Linux / Windows
- [ ] LaunchAgent / systemd / Windows Registry Autostart
- [ ] `~/.claude/claude_code_config.json` schreiben/patchen (bestehende Config erhalten!)
- [ ] Daemon-Architektur: Multi-Projekt-Routing, PID-File, Graceful Shutdown
- [ ] Projekt-Erkennung via CWD beim MCP-Handshake
- [ ] Auto-Indexing beim ersten Connect (non-blocking, Hintergrund)
- [ ] Fallback: Inline-Server wenn Daemon nicht erreichbar
- [ ] `uninstall`-Command (alles sauber rückgängig)
- [ ] `status`-Command für Troubleshooting
- [ ] Schema-Migrations-System für Updates
- [ ] README mit Quickstart (3 Zeilen)

---
*Erstellt als Implementierungsgrundlage für Claude Code – Phase 0 (Onboarding) + Phase 1 (Core) + Phase 3 (Monitoring) bilden das vollständige MVP, umsetzbar in ~10–12h.*
