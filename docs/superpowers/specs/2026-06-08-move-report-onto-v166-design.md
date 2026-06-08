# Move/Aptos code intelligence on GitNexus v1.6.6 — architecture & re-port

**Date:** 2026-06-08
**Author:** repository maintainers (zwxxb fork, Aptos Labs)
**Status:** design — pending implementation plan (Phase 0)

## Problem

`gitnexus-aptos` is a Move/Aptos-aware fork of GitNexus. It diverged from upstream
`abhigyanpatwari/GitNexus` at `baf3f9e3` (2026-04-14, ~v1.6.1); upstream has since advanced
**561 commits to v1.6.6** (`upstream/main` @ `2cf7e7fa`). Two problems must be solved together:

1. **Staleness.** The fork is 561 commits behind, including refactors (RING4) and fixes
   (~25 in `mcp/local/local-backend.ts` alone) that the fork's stale copies would forfeit.
2. **Architecture.** The fork is "compiler-first for *structure*, regex/tree-sitter for
   *semantics*." The semantic layer is fragile and bug-ridden by the fork's own
   `docs/code-indexing/move/known-limitations.md` (D-SCAN-3/4/6 P0 bugs; D-PARSE-1 tree-sitter
   ABI crash requiring a pinned grammar commit). move-flow — the Aptos Move compiler exposed
   over MCP — is the natural source of truth but is currently underused.

## Evidence (live move-flow calls, 2026-06-08)

move-flow `move_package_query module_summary` on the `coin` fixture **serializes structurally**:
struct `abilities` (array), struct `fields` (`"name: type"` strings), constants (name/type/value),
and per-function a **compiler-normalized signature string**
(`"public entry fun register<CoinType>(account: &signer)"`). `call_graph`, `function_usage`,
and `manifest` are likewise structured.

It does **not** serialize: `#[view]`/event/test **attributes**, **acquires**, **friend**
edges, **resource read/write** (`function_usage` on `coin::transfer` returned all-empty —
`borrow_global`/`move_to` are invisible), **enum variants** (the `enums` fixture's `Shape`
enum returns as a *struct* with a flattened, colliding field list `"0: u64"`×3 — variant
structure lost), and **spec** presence.

**Conclusion:** parsing a *compiler-normalized signature string* is robust and acceptable;
scanning *raw Move source* (the current attribute-scanner/tree-sitter/regex layer) is the
fragile part. The five missing fact families are exactly what that fragile layer recovers.
The clean solution is to make move-flow emit them, and delete the raw-source layer.

## Goal

Land Move/Aptos support on v1.6.6 as a **thin consumer of move-flow**, with move-flow as the
single source of truth, plus an AI layer (semantic search, LLM enrichment, agent-native
tooling, verification-awareness) serving two consumers: **AI agents over MCP** and
**CI/governance gates**. Org-wide, easy to adopt, deterministic.

## Principles

- **move-flow is the oracle.** GitNexus performs **zero parsing of raw Move source**. Facts
  come from move-flow MCP. Parsing the compiler's *normalized signature string* is allowed;
  scanning source files is not.
- **Avoid tree-sitter for Move.** Drop the optional `tree-sitter-move-on-aptos` grammar and
  the source attribute-scanner. Compiler facts replace them.
- **Graft, don't replace.** Move tools graft onto upstream's evolved `local-backend.ts`;
  never carry the fork's stale copy.
- **Agent-native.** Tools are atomic primitives; outcomes live in prompts/skills. One coherent
  Move surface spanning index-derived facts and live move-flow (compile/test/verify/replay).
- **Deterministic & verifiable.** Compiler-sourced facts make the graph trustworthy for
  governance gates.
- **Capability-gated degradation.** GitNexus probes move-flow's capabilities; uses the rich
  `facts` query when present, falls back to signature-only parsing otherwise — never to raw-source scanning.

## Target architecture

