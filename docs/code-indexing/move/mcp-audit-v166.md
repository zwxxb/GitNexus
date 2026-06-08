# Move MCP surface on v1.6.6 — completeness & correctness audit

**Date:** 2026-06-08

Move MCP tools were **grafted onto** upstream v1.6.6's evolved
`mcp/local/local-backend.ts`, never replacing it — so they inherit upstream's
backend fixes.

## Tools added
| tool | reads | notes |
|------|-------|-------|
| `move_entries` | `Function` node props | entry/view/init_module/inline/native; filters by module/attribute/hasSpec/test-only |
| `move_resources` | `Struct` (isResource) + `READS_RESOURCE`/`WRITES_RESOURCE`/`ACQUIRES` edges | lists resources + accessors |
| `move_impact` | reuses generic `impact` BFS | restricted to `CALLS`/`READS_RESOURCE`/`WRITES_RESOURCE`/`ACQUIRES` |

All three are **read-only**, **parameterized-Cypher / graph-property only** — no
move-flow shell-out, no deleted source-scan modules. `DEFAULT_IMPACT_RELATION_TYPES`
(generic impact) was extended with `ACQUIRES`/`READS_RESOURCE`/`WRITES_RESOURCE`
(no-ops on non-Move graphs).

## Upstream backend fixes gained by grafting (not forked)
- #1655 read-only Cypher enforcement (`isReadOnlyDbError`)
- #1402 WAL-corruption recovery suggestion
- #2067 sibling-clone repo-ID collisions + generated tool-name fix
- #1818 pagination, #1907 disambiguation, #1867 processes
- stdout sentinel (`installGlobalStdoutSentinel`) — upstream's version kept; the
  fork's `_safeStdout` Proxy was **not** re-ported.

## Honesty / correctness
- Capability probe detects `facts` via the query-enum schema; degrades cleanly to
  `module_summary` (coarse) and never to raw-source scanning.
- With `facts` live, MCP responses reflect full fidelity (resource/friend/enum/
  attribute facts, precise locations).

## Not yet ported (follow-up)
- `resources.ts` Move/understand resource URIs (`move/{entries,coverage,
  verification}`, `understand/*`) depend on the Understand-* subsystem + quality
  phase, which are deferred. The equivalent data is already available via the
  `move_entries` / `move_resources` / `move_impact` tools and `cypher`.
