# Task 5 report: get_call_path

Implemented src/tools/get_call_path.ts, shortestPath (BFS, cycle-safe, maxDepth, module-level edges skipped) in src/graph/call-graph.ts, schema (max_depth int 1..12), types, TOOL_DEFINITIONS + dispatch (heuristicMultiplier 15) + CORE_TOOL_NAMES, docs (CLAUDE.md count 16 + table + section, README, CLAUDE_MD_SECTION in init.ts). Reused fileKeyFor from find_usages.ts (now exported); a from_file/to_file escaping the root yields not_found for that side.

## TDD
RED: `npx vitest run tests/graph tests/tools/get_call_path.test.ts tests/tools/validation.test.ts tests/server.test.ts` -> 4 files failed, 8 tests failed: shortestPath not a function (4), GetCallPathSchema undefined (2), TOOL_SCHEMAS/tools list lacking get_call_path (2), get_call_path module not found.
GREEN: same command -> 4 files, 119 tests passed. Full: npm test 54 files / 900 tests passed; npm run lint and npm run build clean.

Tests cover: 2-hop chain order+file+line, cycle with unreachable target (terminates), max_depth 1 vs 2, module-level start ignored, ambiguous from, from_file disambiguation, not_found to, root-escape from_file, validation (13, 0, missing to), server compact-JSON loop and tool list (16).

## Notes
- Docs/DATENMODELL.md untouched (no schema change in this task).
- Not committed yet at time of writing; see commit below.