```
move-flow MCP (SOURCE OF TRUTH, Rust)
  today:   module_summary · call_graph · function_usage · manifest · status
           · coverage · verify · wp · replay_transaction
  PROPOSE: `facts` query → structured per-module facts (see spec below)
        │  (structured facts; GitNexus does no source parsing)
        ▼
GitNexus Move ingestion (THIN consumer)
  facts → graph: Module/Function/Struct/Enum/EnumVariant/Const nodes;
  CALLS/FRIEND_OF/READS_RESOURCE/WRITES_RESOURCE/ENTRY_POINT_OF edges.
  DELETE attribute-scanner, tree-sitter glue, enum-variants/resource-ops/
  friend-resolver regex. ~25 core/move modules collapse to ~8.
        ▼
AI layer
  • Semantic search — Move-aware embeddings on upstream's native structural
    chunking; group/cross-repo over all org Move packages.
  • LLM enrichment — agent-driven module/fn summaries + resource/security
    annotations into the graph + wiki.
  • Agent-native tools — ONE Move surface: index facts (move_entries,
    move_resources, move_impact, semantic query) + live move-flow passthrough
    (status, test, coverage, verify, replay).
  • Verification-aware — verify + coverage as first-class node properties.
        ▼
Consumers:  AI agents (MCP)  ·  CI/governance gates
```

## move-flow `facts` query — proposed MCP spec (Phase 1 deliverable)

A new `QueryType` on `move_package_query` (or a dedicated `move_package_facts` tool) returning,
per fully-qualified module, structured facts the compiler already holds. Provenance notes name
the compiler surface that supplies each field.

```jsonc
// move_package_query { package_path, query: "facts" } →
{
  "0xa::coin": {
    "file": "sources/coin.move",                      // module source location (compiler)
    "friends": ["0xa::coin_admin"],                  // from `friend` decls (parser AST)
    "functions": [
      {
        "name": "register",
        "file": "sources/coin.move", "span": [42, 58], // start/end line (compiler)
        "visibility": "public",                       // typed AST visibility
        "isEntry": true,                              // entry modifier
        "isView": false,                              // #[view] attribute
        "attributes": ["view"|"event"|"test"|...],    // parsed attribute list
        "typeParams": [{ "name": "CoinType", "abilities": [], "isPhantom": false }],
        "params": [{ "name": "account", "type": "&signer" }],
        "returnType": "u64" | null,
        "acquires": ["0xa::coin::CoinStore"],         // acquires list (typed AST)
        "hasSpec": false,                             // spec block present
        "resourceAccess": {                            // from typed AST / bytecode
          "reads":  ["0xa::coin::CoinStore"],          // borrow_global, exists
          "writes": ["0xa::coin::CoinStore"]           // move_to, move_from, borrow_global_mut
        }
      }
    ],
    "types": [
      { "kind": "struct", "name": "CoinStore", "file": "sources/coin.move", "span": [10, 12],
        "abilities": ["key"], "fields": [{ "name": "balance", "type": "u64" }] },
      { "kind": "enum", "name": "Shape", "file": "sources/shapes.move", "span": [3, 9],
        "abilities": ["copy","drop"],
        "variants": [
          { "name": "Circle", "kind": "named", "fields": [{ "name":"radius","type":"u64" }] },
          { "name": "Empty",  "kind": "unit",  "fields": [] }
        ] }
    ],
    "constants": [{ "name": "E_NOT_REGISTERED", "type": "u64", "value": "1" }]
  }
}
```

Backward-compatible: existing `module_summary`/`call_graph`/`function_usage` unchanged. The
`facts` query is additive; GitNexus capability-probes for it.

## Phasing (each phase ships independently)

- **Phase 0 — Thin-consumer rebase onto v1.6.6 (this plan).** Re-port Move as a thin move-flow
  consumer; drop tree-sitter; drop the 7 redundant fork commits (native upstream); graft Move
  MCP tools onto upstream's backend; write the move-flow `facts` spec. Where move-flow lacks a
  fact, parse the **normalized signature only** and mark enums/resource-access/attributes
  "best-effort pending facts query." Deliver both audits.
- **Phase 1 — move-flow `facts` query.** Separate Rust PR to move-flow per the spec above;
  GitNexus switches to it behind the capability probe and **deletes the last signature/regex
  fallback for those facts**.
- **Phase 2 — AI layer.** Move-aware embeddings + semantic query; unified agent-native Move
  toolset (index + live move-flow passthrough); verification/coverage as node properties.
- **Phase 3 — Org-wide & gates.** Group registry of all org Move repos; cross-repo impact; CI
  gates (resource-access diff, entry-surface change, coverage/verify regression); one-command setup.

## Phase 0 scope (detailed)

### Mechanics
- `git fetch upstream`; new git worktree, branch `integrate/upstream-v1.6.6` off `upstream/main`.
- Validate (`tsc --noEmit`, `vitest`) after each tier; never advance on a broken build.

