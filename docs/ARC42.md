# PindeX – Architekturdokumentation (ARC42)

Stand: 2026-03-03 (v1.3.0)

---

## 1. Einführung und Ziele

### 1.1 Aufgabenstellung

PindeX ist ein **MCP-Server (Model Context Protocol)**, der Codebases strukturell indexiert und über gezielte Tools AI-Assistenten wie Claude Code oder Goose Zugriff auf Symbole, Abhängigkeiten und Dokumentation gibt — ohne dass ganze Dateien in den Kontext geladen werden müssen.

**Kernproblem:** AI-Assistenten verbrauchen bei Code-Exploration viele Tokens durch vollständiges Lesen von Dateien. Bei Projekten ab ~40 Dateien übersteigt der Token-Verbrauch das, was für eine gezielte Antwort nötig wäre.

**Lösung:** PindeX parst den AST mit tree-sitter, speichert Symbole/Imports/Abhängigkeiten in SQLite (FTS5), und bietet 14 MCP-Tools die nur die jeweils benötigten Informationen zurückgeben.

### 1.2 Qualitätsziele

| Priorität | Ziel | Beschreibung |
|---|---|---|
| 1 | **Token-Effizienz** | Signifikant weniger Tokens als vollständige File-Reads bei Projekten ≥40 Dateien |
| 2 | **Inkrementalität** | Nur geänderte Dateien werden re-indexiert (MD5-Hash-Vergleich) |
| 3 | **Null-Konfiguration** | `pindex` in einem Projektverzeichnis genügt — alles andere wird automatisch konfiguriert |
| 4 | **Erweiterbarkeit** | Neue Sprachen und Tools einfach hinzufügbar |
| 5 | **Portabilität** | Läuft auf macOS, Linux und Windows (native Pfad-Normalisierung) |

### 1.3 Stakeholder

| Rolle | Erwartung |
|---|---|
| AI-Assistenten (Claude, Goose) | Schnelle, token-effiziente Antworten auf Code-Fragen |
| Entwickler | Einfache Installation, keine laufende Wartung |
| Projektleiter | Messbare Token-Einsparungen (Dashboard) |

---

## 2. Randbedingungen

### 2.1 Technische Randbedingungen

| Constraint | Begründung |
|---|---|
| **Node.js ≥ 18** | Native `fetch()` für LLM-API, ESM-Module, Performance |
| **SQLite (better-sqlite3)** | Embedded, kein Server nötig, FTS5 für Volltextsuche |
| **tree-sitter** | Native AST-Parsing, multi-language Support, Battle-tested |
| **stdio Transport** | MCP-Standard, von Claude Code und Goose unterstützt |
| **ESM Modules** | `"type": "module"` — alle Imports mit `.js` Extension |
| **TypeScript strict** | Typsicherheit, ES2022 Target |

### 2.2 Organisatorische Randbedingungen

| Constraint | Begründung |
|---|---|
| **Kein Bundler** | Nur `tsc` — minimale Build-Komplexität |
| **Pool: forks (Vitest)** | Nötig wegen better-sqlite3 native Bindings |
| **Zod-Validierung** | Alle MCP-Tool-Inputs werden runtime-validiert |

### 2.3 Konventionen

- Pfade in der DB immer mit Forward-Slashes (POSIX-Konvention)
- Relative Pfade ab Projekt-Root
- Logging via `process.stderr.write('[pindex] ...\n')`
- Fehler in nicht-kritischen Pfaden: leeres Ergebnis + Log (graceful degradation)

---

## 3. Kontextabgrenzung

### 3.1 Fachlicher Kontext

```
                     ┌─────────────────┐
                     │   Entwickler     │
                     └────────┬────────┘
                              │ startet
                              ▼
┌──────────────┐    ┌─────────────────┐    ┌──────────────────┐
│  Dateisystem │◄───│   Claude Code   │───►│    PindeX MCP    │
│  (Quellcode) │    │   / Goose       │    │    Server        │
└──────────────┘    └─────────────────┘    └────────┬─────────┘
                                                     │
                                           ┌─────────▼─────────┐
                                           │   SQLite DB        │
                                           │   (~/.pindex/)     │
                                           └───────────────────┘
```

