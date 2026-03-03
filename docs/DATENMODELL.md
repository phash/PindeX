# PindeX – Datenmodell

Stand: 2026-03-03 (Schema-Version 5)

---

## Übersicht

PindeX speichert alle Index-Daten in einer einzelnen **SQLite-Datenbank** pro Projekt unter `~/.pindex/projects/{hash}/index.db`. Die Datenbank nutzt `better-sqlite3` (synchrone native Bindings) und **FTS5** (Full-Text Search) für Volltextsuche über Symbole, Dokumente und Kontext-Einträge.

```
┌─────────────────────────────────────────────────────────────┐
│                        SQLite DB                            │
│                                                             │
│  ┌─────────┐   1:N   ┌──────────┐   1:N   ┌────────────┐  │
│  │  files   │────────►│ symbols  │────────►│  usages    │  │
│  └─────────┘         └──────────┘         └────────────┘  │
│       │                    │                               │
│       │ 1:N               FTS5                             │
│       ▼                    ▼                               │
│  ┌───────────┐      ┌──────────────┐                      │
│  │dependencies│      │ symbols_fts  │                      │
│  └───────────┘      └──────────────┘                      │
│       │                                                    │
│       │ 1:N                                                │
│       ▼                                                    │
│  ┌──────────┐       ┌──────────────┐                      │
│  │ documents │──FTS5─►│documents_fts │                      │
│  └──────────┘       └──────────────┘                      │
│                                                             │
│  ┌────────────────┐  ┌──────────────────────┐              │
│  │ context_entries │──►│context_entries_fts   │              │
│  └────────────────┘  └──────────────────────┘              │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐     │
│  │ sessions │  │token_log │  │ ast_snapshots         │     │
│  └──────────┘  └──────────┘  │ session_observations  │     │
│                               │ session_events        │     │
│                               └──────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

---

## Tabellen

### `files`

Zentrale Tabelle — jede indexierte Datei (Code + Dokumente) wird hier registriert. Dient als Ankerpunkt für alle anderen Tabellen via Foreign Key.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Auto-Increment |
| `path` | TEXT UNIQUE NOT NULL | Projekt-relativer Pfad (immer Forward-Slashes) |
| `language` | TEXT NOT NULL | Erkannte Sprache (`typescript`, `javascript`, `markdown`, etc.) |
| `summary` | TEXT | LLM-generierte Zusammenfassung (null wenn deaktiviert) |
| `last_indexed` | DATETIME | Zeitstempel der letzten Indexierung |
| `hash` | TEXT | MD5-Hash des Datei-Inhalts (für inkrementelles Reindexing) |
| `raw_token_estimate` | INTEGER | Geschätzte Token-Anzahl des Roh-Inhalts |

**Inkrementelles Reindexing:** Beim Indexieren wird der MD5-Hash verglichen. Nur bei Änderung werden Symbole/Chunks neu geschrieben.

---

### `symbols`

Alle aus dem AST extrahierten Code-Symbole (Funktionen, Klassen, Interfaces, Typen, Routen, etc.).

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Auto-Increment |
| `file_id` | INTEGER NOT NULL | FK → `files(id)`, CASCADE DELETE |
| `name` | TEXT NOT NULL | Symbol-Name (z.B. `createMcpServer`) |
| `kind` | TEXT NOT NULL | Symbol-Typ (`function`, `class`, `interface`, `type`, `route`, etc.) |
| `signature` | TEXT NOT NULL | Vollständige Signatur (z.B. `export function createMcpServer(db: Database, ...): Server`) |
| `summary` | TEXT | LLM-generierte Zusammenfassung |
| `start_line` | INTEGER | Erste Zeile der Definition |
| `end_line` | INTEGER | Letzte Zeile der Definition |
| `is_exported` | INTEGER DEFAULT 0 | 1 = exportiert |
| `is_async` | INTEGER DEFAULT 0 | 1 = async Funktion (seit Schema v4) |
| `has_try_catch` | INTEGER DEFAULT 0 | 1 = enthält try/catch (seit Schema v4) |

**Indexe:**
- `idx_symbols_file_id` — schneller Join mit `files`
- `idx_symbols_name` — schnelle Namens-Lookups

---

### `dependencies`

Import-Graph: welche Datei importiert welche andere Datei und welches Symbol.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Auto-Increment |
| `from_file` | INTEGER NOT NULL | FK → `files(id)`, CASCADE DELETE |
| `to_file` | INTEGER NOT NULL | FK → `files(id)`, CASCADE DELETE |
| `symbol_name` | TEXT | Importiertes Symbol (null = ganzes Modul) |

**Indexe:**
- `idx_dependencies_from` — alle Imports einer Datei
- `idx_dependencies_to` — alle Importierer einer Datei
- `idx_dependencies_unique` — UNIQUE(from_file, to_file, symbol_name) — verhindert Duplikate

---

### `usages`

Verwendungsorte eines Symbols in der Codebase.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Auto-Increment |
| `symbol_id` | INTEGER NOT NULL | FK → `symbols(id)`, CASCADE DELETE |
| `used_in_file` | INTEGER NOT NULL | FK → `files(id)`, CASCADE DELETE |
| `used_at_line` | INTEGER | Zeilennummer der Verwendung |

**Indexe:**
- `idx_usages_symbol` — alle Verwendungen eines Symbols
- `idx_usages_used_in_file` — alle Symbole die in einer Datei verwendet werden
- `idx_usages_unique` — UNIQUE(symbol_id, used_in_file, used_at_line)

---

### `documents`

Text-Chunks aus Nicht-Code-Dateien (Markdown, YAML, TXT). Jede Datei wird in Abschnitte zerlegt.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Auto-Increment |
| `file_id` | INTEGER NOT NULL | FK → `files(id)`, CASCADE DELETE |
| `chunk_index` | INTEGER NOT NULL | 0-basierter Index des Abschnitts |
| `heading` | TEXT | Überschrift des Abschnitts (bei Markdown) |
| `start_line` | INTEGER NOT NULL | Erste Zeile des Chunks |
| `end_line` | INTEGER NOT NULL | Letzte Zeile des Chunks |
| `content` | TEXT NOT NULL | Vollständiger Text des Abschnitts |
| `summary` | TEXT | LLM-generierte Zusammenfassung |

**Chunking-Strategie:**
- **Markdown** (`.md`, `.markdown`): Aufteilung an `#`/`##`/`###` Überschriften — jeder Abschnitt = ein Chunk
- **YAML/TXT** (`.yaml`, `.yml`, `.txt`): Feste 50-Zeilen-Fenster

