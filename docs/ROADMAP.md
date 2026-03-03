# PindeX Roadmap

Stand: 2026-03-03 (nach v1.3.0 — P0–P3 abgeschlossen)

---

## ~~P0 — Windows Path Normalization~~ ✅

Erledigt in v1.2.3. Alle gespeicherten Pfade werden auf Forward-Slashes normalisiert (POSIX-Konvention). `deleteFile()` ebenfalls gefixt.

---

## ~~P1 — Runtime Input Validation für MCP Tools~~ ✅

Erledigt. Zod-Schemas für alle 14 Tool-Inputs in `src/tools/schemas.ts`. Validierung vor dem Dispatch in `src/server.ts` mit strukturierter MCP-Error-Response bei Fehlern.

- [x] Zod-Schemas für alle 14 Tool-Inputs definieren
- [x] Validierung vor dem Cast, mit strukturierter MCP-Error-Response bei Fehlern
- [ ] Optional: Input-Schemas auch für MCP `listTools` exportieren (Client-seitige Validierung)

---

## ~~P2 — Test Coverage ausbauen~~ ✅

Erledigt. 3 neue Test-Dateien, 36 neue Tests. Coverage-Threshold (80%) war bereits vorher nicht erreicht — liegt an unkritischen Modulen (monitoring, cli).

- [x] Test für `initProject()` / `writeMcpJson()` (Kernfunktionalität) → `tests/cli/init.test.ts` (22 Tests)
- [x] Test für `get_api_endpoints` Tool → `tests/tools/get_api_endpoints.test.ts` (6 Tests)
- [x] Integration-Test für GUI-Server (supertest) → `tests/gui/server.test.ts` (8 Tests)
- [ ] Coverage-Threshold von 80% soll wieder eingehalten werden (aktuell ~64%)

---

## ~~P2 — DevDependency-Upgrade (esbuild CVE)~~ ✅

Erledigt. Vitest v1.6.1 → v4.0.18. 0 Vulnerabilities. `pool: 'forks'` funktioniert identisch in v4.

- [x] Vitest auf v4.x upgraden
- [x] Breaking Changes in Vitest v4 prüfen (Test-Config, Pool-Setting) — keine nötig
- [x] Nur devDependency — keine Auswirkung auf Produktion

---

## ~~P3 — Silent Error Handling verbessern~~ ✅

Erledigt. 9 catch-Blöcke in 4 Dateien mit `process.stderr.write('[pindex] ...')` Logging versehen. Bewusst stille Blöcke (best-effort snippet reads, package.json version fallback) beibehalten.

- [x] `src/db/queries.ts` — 3 FTS5-Suchfehler loggen
- [x] `src/gui/server.ts` — 4 DB-Fehler loggen (project stats, detail, sessions, recent)
- [x] `src/tools/search_symbols.ts:62` — Federated-Search-Fehler loggen
- [x] `src/indexer/parser.ts` — Parse-Fehler mit Dateipfad loggen

---

## ~~P3 — LLM Summarizer implementieren (Feature)~~ ✅

Erledigt. `src/indexer/summarizer.ts` komplett implementiert mit OpenAI-kompatibler API (`/v1/chat/completions`). Funktioniert mit OpenAI, Ollama, LiteLLM, Anthropic-Proxy etc.

- [x] Provider-Abstraktion (OpenAI-kompatible API via native `fetch()`)
- [x] API-Key-Handling über Env-Vars (`SUMMARIZER_API_KEY`, `SUMMARIZER_BASE_URL`, `SUMMARIZER_MODEL`)
- [x] Rate-Limiting (Semaphore mit konfigurierbarer `maxConcurrency`, default: 3)
- [x] Caching (DB `summary`-Spalte = Cache, nur bei Hash-Änderung neu generiert)
- [x] Startup-Warnung wenn `GENERATE_SUMMARIES=true` ohne API-Key

---

## Backlog — Nice to Have

### Multi-Language Parser Improvements
- [ ] Python: Dekoratoren als Symbol-Metadata extrahieren
- [ ] Java/Kotlin: Annotation-basierte Route-Erkennung (Spring `@GetMapping` etc.)
- [ ] Go: Interface-Implementierung erkennen
- [ ] Rust: Trait-Implementierungen tracken

### Performance
- [ ] Prepared Statement Caching (aktuell wird `db.prepare()` bei jedem Aufruf neu erstellt)
- [ ] Incremental FTS5 rebuild statt full rebuild bei Schema-Migration
- [ ] Paralleles Parsing mit Worker Threads für große Codebasen (>1000 Dateien)

### DX / Usability
- [ ] `pindex doctor` Command — Diagnose-Tool (DB-Integrität, Index-Freshness, Konfiguration)
- [ ] `pindex watch` als eigenständiger Daemon (aktuell nur in-process)
- [ ] Auto-Erkennung von monorepo sub-packages
- [ ] Besseres Feedback bei `pindex init` (welche Dateien werden indexiert, geschätzte Dauer)

### GUI Dashboard
- [ ] Token-Savings-Graph über mehrere Sessions
- [ ] Symbol-Browser (click-through von File → Symbols → Usages)
- [ ] Live-WebSocket-Updates während Indexierung
- [ ] Export als JSON/CSV für Reporting

### Test & Qualität
- [ ] Coverage-Threshold 80% erreichen (monitoring/server.ts, cli/ abdecken)
- [ ] MCP `listTools` Input-Schemas aus Zod generieren (Client-seitige Validierung)