| Nachbar | Schnittstelle | Beschreibung |
|---|---|---|
| **Claude Code / Goose** | MCP stdio | JSON-RPC über stdin/stdout, 14 registrierte Tools |
| **Dateisystem** | fs (read-only) | Quellcode lesen, Index-DB schreiben |
| **LLM-API** (optional) | HTTP/fetch | OpenAI-kompatible API für Summarization |

### 3.2 Technischer Kontext

```
┌─────────────┐  stdio  ┌──────────────┐  SQLite  ┌────────────┐
│  MCP Client │◄───────►│ pindex-server│◄────────►│  index.db  │
│(Claude Code)│         │  (Node.js)   │          └────────────┘
└─────────────┘         │              │  HTTP     ┌────────────┐
                        │              │◄────────►│ LLM API    │
                        │              │          │ (optional)  │
                        │              │          └────────────┘
                        │              │  HTTP+WS  ┌────────────┐
                        │              │──────────►│ Dashboard  │
                        └──────────────┘          │ (Browser)  │
                                                   └────────────┘
```

---

## 4. Lösungsstrategie

### 4.1 Architekturstrategie

| Entscheidung | Begründung |
|---|---|
| **Embedded DB (SQLite)** | Kein separater DB-Prozess, einfache Installation, FTS5 built-in |
| **AST-basiertes Parsing** | Sprachübergreifend konsistent, extrahiert Struktur statt Text |
| **Inkrementelles Indexing** | MD5-Hash pro Datei, nur geänderte Dateien werden re-indexiert |
| **FTS5 mit Trigger-Sync** | Automatische Synchronisation, kein Application-Code nötig |
| **Pro-Projekt Isolation** | Eigene DB + Port pro Projekt, keine Konflikte |
| **Passive Memory** | SessionObserver generiert Beobachtungen ohne Kooperation des AI |

### 4.2 Technologieentscheidungen

| Thema | Entscheidung | Alternative (verworfen) |
|---|---|---|
| **Parser** | tree-sitter | Babel/TypeScript Compiler (zu langsam, nur JS/TS) |
| **DB** | SQLite + better-sqlite3 | PostgreSQL (Overhead), LevelDB (kein FTS) |
| **Transport** | stdio | HTTP/SSE (nicht von Claude Code unterstützt bei MCP) |
| **Summarizer** | OpenAI-kompatible API | Anthropic-nativ (weniger universell) |
| **Validierung** | Zod | ajv/joi (Zod integriert sich besser mit TypeScript) |

---

## 5. Bausteinsicht

### 5.1 Ebene 1 — Gesamtsystem