**Index:** `idx_documents_file_id`

---

### `context_entries`

Manuell gespeicherte Fakten/Entscheidungen (via `save_context` Tool). Persistieren über Sessions hinweg.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Auto-Increment |
| `session_id` | TEXT NOT NULL | Session in der der Eintrag erstellt wurde |
| `content` | TEXT NOT NULL | Gespeicherter Text |
| `tags` | TEXT | Komma-separierte Tags für besseres Retrieval |
| `created_at` | DATETIME | Zeitstempel (DEFAULT CURRENT_TIMESTAMP) |

**Index:** `idx_context_entries_session`

---

### `sessions`

Registrierte Sessions für Token-Tracking und A/B-Vergleiche.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | TEXT PK | UUID der Session |
| `started_at` | DATETIME | Start-Zeitpunkt (DEFAULT CURRENT_TIMESTAMP) |
| `mode` | TEXT NOT NULL | `'indexed'` oder `'baseline'` |
| `label` | TEXT | Optionales Label für A/B-Tests |
| `total_tokens` | INTEGER DEFAULT 0 | Kumulierte Token-Nutzung |
| `total_savings` | INTEGER DEFAULT 0 | Kumulierte Token-Einsparung |

---

### `token_log`

Detailliertes Log jedes MCP-Tool-Aufrufs für Token-Tracking.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Auto-Increment |
| `timestamp` | DATETIME | Zeitpunkt des Aufrufs (DEFAULT CURRENT_TIMESTAMP) |
| `session_id` | TEXT | FK → `sessions(id)` (logisch, kein DB-Constraint) |
| `tool_name` | TEXT NOT NULL | Name des aufgerufenen Tools |
| `tokens_used` | INTEGER NOT NULL | Geschätzte Token des Tool-Outputs |
| `tokens_without_index` | INTEGER NOT NULL | Geschätzte Token ohne Index (Heuristik) |
| `files_touched` | TEXT | Betroffene Dateien (JSON-Array als Text) |
| `query` | TEXT | Ursprüngliche Anfrage |

**Index:** `idx_token_log_session`

---