### Drop (native in v1.6.6 — confirmed)
incremental (#1479, `4fa40e98`), chunking (#987/#889), cross-repo group (#984, `00966630`),
rust-workspace (#1256). Verify+drop #832, #1316. Also **drop** the fork's custom incremental
and chunking re-implementations.

### Re-port as thin consumer (not verbatim)
- **Schema** (`gitnexus-shared`): `EnumVariant` node; `FRIEND_OF`/`READS_RESOURCE`/
  `WRITES_RESOURCE` edges; Move node-properties; `Move` lang enum; `.move` detection;
  `schema-constants` in lockstep.
- **Move core** collapsed to a thin set: move-flow client (capability-probing), facts→graph
  mapper, `graph-writer`, normalized-`signature-parser` (fallback only), `symbol-id`,
  `port-extractor`, quality enrichment (verify/coverage). **Delete** `attribute-scanner`,
  `enum-variants` (regex), `resource-ops` (regex), `friend-resolver` (regex), `source-store`/
  `source-utils`/`source-index` (raw-source scanning), `language-provider`, `type-extractor`,
  `type-visibility`, `named-bindings`, `import-resolver`. Keep `move-toml` (manifest parse is
  config, not source).
- **Pipeline**: register `moveIngest`/`moveQuality` in the current pipeline; `parse.ts`
  excludes ingested `.move`. RING4 touchpoints: `import-processor.ts` edit dropped (file
  deleted upstream); `model/resolve.ts` MRO perf is non-Move, re-apply only if upstream lacks it.
- **MCP**: graft `move_entries`/`move_resources`/`move_impact` + Move/understand resources +
  `DEFAULT_IMPACT_RELATION_TYPES` onto upstream `local-backend.ts`; keep upstream stdio sentinel.
- **Non-Move extras**: re-port `file_scout` + `group_*` only where not superseded.
- **Deps**: omit `tree-sitter-move-on-aptos` and its patch script.
- **Tests**: re-port Move unit/golden tests + fixtures; gate move-flow-dependent tests on binary
  availability. Enum/resource-access golden tests assert "best-effort" until Phase 1.

### Capability probe + fallback
On first package, GitNexus calls a move-flow capability check (list tools / version). If the
`facts` query exists, ingest from it (including per-symbol `file`/`span` for precise node
locations). Else: structure + abilities/fields/constants/signatures from `module_summary`;
visibility/entry/generics/params/return from the **normalized signature string**; mark
attributes/acquires/friends/resource-access/enum-variants as unavailable (emit nodes without
those edges/props, never scan source). **filePath in fallback mode** degrades to the package
root (move-flow `module_summary` does not carry per-module file locations); precise
`file`/`span` arrives only with the `facts` query. Document this degradation in node metadata
so consumers know locations are coarse pre-Phase-1.

## Audit deliverables
1. **Move-adaptability audit** (`docs/code-indexing/move/adaptability-v166.md`).
2. **MCP completeness/correctness audit** (`docs/code-indexing/move/mcp-audit-v166.md`).
3. **move-flow `facts` query spec** (`docs/code-indexing/move/move-flow-facts-spec.md`) —
   the section above, expanded with per-field compiler provenance for the Rust implementer.

## Validation gates
`tsc --noEmit` → `vitest` Move suite → full `vitest` → `gitnexus analyze` on a Move fixture
(assert Module/Function/Struct nodes; resource edges present iff facts query available) →
`gitnexus_detect_changes`.

## Risks
- **RING4 touchpoints (contained).** `import-processor.ts`/`wildcard-synthesis.ts`/
  `resolution-context.ts`/`named-bindings/` deleted upstream; Move never registered into them
  (its helpers were self-contained), so blast radius is the two edits above.
- **Capability probe correctness.** Must reliably detect move-flow's `facts` support and degrade
  cleanly; a wrong probe must not silently drop to raw-source scanning (there is none).
- **Best-effort honesty.** Phase 0 graphs lack resource/enum/attribute fidelity until Phase 1;
  audits and MCP responses must state this, not imply completeness.
- **move-flow `function_usage` reliability.** Returned empty for `coin::transfer`; do not rely on
  it for resource access — that fact must come from the `facts` query (Phase 1).
- **Agent-summary inflation.** Earlier discovery invented files (`languages/move.ts` etc.) that
  don't exist. Treat pre-execution file lists as leads; verify per-file during execution.

## Out of scope
- Literal git rebase or mega-merge.
- Re-porting redundant upstream re-implementations or the fragile raw-source scanning layer.
- Implementing the move-flow Rust change in this repo (spec only; separate PR).
- `gitnexus-web` Move UI beyond what compiles cleanly.
- Phases 1–3 implementation (own plans after Phase 0 review).