```
┌─────────────────────────────────────────────────────────────────┐
│                          PindeX                                 │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │   CLI    │  │MCP Server│  │   GUI    │  │  Monitoring  │   │
│  │ (pindex) │  │(pindex-  │  │(pindex-  │  │  (per-proj)  │   │
│  │          │  │ server)  │  │ gui)     │  │              │   │
│  └──────────┘  └────┬─────┘  └──────────┘  └──────────────┘   │
│                      │                                          │
│  ┌───────────────────┴──────────────────────────────────────┐  │
│  │                    Shared Layer                           │  │
│  │  ┌────────┐  ┌─────────┐  ┌────────┐  ┌──────────────┐  │  │
│  │  │   DB   │  │ Indexer  │  │ Tools  │  │   Memory     │  │  │
│  │  └────────┘  └─────────┘  └────────┘  └──────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Ebene 2 — Komponenten

#### DB (`src/db/`)

| Modul | Verantwortung |
|---|---|
| `schema.ts` | DDL: Tabellen, FTS5, Trigger, Indexe |
| `queries.ts` | Typisierte Query-Helper (upsert, get, search, delete) |
| `database.ts` | Connection-Management (WAL-Mode, Pragma-Tuning) |
| `migrations.ts` | Schema-Versionierung via `PRAGMA user_version` |

#### Indexer (`src/indexer/`)

| Modul | Verantwortung |
|---|---|
| `index.ts` | Orchestrator — Datei-Discovery (glob), Code + Dokument-Indexierung |
| `parser.ts` | tree-sitter AST → Symbole; Regex → Routen; Text → Document-Chunks |
| `summarizer.ts` | LLM-Zusammenfassungen via OpenAI-kompatible API |
| `watcher.ts` | chokidar File-Watcher → Auto-Reindex bei Änderungen |

#### Tools (`src/tools/`)

| Modul | Tool |
|---|---|
| `search_symbols.ts` | `search_symbols` (FTS5, Federation) |
| `get_symbol.ts` | `get_symbol` |
| `get_context.ts` | `get_context` (Disk-Read) |
| `get_file_summary.ts` | `get_file_summary` |
| `find_usages.ts` | `find_usages` |
| `get_dependencies.ts` | `get_dependencies` |
| `get_project_overview.ts` | `get_project_overview` |
| `get_api_endpoints.ts` | `get_api_endpoints` |
| `reindex.ts` | `reindex` |
| `get_token_stats.ts` | `get_token_stats` |
| `start_comparison.ts` | `start_comparison` |
| `search_docs.ts` | `search_docs` |
| `get_doc_chunk.ts` | `get_doc_chunk` |
| `save_context.ts` | `save_context` |
| `get_session_memory.ts` | `get_session_memory` |
| `schemas.ts` | Zod-Schemas für alle Tool-Inputs |

#### Memory (`src/memory/`)

| Modul | Verantwortung |
|---|---|
| `ast-diff.ts` | Vergleicht Symbol-Signaturen bei Re-Index → erkennt added/removed/changed |
| `observer.ts` | SessionObserver — hookt in Tool-Handler + FileWatcher |
| `anti-patterns.ts` | Erkennt File-Thrashing, Dead-End-Exploration, Fehler-Loops |

#### Monitoring (`src/monitoring/`)

| Modul | Verantwortung |
|---|---|
| `server.ts` | Express + WebSocket Server (pro Projekt) |
| `token-logger.ts` | Loggt Token-Nutzung pro Tool-Aufruf |
| `estimator.ts` | Schätzt "Tokens ohne Index" (Heuristik) |
| `ui/` | Dashboard HTML/CSS/Chart.js |

#### CLI (`src/cli/`)

| Modul | Verantwortung |
|---|---|
| `index.ts` | CLI-Router (Argument-Parsing) |
| `init.ts` | `initProject()`, `writeMcpJson()`, `addFederatedRepo()` |
| `setup.ts` | Einmal-Setup (Autostart) |
| `daemon.ts` | PID-File Daemon-Management |
| `project-detector.ts` | `getPindexHome()`, `findProjectRoot()`, `GlobalRegistry` |

---

## 6. Laufzeitsicht

### 6.1 Initiale Indexierung

```
MCP Client          pindex-server           Indexer              SQLite
    │                    │                     │                    │
    │  ── connect ──►    │                     │                    │
    │                    │── openDatabase() ──►│                    │
    │                    │── runMigrations() ──────────────────────►│
    │                    │── indexAll() ───────►│                    │
    │                    │                     │── glob(patterns) ──┤
    │                    │                     │◄── file list ──────┤
    │                    │                     │                    │
    │                    │                     │── for each file:   │
    │                    │                     │   parseFile()      │
    │                    │                     │   hashContent()    │
    │                    │                     │   upsertFile() ───►│
    │                    │                     │   upsertSymbol() ─►│
    │                    │                     │                    │
    │                    │                     │── resolveDeps() ──►│
    │                    │                     │                    │
    │  ◄── ready ────    │                     │                    │