### `ast_snapshots`

Letzte bekannte Signatur jedes Symbols — Basis für den AST-Diff-Algorithmus.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Auto-Increment |
| `file_path` | TEXT NOT NULL | Projekt-relativer Dateipfad |
| `symbol_name` | TEXT NOT NULL | Symbol-Name |
| `kind` | TEXT NOT NULL | Symbol-Typ |
| `signature` | TEXT NOT NULL | Vollständige Signatur |
| `signature_hash` | TEXT NOT NULL | Hash der Signatur (für schnellen Vergleich) |
| `captured_at` | DATETIME | Zeitstempel (DEFAULT CURRENT_TIMESTAMP) |

**Constraint:** UNIQUE(file_path, symbol_name)
**Index:** `idx_ast_snapshots_file`

---

### `session_observations`

Passiv generierte Beobachtungen der `SessionObserver`-Komponente. Wird automatisch durch Tool-Aufrufe und Datei-Änderungen befüllt.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Auto-Increment |
| `session_id` | TEXT NOT NULL | Zugehörige Session |
| `type` | TEXT NOT NULL | Beobachtungstyp (z.B. `file_explored`, `symbol_changed`, `anti_pattern`) |
| `file_path` | TEXT | Betroffene Datei (optional) |
| `symbol_name` | TEXT | Betroffenes Symbol (optional) |
| `observation` | TEXT NOT NULL | Beschreibung der Beobachtung |
| `stale` | INTEGER DEFAULT 0 | 1 = veraltet (Symbol hat sich seit Beobachtung geändert) |
| `stale_reason` | TEXT | Grund der Veraltung |
| `created_at` | DATETIME | Zeitstempel (DEFAULT CURRENT_TIMESTAMP) |

**Indexe:**
- `idx_session_observations_session`
- `idx_session_observations_file`

**Retention:** Konfigurierbar via `OBSERVATION_RETENTION` Env-Var (`permanent`, `session`, `Nd`)

---

### `session_events`

Low-Level Event-Log für Anti-Pattern-Erkennung und Analyse.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Auto-Increment |
| `session_id` | TEXT NOT NULL | Zugehörige Session |
| `event_type` | TEXT NOT NULL | Event-Typ (z.B. `tool_call`, `file_change`, `search`) |
| `file_path` | TEXT | Betroffene Datei (optional) |
| `symbol_name` | TEXT | Betroffenes Symbol (optional) |
| `extra_json` | TEXT | Zusätzliche Daten als JSON-String |
| `timestamp` | DATETIME | Zeitstempel (DEFAULT CURRENT_TIMESTAMP) |

**Indexe:**
- `idx_session_events_session`
- `idx_session_events_file_time` — für zeitbasierte Abfragen pro Datei
- `idx_session_events_type_session` — für Event-Typ-Filterung

---

## FTS5 Virtuelle Tabellen

PindeX nutzt drei FTS5-Tabellen für Volltextsuche. Alle werden über **SQLite-Trigger** automatisch synchron gehalten.

### `symbols_fts`

```sql
CREATE VIRTUAL TABLE symbols_fts
USING fts5(name, summary, signature, content=symbols, content_rowid=id);
```

Indiziert `name`, `summary` und `signature` der `symbols`-Tabelle. Wird von `search_symbols` verwendet.

### `documents_fts`

```sql
CREATE VIRTUAL TABLE documents_fts
USING fts5(content, heading, summary, content=documents, content_rowid=id);
```

Indiziert `content`, `heading` und `summary` der `documents`-Tabelle. Wird von `search_docs` verwendet.

### `context_entries_fts`

```sql
CREATE VIRTUAL TABLE context_entries_fts
USING fts5(content, tags, content=context_entries, content_rowid=id);
```

Indiziert `content` und `tags` der `context_entries`-Tabelle. Wird von `search_docs` verwendet.

---

## Trigger (FTS5-Synchronisation)

Für jede der drei FTS5-Tabellen existieren drei Trigger:

| Trigger | Event | Wirkung |
|---|---|---|
| `symbols_ai` | AFTER INSERT ON symbols | Neuen Eintrag in `symbols_fts` |
| `symbols_ad` | AFTER DELETE ON symbols | Eintrag aus `symbols_fts` entfernen |
| `symbols_au` | AFTER UPDATE ON symbols | Alten Eintrag löschen, neuen einfügen |
| `documents_ai` | AFTER INSERT ON documents | Neuen Eintrag in `documents_fts` |
| `documents_ad` | AFTER DELETE ON documents | Eintrag aus `documents_fts` entfernen |
| `documents_au` | AFTER UPDATE ON documents | Alten Eintrag löschen, neuen einfügen |
| `context_entries_ai` | AFTER INSERT ON context_entries | Neuen Eintrag in `context_entries_fts` |
| `context_entries_ad` | AFTER DELETE ON context_entries | Eintrag aus `context_entries_fts` entfernen |
| `context_entries_au` | AFTER UPDATE ON context_entries | Alten Eintrag löschen, neuen einfügen |

**Hinweis:** FTS5 kennt kein echtes UPDATE — der Update-Trigger löscht den alten Eintrag und fügt den neuen ein. `COALESCE(..., '')` verhindert NULL-Werte in FTS5-Spalten.

---

## Indexe (Übersicht)

| Index | Tabelle | Spalte(n) | Typ |
|---|---|---|---|
| `idx_symbols_file_id` | symbols | file_id | Normal |
| `idx_symbols_name` | symbols | name | Normal |
| `idx_dependencies_from` | dependencies | from_file | Normal |
| `idx_dependencies_to` | dependencies | to_file | Normal |
| `idx_dependencies_unique` | dependencies | from_file, to_file, symbol_name | UNIQUE |
| `idx_usages_symbol` | usages | symbol_id | Normal |
| `idx_usages_used_in_file` | usages | used_in_file | Normal |
| `idx_usages_unique` | usages | symbol_id, used_in_file, used_at_line | UNIQUE |
| `idx_token_log_session` | token_log | session_id | Normal |
| `idx_documents_file_id` | documents | file_id | Normal |
| `idx_context_entries_session` | context_entries | session_id | Normal |
| `idx_ast_snapshots_file` | ast_snapshots | file_path | Normal |
| `idx_session_observations_session` | session_observations | session_id | Normal |
| `idx_session_observations_file` | session_observations | file_path | Normal |
| `idx_session_events_session` | session_events | session_id | Normal |
| `idx_session_events_file_time` | session_events | file_path, timestamp | Normal |
| `idx_session_events_type_session` | session_events | event_type, session_id | Normal |

---

## Schema-Migration

PindeX verwendet **`PRAGMA user_version`** für Schema-Versionierung. Migrationen werden sequentiell beim Start ausgeführt (`src/db/migrations.ts`).

| Version | Änderungen |
|---|---|
| 1 | Initiales Schema: `files`, `symbols`, `dependencies`, `usages`, `token_log`, `sessions`, `symbols_fts` |
| 2 | Dokument-Indexierung: `documents`, `context_entries`, `documents_fts`, `context_entries_fts` |
| 3 | Session Memory: `ast_snapshots`, `session_observations`, `session_events` |
| 4 | AST-Flags: `is_async` und `has_try_catch` Spalten auf `symbols` |
| 5 | Performance: UNIQUE-Constraints auf `dependencies` und `usages`, zusätzliche Indexe |

**Migrationsstrategie:**
- Migrationen sind additiv (kein Datenverlust)
- `initSchema()` nutzt `IF NOT EXISTS` — sicher für wiederholte Aufrufe
- Bei neuen Spalten: `ALTER TABLE ... ADD COLUMN` (SQLite unterstützt kein `IF NOT EXISTS` für Spalten — daher explizite Versionsprüfung)
- Migration läuft synchron beim Serverstart

---

## Relationen (ER-Diagramm)

```
files ──< symbols ──< usages
  │           │
  │           └──── symbols_fts (FTS5, trigger-sync)
  │
  ├──< dependencies (from_file → files, to_file → files)
  │
  ├──< documents ──── documents_fts (FTS5, trigger-sync)
  │
  └──< token_log (logisch via session_id → sessions)

sessions ──< token_log
         ──< session_observations
         ──< session_events

context_entries ──── context_entries_fts (FTS5, trigger-sync)

ast_snapshots (standalone, UNIQUE(file_path, symbol_name))
```

**CASCADE DELETE:** Alle FK-Beziehungen nutzen `ON DELETE CASCADE`. Wird eine Datei aus `files` gelöscht, werden automatisch alle zugehörigen `symbols`, `dependencies`, `usages` und `documents` entfernt.
