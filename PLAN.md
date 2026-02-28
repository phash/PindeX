# PindeX UX-Redesign: Konzept & Implementierungsplan

## Ziel-UX

```bash
# 1. Einmalig installieren
npm install -g pindex

# 2. In jedem Projekt: einmalig aufrufen
cd /my/project-a
pindex
# → schreibt .mcp.json mit absoluten Pfaden
# → registriert Projekt global in ~/.pindex/registry.json
# → Claude Code findet es beim nächsten Start automatisch

# 3. GUI von überall starten
pindex-gui
# → Browser-Dashboard mit Stats aller bekannten Projekte

# 4. Mehrere Repos verbinden (Federation)
cd /my/project-a
pindex add /my/project-b
# → project-a sucht ab jetzt auch in project-b's Codebase
```

---

## Architektur-Konzept

### Warum Multi-Projekt von Haus aus funktioniert

MCP nutzt **stdio-Transport**: Claude Code spawnt `pindex-server` als Child-Prozess mit
den Env-Vars aus `.mcp.json`. Damit gilt:
- `.mcp.json` in `/project-a` → setzt `PROJECT_ROOT=/abs/path/project-a`
- `.mcp.json` in `/project-b` → setzt `PROJECT_ROOT=/abs/path/project-b`
- Jede Claude-Code-Session bekommt automatisch die richtige Codebase

Die Isolation ist durch das MCP-Protokoll gratis. `pindex` (no-args) muss nur `.mcp.json`
mit den richtigen absoluten Pfaden erzeugen.

### Globale State-Struktur

```
~/.pindex/
  registry.json          # alle registrierten Projekte + zugewiesene Ports
  config.json            # globale Defaults (Token-Preis, Sprachen etc.)
  projects/
    {8-char-hash}/
      index.db           # SQLite-DB für dieses Projekt
      meta.json          # Pfad, Name, letzter Index-Zeitpunkt
```

### Monitoring-Port-Strategie

Da `pindex-server` durch Claude Code on-demand gestartet wird (kein persistenter Daemon),
startet der Monitoring-HTTP-Server innerhalb dieses Prozesses. Damit kein Port-Konflikt
entsteht, bekommt jedes Projekt einen deterministischen Port:

```
PORT = 7842 + (parseInt(hash.slice(0, 4), 16) % 2000)  →  Bereich 7842–9842
```

Gespeichert in `registry.json`, damit der Wert stabil bleibt.

`pindex-gui` liest die SQLite-DBs **direkt** (kein HTTP-Roundtrip zu laufenden Servern
nötig) → funktioniert auch wenn kein Claude Code aktiv ist.

### `.mcp.json` Format (auto-generiert)

```json
{
  "mcpServers": {
    "pindex": {
      "command": "pindex-server",
      "args": [],
      "env": {
        "PROJECT_ROOT": "/absolute/path/to/project",
        "INDEX_PATH": "/home/user/.pindex/projects/{hash}/index.db",
        "MONITORING_PORT": "7843",
        "AUTO_REINDEX": "true",
        "GENERATE_SUMMARIES": "false",
        "MONITORING_AUTO_OPEN": "false",
        "BASELINE_MODE": "false",
        "TOKEN_PRICE_PER_MILLION": "3.00"
      }
    }
  }
}
```

### Federation-Konzept

```json
{
  "env": {
    "PROJECT_ROOT": "/abs/path/project-a",
    "INDEX_PATH": "~/.pindex/projects/{hash-a}/index.db",
    "FEDERATION_REPOS": "/abs/path/project-b:/abs/path/project-c",
    ...
  }
}
```

`pindex-server` lädt zusätzlich die DBs der federierten Repos (read-only).
`search_symbols` durchsucht alle DBs und prefixed Ergebnisse mit `[repo-name]`.
`get_project_overview` zeigt alle Repos inkl. Statistik.

---

## Implementierungsplan

### Phase 1 – Foundation: Pfade, Registry, Projekt-Erkennung

**`src/cli/project-detector.ts`** (Update)
- `getMcpIndexerHome()` → `getPindexHome()`, gibt `~/.pindex` zurück
- Rückwärtskompatibilität: Migration von `~/.mcp-indexer` falls vorhanden
- `findProjectRoot(startDir)` neu: läuft von cwd aufwärts, sucht `package.json`,
  `go.mod`, `Cargo.toml`, `pyproject.toml`, `.git` → gibt nächste Root zurück