```

### 6.2 Tool-Aufruf (search_symbols)

```
MCP Client          server.ts            Zod             tools/            SQLite
    │                   │                  │                │                 │
    │── CallTool ──────►│                  │                │                 │
    │  {search_symbols} │── safeParse() ──►│                │                 │
    │                   │◄── valid ────────│                │                 │
    │                   │── searchSymbols()────────────────►│                 │
    │                   │                  │                │── FTS5 MATCH ──►│
    │                   │                  │                │◄── results ─────│
    │                   │                  │                │                 │
    │                   │── tokenLogger.log()               │                 │
    │                   │── observer.record()                │                 │
    │                   │── ws.broadcast()                   │                 │
    │◄── results ───────│                  │                │                 │
```

### 6.3 Auto-Reindex (File-Watcher)

```
Dateisystem         FileWatcher          Indexer              SQLite
    │                    │                  │                    │
    │── file changed ──►│                  │                    │
    │                    │── debounce(300ms)│                    │
    │                    │── indexFile() ──►│                    │
    │                    │                  │── hash vergleichen │
    │                    │                  │   (skip wenn gleich)│
    │                    │                  │── parseFile()      │
    │                    │                  │── computeAstDiff() │
    │                    │                  │── upsert ─────────►│
    │                    │                  │                    │
    │                    │── observer.onFileChanged()            │
```

---

## 7. Verteilungssicht

### 7.1 Deployment-Diagramm

```
┌─────────────────────────────────────────────────────────────┐
│                      Entwickler-Maschine                     │
│                                                              │
│  ┌────────────────┐          ┌───────────────────────────┐  │
│  │  Claude Code   │  stdio   │  pindex-server            │  │
│  │  (Electron)    │◄────────►│  (Node.js Prozess)        │  │
│  └────────────────┘          │  ├── SQLite DB             │  │
│                               │  ├── Express (Port 78xx)  │  │
│  ┌────────────────┐          │  └── WebSocket             │  │
│  │  Browser       │  HTTP    │                            │  │
│  │  (Dashboard)   │◄────────►│                            │  │
│  └────────────────┘          └───────────────────────────┘  │
│                                                              │
│  ┌────────────────┐          ┌───────────────────────────┐  │
│  │  Browser       │  HTTP    │  pindex-gui               │  │
│  │  (Agg. Dash.)  │◄────────►│  (Port 7842)              │  │
│  └────────────────┘          │  └── liest alle DBs       │  │
│                               └───────────────────────────┘  │
│                                                              │
│  ~/.pindex/                                                  │
│  ├── registry.json          (Projekt-Registry)               │
│  └── projects/                                               │
│      ├── {hash1}/index.db   (Projekt A)                      │
│      └── {hash2}/index.db   (Projekt B)                      │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Installation

| Methode | Befehl |
|---|---|
| npm global | `npm install -g pindex` |
| Aus Quellcode | `git clone ... && npm install && npm run build && npm install -g .` |

### 7.3 Binaries

| Binary | Entry Point | Startet durch |
|---|---|---|
| `pindex` | `dist/cli/index.js` | Entwickler (Terminal) |
| `pindex-server` | `dist/index.js` | Claude Code (automatisch via .mcp.json) |
| `pindex-gui` | `dist/gui/index.js` | Entwickler (Terminal) |

---

## 8. Querschnittskonzepte

### 8.1 Pfad-Normalisierung

Alle Pfade in der DB verwenden **Forward-Slashes** (POSIX-Konvention), unabhängig vom Betriebssystem. Normalisierung erfolgt in `upsertFile()`, `getFileByPath()` und `deleteFile()`.

### 8.2 Inkrementelles Indexing

Jede Datei hat einen MD5-Hash in der `files`-Tabelle. Beim Re-Index wird der neue Hash mit dem gespeicherten verglichen — bei Gleichheit wird die Datei übersprungen. Dies reduziert die Indexierungszeit bei großen Projekten erheblich.

### 8.3 FTS5-Synchronisation

Die drei FTS5-Tabellen werden über **SQLite-Trigger** synchron gehalten (AFTER INSERT/UPDATE/DELETE). Dies eliminiert die Notwendigkeit für Application-Level FTS-Management.

### 8.4 Token-Schätzung

Der `estimator.ts` berechnet für jeden Tool-Aufruf eine Heuristik: "Wie viele Tokens hätte ein vollständiger File-Read verbraucht?" — Basis für Savings-Berechnung.

