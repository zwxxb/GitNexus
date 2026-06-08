# Move on GitNexus v1.6.6 — adaptability audit

**Date:** 2026-06-08 · **Base:** `upstream/main` v1.6.6 (`2cf7e7fa`) · **Fork ref:** `integrate/upstream-2026-06`

Outcome of re-porting Move/Aptos support onto a fresh v1.6.6 base as a **thin
move-flow consumer** (zero raw-source scanning). Per subsystem: what survived,
what was deleted, and the Phase-0 fidelity (now full, because the `facts` query
is live).

## Schema tier (`gitnexus-shared`)
- Added `Move` language enum, `.move` detection (`rust` highlighter), and the
  `Move` language classification (`experimental`).
- Added `EnumVariant` node label/table and `FRIEND_OF` / `READS_RESOURCE` /
  `WRITES_RESOURCE` / `ACQUIRES` / `EMITS` relationship types.
- Added optional Move node-property fields + `locationFidelity`.
- **Preserved upstream-only work:** Blade detection, `scopeResolution` phase,
  Vue `BINDS_EVENT_HANDLER`/`EMITS_EVENT`, `GraphRelationship.evidence`,
  `Variable` table, `OVERRIDES`.

## Move core (`gitnexus/src/core/move/`)
- **Kept & adapted:** `mcp-client` (added `facts()` + capability probe; inverted
  the `MoveFlowClient` dependency so the client owns its contract),
  `compiler-facts` (added full `MoveFactsMap` types), `signature-parser`,
  `symbol-id`, `graph-writer`, `move-toml`, `entry-points`, `consistency`.
- **Rewritten thin:** `move-ingest` — was 870 lines of source scanning; now a
  compiler-first phase that reads `facts` (or `module_summary` fallback) and
  delegates mapping to the new `facts-mapper`. `MoveIngestOutput` dropped the
  `sourceIndex` field (deleted module).
- **New:** `facts-mapper` (facts → `GraphNode`/`GraphRelationship`).
- **Deleted, not ported:** `attribute-scanner`, `enum-variants`, `resource-ops`,
  `friend-resolver`, `source-store`, `source-utils`, `source-index`,
  `language-provider` (Move), `type-extractor`, `type-visibility`,
  `named-bindings`, `import-resolver`.

## Pipeline / RING4
- Registered `moveIngest` after `structure`; `parse` excludes ingested `.move`.
- RING4: `import-processor.ts` is **absent upstream** (fork's only edit there was
  dropped). `resolve.ts` MRO perf edit was non-Move and superseded — skipped.
- Exhaustiveness fallout from the new enum handled via a no-op `moveProvider`
  stub (Move has no tree-sitter provider, like COBOL) plus `EnumVariant`
  entries in `registration-table` and `tree-sitter-queries`.

## Persistence (lbug)
- `Function`/`Struct`/`Enum`/`Const`/`Module` schemas augmented with Move
  columns; new `EnumVariant` table. `csv-generator` + `lbug-adapter` COPY kept in
  lockstep. STRING[] columns emit bare list elements (Kùzu list-CSV convention).
- Validated by a live `analyze` on the `coin` fixture: resources, resource
  edges, entry/view flags, and arrays persist and query correctly.

## Scoring / search
- Move entry/framework scoring is **auto-satisfied** — v1.6.6 derives these from
  `provider.entryPointPatterns` / `astFrameworkPatterns`, both `[]` on the Move
  stub provider.
- `Struct` + `Module` added to the FTS index set.

## Dependencies
- The optional `tree-sitter-move-on-aptos` grammar and its postinstall patch are
  **omitted** — the compiler-first design has no grammar dependency.

## Fidelity
With the `facts` query live, Phase-0 graphs are **full fidelity**: precise
file/span, resource reads/writes, friends, enum variants, attributes, acquires.
The `module_summary` fallback (coarse, package-root locations, no
resource/friend/enum facts) only engages if a move-flow build lacks `facts`.