- `RegistryEntry` Interface:
  ```ts
  { path: string; hash: string; name: string; monitoringPort: number;
    federatedRepos: string[]; addedAt: string; }
  ```
- `GlobalRegistry` Klasse:
  - `read()` → lädt `~/.pindex/registry.json`
  - `write(entries)` → speichert
  - `upsert(projectPath)` → fügt Projekt hinzu oder updatet, weist Port zu
  - `remove(projectPath)` → entfernt Eintrag
  - `list()` → alle Einträge
  - `assignPort(hash)` → deterministisch + stored in registry

**`src/cli/setup.ts`** (Update)
- Alle Pfade: `~/.mcp-indexer` → `~/.pindex`
- `registerMcpServer()`: verwendet neue Bin-Namen (`pindex-server`)
- Systemd-Service umbenennt: `pindex.service`

**`src/cli/daemon.ts`** (Update)
- PID-File pro Projekt: `~/.pindex/projects/{hash}/daemon.pid`
- Funktionen erhalten optionalen `projectHash`-Parameter

---

### Phase 2 – `pindex` Default-Command: Smart Init

**`src/cli/init.ts`** (Neu)
```ts
export async function initProject(cwd: string): Promise<void>
// 1. findProjectRoot(cwd)
// 2. hash = hashProjectPath(root)
// 3. registry.upsert(root) → bekommt zugewiesenen Port zurück
// 4. writeMcpJson(root, hash, port)
// 5. Ausgabe: "✓ pindex configured. Restart Claude Code to activate."

export function writeMcpJson(
  projectRoot: string, hash: string, port: number,
  federatedRepos?: string[]
): void
// schreibt/überschreibt .mcp.json im projectRoot

export async function addFederatedRepo(
  projectRoot: string, repoPath: string
): Promise<void>
// 1. resolve(repoPath) → absoluter Pfad
// 2. registry.upsert(repoPath)
// 3. bestehende federatedRepos aus registry lesen
// 4. writeMcpJson mit erweiterter FEDERATION_REPOS-Liste
// 5. Ausgabe: "✓ project-b linked. Restart Claude Code to activate."
```

**`src/cli/index.ts`** (Update)
- Default (kein command): `initProject(process.cwd())`
- Neuer command `add <path>`: `addFederatedRepo(cwd, args[0])`
- Alle Texte: `mcp-indexer` → `pindex`
- `uninstall`: Hinweis auf `~/.pindex`
- Updated help text

---

### Phase 3 – `pindex-gui`: Aggregiertes Dashboard

**`src/gui/index.ts`** (Neu)
- Entry Point für `pindex-gui`-Binary
- Liest `~/.pindex/registry.json`
- Startet aggregierten GUI-Server auf Port 7842 (konfigurierbar)
- Öffnet Browser

**`src/gui/server.ts`** (Neu)
- Express-App mit folgenden Routen:
  - `GET /` → Dashboard (HTML mit Chart.js, dark theme, analog zu bestehendem UI)
  - `GET /api/projects` → alle registrierten Projekte aus Registry
  - `GET /api/projects/:hash/stats` → liest SQLite-DB direkt, gibt Session-Stats zurück
  - `GET /api/projects/:hash/sessions` → Session-Liste
  - `GET /api/overview` → aggregierte Totals über alle Projekte
- Liest DBs direkt via `better-sqlite3` (kein HTTP-Call zu laufenden Servern)
- Funktioniert auch wenn kein pindex-server aktiv ist

**`package.json`** (Update)
- `"pindex-gui": "./dist/gui/index.js"` zu `bin` hinzufügen

---

### Phase 4 – Federation im MCP Server

**`src/index.ts`** (Update)
- `FEDERATION_REPOS`-Env lesen (`:` oder `,`-separierte Pfade)
- Pro Repo: DB öffnen via `getProjectIndexPath(repoPath)`
- `federatedDbs: Array<{ path: string; db: Database }>` an MCP-Server übergeben

**`src/server.ts`** (Update)
- `ServerOptions` erweitert: `federatedDbs?: Array<{ path: string; db: Database }>`
- Wird an betroffene Tools weitergegeben