### 8.5 Federation

Verlinkte Repos werden als Read-Only SQLite-Verbindungen geöffnet. Federierte Ergebnisse enthalten ein `project`-Feld. Fehler in föderierten DBs werden geloggt, beeinflussen aber nie die Haupt-Ergebnisse.

### 8.6 Session Memory

Passives System das Tool-Aufrufe und Datei-Änderungen beobachtet:

1. **SessionObserver** registriert sich bei allen Tool-Handlern und dem FileWatcher
2. Bei jedem Re-Index vergleicht der **AST-Diff-Engine** Signaturen mit `ast_snapshots`
3. Änderungen werden als `session_observations` gespeichert
4. Der **AntiPatternDetector** erkennt problematische Muster (File-Thrashing, Dead-Ends)
5. Beobachtungen werden automatisch in `get_symbol`, `get_file_summary` und `get_project_overview` ausgegeben

### 8.7 Fehlerbehandlung

| Kontext | Strategie |
|---|---|
| Tool-Input ungültig | Zod-Validierung → strukturierter MCP-Error |
| Datei nicht lesbar | Graceful: leeres Ergebnis + Fehlermeldung |
| FTS5-Query fehlerhaft | Graceful: leeres Array + `process.stderr.write` |
| Föderierte DB nicht erreichbar | Graceful: Skip + Warning |
| LLM-API-Fehler | Graceful: `null` statt Summary + Warning |

### 8.8 Concurrency

- **Summarizer:** Semaphore-basierte Begrenzung (default: 3 parallele API-Calls)
- **SQLite:** WAL-Mode für concurrent Reads, Writes immer synchron (better-sqlite3)
- **FileWatcher:** 300ms Debounce auf Datei-Änderungen

---

## 9. Architekturentscheidungen

### ADR-1: SQLite statt externer DB

**Kontext:** PindeX muss ohne externe Services laufen (Zero-Config).
**Entscheidung:** SQLite mit better-sqlite3 (synchrone native Bindings).
**Konsequenz:** Kein Multi-User-Zugriff, aber keine Installation/Konfiguration nötig. FTS5 built-in.

### ADR-2: tree-sitter statt TypeScript Compiler API

**Kontext:** PindeX unterstützt 12 Sprachen.
**Entscheidung:** tree-sitter für AST-Parsing mit sprachspezifischen Grammars.
**Konsequenz:** Konsistentes Parsing-Interface, aber Abhängigkeit von nativen Bindings (`pool: 'forks'` in Tests nötig).

### ADR-3: stdio statt HTTP Transport

**Kontext:** MCP unterstützt stdio und HTTP.
**Entscheidung:** stdio (JSON-RPC über stdin/stdout).
**Konsequenz:** Direkter Prozess-Start durch Claude Code, kein Port-Management für den MCP-Transport.

### ADR-4: Forward-Slash-Normalisierung

**Kontext:** Windows verwendet Backslashes, Tests und Indexer speichern Forward-Slashes.
**Entscheidung:** Alle DB-Pfade auf Forward-Slashes normalisieren (POSIX-Konvention).
**Konsequenz:** Konsistentes Verhalten über alle Plattformen, einmaliger Breaking Change an der DB.

### ADR-5: Passive Session Memory

**Kontext:** Claude Code kann nicht zuverlässig instruiert werden, `save_context` aufzurufen.
**Entscheidung:** SessionObserver generiert Beobachtungen automatisch durch Hooks in Tool-Handler und FileWatcher.
**Konsequenz:** Zero-Cooperation Memory — funktioniert ohne jede Instruktion des AI.

### ADR-6: Zod für Runtime-Validierung

**Kontext:** MCP-Tool-Argumente wurden unsicher gecastet (`as unknown as ...`).
**Entscheidung:** Zod-Schemas für alle 14 Tool-Inputs, Validierung vor Dispatch.
**Konsequenz:** Strukturierte Fehlermeldungen bei ungültigen Inputs, typsichere Tool-Argumente.

---

## 10. Qualitätsanforderungen

