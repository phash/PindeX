# PindeX – MCP Tool Spezifikation

Stand: 2026-10-21 (16 Tools + Zod-Validierung)

---

## Übersicht

PindeX stellt 16 MCP-Tools über das **stdio-Transport** bereit. Alle Tool-Inputs werden zur Laufzeit mit **Zod-Schemas** validiert (`src/tools/schemas.ts`). Bei ungültigen Eingaben wird eine strukturierte Fehlermeldung zurückgegeben, bevor die Tool-Logik ausgeführt wird.

**Transport:** stdio (JSON-RPC über stdin/stdout)
**Protokoll:** [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
**Server-Name:** `mcp-codebase-indexer`

### Tool-Kategorien

| Kategorie | Tools | Beschreibung |
|---|---|---|
| **Code-Exploration** | `search_symbols`, `get_symbol`, `get_context`, `get_file_summary`, `find_usages`, `get_call_path`, `get_dependencies`, `get_api_endpoints` | Navigation und Analyse des indexierten Code |
| **Projekt-Management** | `get_project_overview`, `reindex` | Projektweite Statistiken und Re-Indexierung |
| **Dokumente & Kontext** | `search_docs`, `get_doc_chunk`, `save_context` | Dokumenten-Suche und persistenter Wissens-Speicher |
| **Analytics & Memory** | `get_token_stats`, `start_comparison`, `get_session_memory` | Token-Tracking, A/B-Tests, passive Beobachtungen |

### Kern-Tools (Core)

Bei aktivierter `EXPOSE_CORE_TOOLS_ONLY`-Option werden nur folgende 9 Tools exponiert:
`search_symbols`, `get_symbol`, `get_context`, `get_file_summary`, `find_usages`, `get_call_path`, `get_dependencies`, `get_project_overview`, `get_api_endpoints`

---

## Validierung

Alle Tool-Inputs durchlaufen Zod-Schema-Validierung. Bei Fehlern wird folgende Struktur zurückgegeben:

```json
{
  "content": [{
    "type": "text",
    "text": "{\"error\":\"Invalid arguments\",\"details\":[\"query: Required\"]}"
  }],
  "isError": true
}
```

---

## Code-Exploration Tools

### `search_symbols`

FTS5-Volltextsuche über alle indexierten Symbole (Name, Signatur, Summary). Bei aktivierter Federation werden auch verlinkte Repositories durchsucht.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `query` | string (min 1) | ✓ | — | Suchbegriff (unterstützt FTS5-Syntax: `"exact phrase"`, `prefix*`, `term1 OR term2`) |
| `limit` | number (int, >0) | | 20 | Maximale Ergebnisse pro Projekt |
| `isAsync` | boolean | | — | Nur async-Funktionen |
| `hasTryCatch` | boolean | | — | Nur Symbole mit try/catch |
| `snippet` | boolean | | false | Erste 5 Zeilen des Quellcodes einbinden |

**Output:**

```json
{
  "results": [
    {
      "name": "createMcpServer",
      "kind": "function",
      "signature": "export function createMcpServer(db: Database, ...): Server",
      "file": "src/server.ts",
      "line": 279,
      "is_exported": true,
      "is_async": false,
      "has_try_catch": false,
      "snippet": "export function createMcpServer(\n  db: Database.Database,\n  ..."
    }
  ],
  "federated": [
    {
      "project": "/path/to/other-repo",
      "results": [...]
    }
  ]
}
```

**Verhalten:**
- Suche über `symbols_fts` mit FTS5 `MATCH`-Operator
- Bei leerer Ergebnismenge: Fallback auf `LIKE`-Suche
- Federated: jedes verlinkte Repo wird parallel durchsucht
- Fehler in föderierten Repos werden geloggt, beeinflussen aber nicht die Haupt-Ergebnisse

---

### `get_symbol`

Detailinformationen zu einem spezifischen Symbol inklusive Signatur, Position und Datei-Abhängigkeiten.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `name` | string (min 1) | ✓ | — | Symbol-Name |
| `file` | string | | — | Dateipfad zur Disambiguierung bei gleichnamigen Symbolen |

**Output:**

```json
{
  "symbol": {
    "name": "Indexer",
    "kind": "class",
    "signature": "export class Indexer { ... }",
    "file": "src/indexer/index.ts",
    "start_line": 106,
    "end_line": 401,
    "is_exported": true,
    "summary": null
  },
  "dependencies": ["src/db/queries.ts", "src/indexer/parser.ts"],
  "memory_context": [
    {
      "type": "symbol_changed",
      "observation": "Signatur geändert: neuer Parameter summarizerOptions",
      "stale": false
    }
  ]
}
```

**Verhalten:**
- Exakter Name-Match (case-sensitive)
- Bei mehreren Treffern: `file`-Parameter zur Eingrenzung
- `memory_context` enthält relevante Session-Beobachtungen (automatisch aus `session_observations`)

---

### `get_context`

Liest einen Zeilen-Bereich aus einer Datei direkt von der Festplatte. Token-effizienter als vollständiges File-Read.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `file` | string (min 1) | ✓ | — | Projekt-relativer Dateipfad |
| `line` | number (int, >0) | ✓ | — | Ziel-Zeile (1-basiert) |
| `range` | number (int, >0) | | 30 | Zeilen ober- und unterhalb |

**Output:**

```json
{
  "file": "src/server.ts",
  "language": "typescript",
  "start_line": 27,
  "end_line": 57,
  "content": "import type { SessionObserver } from ...\n...",
  "total_lines": 450
}
```

**Verhalten:**
- Datei wird zum Aufruf-Zeitpunkt von Disk gelesen (kein Cache)
- `start_line` = max(1, line - range)
- `end_line` = min(total_lines, line + range)
- Ergebnis enthält erkannte Sprache aus der DB

---

### `get_file_summary`

Überblick über eine Datei ohne den vollständigen Quellcode zu laden.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `file` | string (min 1) | ✓ | — | Projekt-relativer Dateipfad |

**Output:**

```json
{
  "file": "src/server.ts",
  "language": "typescript",
  "summary": "MCP server with 14 tool registrations",
  "raw_token_estimate": 12500,
  "symbols": [
    { "name": "createMcpServer", "kind": "function", "signature": "...", "start_line": 279, "end_line": 450 }
  ],
  "imports": ["better-sqlite3", "./tools/search_symbols.js", ...],
  "exports": ["createMcpServer", "FederatedDb", "ServerOptions"],
  "memory_context": [...]
}
```

**Verhalten:**
- Symbole, Imports und Exports kommen aus der DB
- Summary ist LLM-generiert (wenn `GENERATE_SUMMARIES=true`) oder null
- `memory_context` enthält automatisch Session-Beobachtungen für diese Datei

---

### `find_usages`

Aufrufstellen eines Symbols, aufgelöst über den Call-Graph (`symbol_refs` + `dependencies`).

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `symbol` | string (min 1) | ✓ | — | Symbol-Name |
| `file` | string (min 1) | | — | Definierende Datei, falls der Name mehrfach definiert ist |
| `limit` | int 1..500 | | 100 | Max. Anzahl Ergebnisse |

**Output:**

```json
[
  { "file": "src/indexer/index.ts", "line": 226, "caller": "indexFile", "confidence": "EXTRACTED" }
]
```

Mehrdeutiger Name ohne `file`:

```json
{ "error": "ambiguous", "candidates": [{ "file": "src/a.ts", "line": 2, "kind": "function" }] }
```

Unbekannter Name (bzw. keine Definition in `file`): `{ "error": "not_found" }`

**Verhalten:**
- Nur aufrufbare Definitionen zählen (Kinds `function`, `method`, `class`, `const`) — für Kandidaten und Auflösung; `interface`/`type`/`enum` gleichen Namens machen einen Namen nicht mehrdeutig
- Auflösung je Referenz (erster Treffer gewinnt): (1) Symbol in derselben Datei (`this.x()` nur Methoden) → `EXTRACTED`; (2) per Import (`dependencies.symbol_name`) aus einer Datei, die es definiert → `EXTRACTED`; (3) genau eine Definition projektweit → `INFERRED`; sonst verworfen
- Member-Aufrufe auf einem anderen Receiver als `this` (`date.format()`) überspringen (1) und (2) — nie `EXTRACTED`, nur (3), und auch das nur, wenn die aufrufende Datei die Datei des Ziels ist oder irgendeine `dependencies`-Zeile zu ihr hat (sonst verworfen, nicht als mehrdeutig gezählt). So landet `arr.filter()` nicht auf einem fremden `RepoSet.filter`
- `file` darf relativ oder absolut (innerhalb des Repo-Roots) sein
- `caller` = umschließendes Symbol, `null` auf Modulebene; `project` nur bei mehr als einem Repo
- Cap: Default 100, per `limit` bis 500 Ergebnisse, angewendet nach Auflösung und Filterung auf das Ziel-Symbol (überzählige werden ohne Marker abgeschnitten)
- Bekannte Grenze: Aliased Imports (`import { a as b }`) — der Aufruf `b()` wird nicht über den Import aufgelöst

---

### `get_call_path`

Kürzeste Aufrufkette von Symbol A nach Symbol B über den Call-Graph (BFS, nur primäres Repo, kein `repos`-Parameter).

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `from` | string (min 1) | ✓ | — | Aufrufendes Symbol |
| `to` | string (min 1) | ✓ | — | Aufgerufenes Symbol |
| `from_file` | string (min 1) | | — | Definierende Datei von `from` (bei Mehrdeutigkeit) |
| `to_file` | string (min 1) | | — | Definierende Datei von `to` (bei Mehrdeutigkeit) |
| `max_depth` | int 1..12 | | 6 | Max. Anzahl Kanten |

**Output:**

```json
{ "path": [{ "from": "createMcpServer", "to": "searchSymbols", "file": "src/server.ts", "line": 389, "confidence": "EXTRACTED" }], "hops": 1 }
```

- Nicht erreichbar innerhalb `max_depth`: `{ "path": null, "hops": 0 }`
- `from` und `to` sind dasselbe Symbol: `{ "path": [], "hops": 0 }`
- Endpunkt mehrdeutig: `{ "error": "ambiguous", "side": "from" | "to", "candidates": [{ "file", "line", "kind" }] }`
- Endpunkt unbekannt: `{ "error": "not_found", "side": "from" | "to" }`

**Verhalten:**
- Kanten wie bei `find_usages` aufgelöst (`EXTRACTED`/`INFERRED`); Aufrufe auf Modulebene (ohne umschließendes Symbol) sind nicht traversierbar
- Zyklen terminieren (jeder Knoten wird höchstens einmal besucht)

---

### `get_dependencies`

Import-Graph einer Datei — was sie importiert, was sie importiert, oder beides.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `target` | string (min 1) | ✓ | — | Projekt-relativer Dateipfad |
| `direction` | `"imports"` \| `"imported_by"` \| `"both"` | | `"both"` | Traversierungs-Richtung |

**Output:**

```json
{
  "file": "src/server.ts",
  "imports": [
    { "file": "src/tools/search_symbols.ts", "symbols": ["searchSymbols"] },
    { "file": "src/tools/schemas.ts", "symbols": ["TOOL_SCHEMAS"] }
  ],
  "imported_by": [
    { "file": "src/index.ts", "symbols": ["createMcpServer"] }
  ]
}
```

---

### `get_api_endpoints`

Alle HTTP-Endpunkte (Express-Routen) in der Codebase.

**Input:** Keine Parameter.

**Output:**

```json
{
  "endpoints": [
    { "method": "GET", "path": "/api/sessions", "file": "src/monitoring/server.ts", "line": 45 },
    { "method": "POST", "path": "/api/data", "file": "src/api/routes.ts", "line": 12 }
  ]
}
```

**Verhalten:**
- Sucht in `symbols` nach Einträgen mit `kind = 'route'`
- Routenname wird als `"METHOD /path"` gespeichert (z.B. `"GET /api/sessions"`)

---

## Projekt-Management Tools

### `get_project_overview`

Projektweite Statistiken. Bei aktivierter Federation auch für verlinkte Repos.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `mode` | `"brief"` \| `"full"` | | `"full"` | `brief` = nur Zähler; `full` = mit Datei-Liste und Symbolen |

**Output (gekürzt):**

```json
{
  "project_root": "/path/to/project",
  "total_files": 85,
  "total_symbols": 420,
  "dominant_language": "typescript",
  "entry_points": ["src/index.ts", "src/cli/index.ts"],
  "modules": [
    { "path": "src/db/", "files": 4, "symbols": 45 }
  ],
  "index_recommendation": {
    "worthwhile": true,
    "reason": "85 Dateien, ⌀ 180 Zeilen/Datei — Index lohnt sich",
    "avgFileLinesEstimate": 180,
    "breakEvenFiles": 40
  },
  "memory_summary": {
    "total_observations": 12,
    "stale_count": 2,
    "anti_patterns": []
  },
  "federated": [...]
}
```

Zusätzlich in `mode: "full"`, sobald Call-Kanten existieren:

```json
{
  "hubs": [{ "symbol": "resolveWithinRoot", "file": "src/util/paths.ts", "callerFiles": 9 }],
  "communities": [{ "id": 0, "label": "src/tools", "size": 14, "topFiles": ["src/server.ts", "src/tools/schemas.ts"] }]
}
```

**Verhalten:**
- `hubs`: Top 10 Symbole nach Anzahl unterschiedlicher aufrufender Dateien (Tie: Name, dann Datei)
- `communities`: Top 8 Datei-Cluster per deterministischer Label-Propagation über Import-Paare (Gewicht 1) und Call-Kanten (Gewicht 1 je Kante); isolierte Dateien entfallen. `label` = gemeinsamer Verzeichnis-Präfix, wenn er mindestens 2 Segmente hat (z.B. `src/db`), sonst der repo-relative Pfad der Datei mit dem höchsten Grad, die kein Test ist (nicht unter `tests/`/`test/`, kein `.test.`/`.spec.`); `topFiles` max. 3
- Für beide werden Member-Aufrufe auf fremden Receivern mit Built-in-Methodennamen (`filter`, `map`, `replace`, `get`, `all`, `run`, … — `BUILTIN_METHOD_NAMES` in `src/graph/call-graph.ts`) ignoriert; `find_usages` meldet sie weiterhin
- `index_recommendation` berechnet ob sich der Index für dieses Projekt lohnt
- `memory_summary` aggregiert Session-Beobachtungen
- `entry_points` erkennt Dateien mit `index`, `main`, `app` im Namen

---

### `reindex`

Neu-Indexierung einer einzelnen Datei oder des gesamten Projekts.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `target` | string | | — | Dateipfad oder leer für Voll-Reindex |

**Output:**

```json
{
  "indexed": 12,
  "updated": 3,
  "skipped": 70,
  "errors": []
}
```

**Verhalten:**
- Einzeldatei: nur die angegebene Datei wird re-indexiert
- Voll-Reindex: `indexAll()` + `resolveDependencies()`
- MD5-Hash-Vergleich: unveränderte Dateien werden übersprungen

---

## Dokument & Kontext Tools

### `search_docs`

FTS5-Suche über indexierte Dokument-Chunks **und** gespeicherte Kontext-Einträge.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `query` | string (min 1) | ✓ | — | Suchbegriff |
| `limit` | number (int, >0) | | 20 | Maximale Ergebnisse |
| `type` | `"docs"` \| `"context"` \| `"all"` | | `"all"` | Ergebnis-Filter |

**Output:**

```json
{
  "results": [
    {
      "type": "doc",
      "file": "CLAUDE.md",
      "heading": "Authentication",
      "start_line": 12,
      "chunk_index": 2,
      "content_preview": "JWT-basierte Authentifizierung mit..."
    },
    {
      "type": "context",
      "content_preview": "JWT expiry: access=1h, refresh=7d...",
      "tags": "auth,jwt",
      "session_id": "abc-123",
      "created_at": "2026-03-03T10:15:00Z"
    }
  ]
}
```

---

### `get_doc_chunk`

Vollständigen Inhalt eines oder aller Abschnitte eines indexierten Dokuments abrufen.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `file` | string (min 1) | ✓ | — | Projekt-relativer Dateipfad |
| `chunk_index` | number (int, >=0) | | — | Spezifischer Chunk-Index (ohne = alle) |

**Output:**

```json
{
  "file": "CLAUDE.md",
  "total_chunks": 8,
  "chunks": [
    {
      "index": 2,
      "heading": "Authentication",
      "start_line": 12,
      "end_line": 45,
      "content": "## Authentication\n\nJWT-basierte..."
    }
  ]
}
```

---

### `save_context`

Speichert eine Notiz/Entscheidung im persistenten Kontext-Speicher. Abrufbar über `search_docs` in zukünftigen Sessions.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `content` | string (min 1) | ✓ | — | Zu speichernder Text |
| `tags` | string | | — | Komma-separierte Tags für besseres Retrieval |

**Output:**

```json
{
  "id": 42,
  "session_id": "abc-123",
  "created_at": "2026-03-03T10:15:00Z"
}
```

---

## Analytics & Memory Tools

### `get_token_stats`

Token-Nutzungsstatistiken für eine Session.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `session_id` | string | | aktuelle Session | Session-ID |

**Output:**

```json
{
  "session_id": "abc-123",
  "total_tokens_used": 15000,
  "total_tokens_without_index": 45000,
  "net_savings": 30000,
  "savings_percentage": 66.7,
  "tool_breakdown": [
    { "tool": "get_file_summary", "calls": 12, "tokens": 3600, "savings": 18000 }
  ]
}
```

---

### `start_comparison`

Startet eine gelabelte A/B-Session zum Vergleich von indexierter vs. Baseline Token-Nutzung.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `label` | string (min 1) | ✓ | — | Session-Label |
| `mode` | `"indexed"` \| `"baseline"` | ✓ | — | Tracking-Modus |

**Output:**

```json
{
  "session_id": "new-uuid",
  "mode": "indexed",
  "label": "Feature A — mit Index",
  "dashboard_url": "http://localhost:7843"
}
```

---

### `get_session_memory`

Passive Session-Beobachtungen abfragen — automatisch generiert durch Tool-Aufrufe und Datei-Änderungen.

**Input:**

| Parameter | Typ | Pflicht | Default | Beschreibung |
|---|---|---|---|---|
| `session_id` | string | | aktuelle Session | Filter nach Session |
| `file` | string | | — | Filter nach Dateipfad |
| `symbol` | string | | — | Filter nach Symbol-Name |
| `include_stale` | boolean | | false | Auch veraltete Beobachtungen einbinden |

**Output:**

```json
{
  "observations": [
    {
      "type": "file_explored",
      "file_path": "src/server.ts",
      "observation": "Datei 3x in dieser Session gelesen",
      "stale": false,
      "created_at": "2026-03-03T10:00:00Z"
    },
    {
      "type": "symbol_changed",
      "symbol_name": "createMcpServer",
      "observation": "Signatur geändert: neuer Parameter 'observer'",
      "stale": true,
      "stale_reason": "Symbol wurde nach Beobachtung erneut geändert"
    }
  ],
  "anti_patterns": [
    {
      "type": "file_thrashing",
      "description": "src/server.ts wurde 5x gelesen ohne Änderung"
    }
  ]
}
```

**Beobachtungstypen:**
- `file_explored` — Datei wurde gelesen/analysiert
- `symbol_changed` — AST-Diff hat Signatur-Änderung erkannt
- `anti_pattern` — AntiPatternDetector hat problematisches Verhalten erkannt

**Staleness:**
- Beobachtungen werden als `stale` markiert wenn das verlinkte Symbol sich seit der Beobachtung geändert hat
- `stale_reason` beschreibt den Grund
- Stale-Beobachtungen werden als Warnungen in `get_symbol` und `get_file_summary` ausgegeben

---

## PreToolUse-Hook (`pindex hook`)

`pindex` trägt in `.claude/settings.local.json` einen Claude-Code-`PreToolUse`-Hook (Matcher `Read`, `timeout: 5`) ein, der `pindex hook` mit dem Hook-JSON auf stdin aufruft.

**Verhalten:**
- Nur `Read` ohne `offset`/`limit` auf eine indexierte, seit dem Indexieren unveränderte Code-Datei (Hash-Vergleich) innerhalb des Projekt-Roots
- Ausgabe: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[PindeX] <rel> (<n> lines) symbols: name(kind)@start-end, …"}}` — max. 40 Symbole (`… +N more`), max. 4096 Zeichen, gefolgt von einem Hinweis auf `get_context`
- `PINDEX_HOOK_STRICT=1`: der erste solche Read pro Session und Datei wird mit `permissionDecision: "deny"` und der Outline als `permissionDecisionReason` abgelehnt; Zustand unter `~/.pindex/hook-state/` (nach 7 Tagen bereinigt)
- Keine Ausgabe (Read läuft unverändert) bei Dokumenten, nicht indexierten oder geänderten Dateien, Dateien ohne Symbole und bei jedem Fehler (fail open); Exit-Code immer 0
- Alte No-op-Hook-Einträge werden beim erneuten Aufruf von `pindex` ersetzt

---

## Baseline-Modus

Wenn `BASELINE_MODE=true` gesetzt ist, geben alle Query-Tools eine Fehlermeldung zurück statt realer Daten. Dies wird für A/B-Tests verwendet um die Token-Nutzung ohne Index zu messen.

**Betroffene Tools:** Alle außer `start_comparison` und `get_token_stats`.

**Fehler-Response:**

```json
{
  "content": [{ "type": "text", "text": "Baseline mode active — index disabled" }],
  "isError": true
}
```

---

## Federation

Bei aktiviertem `FEDERATION_REPOS` werden folgende Tools automatisch über alle verlinkten Repos ausgeführt:

| Tool | Verhalten bei Federation |
|---|---|
| `search_symbols` | Ergebnisse aus allen Repos, mit `project`-Feld |
| `get_project_overview` | Aggregierte Stats + Per-Repo-Breakdown |
| Alle anderen | Nur primäres Projekt |

Fehler in föderierten Repos werden geloggt aber beeinflussen nie die Haupt-Ergebnisse.