**`src/tools/search-symbols.ts`** (Update)
- Wenn `federatedDbs` vorhanden: Suche in allen DBs
- Ergebnisse: `{ ...result, projectName: 'project-b' }` (kein Prefix nötig, eigenes Feld)

**`src/tools/get-project-overview.ts`** (Update)
- Zeigt Stats für primäres Projekt + alle federierten Projekte

---

## Datei-Übersicht: Was ändert sich

| Datei | Aktion | Beschreibung |
|---|---|---|
| `src/cli/project-detector.ts` | Update | `getPindexHome()`, `findProjectRoot()`, `GlobalRegistry` |
| `src/cli/setup.ts` | Update | Pfade, Bin-Namen, Systemd-Service-Name |
| `src/cli/daemon.ts` | Update | Per-Projekt-PID-Pfade |
| `src/cli/index.ts` | Update | Default=init, `add`-Command, neue Texte |
| `src/cli/init.ts` | Neu | `initProject()`, `writeMcpJson()`, `addFederatedRepo()` |
| `src/gui/index.ts` | Neu | pindex-gui Entry Point |
| `src/gui/server.ts` | Neu | Aggregierter Express-Server für alle Projekte |
| `src/index.ts` | Update | `FEDERATION_REPOS` lesen, federated DBs öffnen |
| `src/server.ts` | Update | `federatedDbs` Parameter |
| `src/tools/search-symbols.ts` | Update | Multi-DB-Suche |
| `src/tools/get-project-overview.ts` | Update | Federation-Stats |
| `package.json` | Update | `pindex-gui` in `bin` |

---

## Reihenfolge & Abhängigkeiten

```
Phase 1 (Foundation)
  └─→ Phase 2 (pindex init)   ← blockiert auf Phase 1
        └─→ Phase 3 (GUI)     ← blockiert auf Phase 1 (Registry)
Phase 4 (Federation)           ← unabhängig von Phase 3, blockiert auf Phase 1+2
```

Phases 1–3 können sequenziell implementiert werden.
Phase 4 ist ein separates Feature und kann danach kommen.

---

## Breaking Changes

- `~/.mcp-indexer/` → `~/.pindex/` (Migration wird automatisch durchgeführt wenn
  altes Verzeichnis existiert)
- `mcp-indexer`/`mcp-indexer-daemon`-Binaries entfallen (ersetzt durch `pindex`/`pindex-server`)
- Bestehende `.mcp.json`-Dateien in Projekten müssen neu generiert werden
  (`pindex` im jeweiligen Projektverzeichnis ausführen)

---

## Feature-Ideen (Backlog)

### Gesamt-Session-Token-Tracking

**Idee:** PindeX soll nicht nur die Tokens seiner eigenen Tool-Calls messen, sondern den
gesamten Token-Verbrauch einer Session — also auch `Write`, `Read`, `Bash`, `Edit` etc.

**Warum das aktuell nicht geht:**
Das MCP-Protokoll liefert dem Server nur Requests für seine eigenen registrierten Tools.
Was Claude Code mit anderen Tools macht (Read, Write, Bash …) ist für den MCP-Server
unsichtbar — es gibt keinen Session-Broadcast. Die Token-Zahlen der Anthropic-API
sind nur dem API-Caller (Claude Code) selbst bekannt.

**Mögliche Ansätze:**
- **Claude Code Hooks (`PreToolUse`):** Hooks sehen den Tool-Namen, aber keine Token-Counts.
  Damit könnte man zumindest die Anzahl der Nicht-PindeX-Calls zählen, nicht jedoch
  wie viele Tokens sie verbraucht haben.
- **Lokaler API-Proxy** (zwischen Claude Code und `api.anthropic.com`): Würde alle
  Anfragen inkl. Token-Usage sehen, erfordert aber TLS-Interception und ist erheblich
  aufwändiger als ein MCP-Server.
- **MCP-Protokoll-Erweiterung:** Wenn Claude Code in Zukunft Session-Metriken per MCP
  exposed (z.B. via `_meta`-Feld in Tool-Requests), könnte PindeX diese auslesen.

**Status:** Wartet auf Protokoll-/Client-seitige Unterstützung. Kein akuter Handlungsbedarf.