### 10.1 Qualitätsbaum

```
Qualität
├── Token-Effizienz
│   ├── get_file_summary statt vollständiger File-Read
│   ├── get_context mit Zeilen-Range
│   └── search_symbols statt Grep
├── Zuverlässigkeit
│   ├── Graceful Degradation bei Fehlern
│   ├── Inkrementelles Indexing (kein Datenverlust bei Crash)
│   └── Zod-Validierung aller Inputs
├── Wartbarkeit
│   ├── Ein Tool = eine Datei
│   ├── Schema-Migrations für DB-Evolution
│   └── 377 Unit-/Integrationstests
└── Benutzbarkeit
    ├── Zero-Config Installation (pindex)
    ├── Live Dashboard (Token-Tracking)
    └── Passive Memory (keine Instruktion nötig)
```

### 10.2 Qualitätsszenarien

| Szenario | Erwartung |
|---|---|
| AI sucht nach Symbol "AuthService" | `search_symbols` liefert Treffer in <100ms |
| Entwickler ändert eine Datei | FileWatcher erkennt Änderung, Re-Index in <1s |
| Ungültiger Tool-Input | Strukturierte Fehlermeldung, kein Crash |
| Föderiertes Repo nicht erreichbar | Hauptergebnisse unverändert, Warning im Log |
| 1000+ Dateien indexieren | Inkrementell: nur geänderte Dateien, Bulk: <30s |

---

## 11. Risiken und technische Schulden

### 11.1 Risiken

| Risiko | Wahrscheinlichkeit | Auswirkung | Mitigation |
|---|---|---|---|
| tree-sitter Breaking Changes | Niedrig | Hoch | Pinned Versions, Tests |
| SQLite DB-Korruption | Sehr niedrig | Hoch | WAL-Mode, Re-Index jederzeit möglich |
| MCP-Protokoll-Änderungen | Mittel | Mittel | SDK abstrahiert Transport |

### 11.2 Technische Schulden

| Schuld | Priorität | Beschreibung |
|---|---|---|
| Coverage ~64% | Mittel | monitoring/server.ts (33%), cli/ (36%) wenig getestet |
| `db.prepare()` nicht gecacht | Niedrig | Prepared Statements werden bei jedem Aufruf neu erstellt |
| Kein `pindex doctor` | Niedrig | Kein Diagnose-Tool für DB-Integrität |
| ListTools Schemas nicht aus Zod generiert | Niedrig | MCP `listTools` und Zod-Schemas manuell synchron |

---

## 12. Glossar

| Begriff | Bedeutung |
|---|---|
| **MCP** | Model Context Protocol — Standard-Schnittstelle zwischen AI-Assistenten und externen Tools |
| **FTS5** | Full-Text Search Engine 5 — SQLite-Erweiterung für Volltextsuche |
| **tree-sitter** | Inkrementeller Parser-Generator für Programmiersprachen |
| **stdio Transport** | JSON-RPC über Standard-Input/Output (Prozess-Kommunikation) |
| **Federation** | Verknüpfung mehrerer Projekt-Indexe für Cross-Repo-Suche |
| **Session Memory** | Automatisch generierte Beobachtungen über Tool-Nutzung und Code-Änderungen |
| **AST Diff** | Vergleich von Symbol-Signaturen zwischen zwei Index-Zeitpunkten |
| **Staleness** | Markierung einer Beobachtung als veraltet wenn das verlinkte Symbol sich geändert hat |
| **Anti-Pattern** | Erkannte problematische Nutzungsmuster (File-Thrashing, Dead-End-Exploration) |
| **Baseline Mode** | Modus in dem alle Query-Tools deaktiviert sind (für A/B Token-Vergleich) |
| **GlobalRegistry** | `~/.pindex/registry.json` — zentrale Registrierung aller PindeX-Projekte |
| **Zod** | TypeScript-first Schema-Validierungsbibliothek |
| **better-sqlite3** | Synchrone Node.js SQLite-Bindings mit nativer Performance |
| **chokidar** | Cross-Platform File-Watcher für Node.js |
