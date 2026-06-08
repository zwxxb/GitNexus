# move-flow `facts` query — specification & GitNexus contract

**Status:** ✅ **DELIVERED** (shipped in move-flow; consumed by GitNexus v1.6.6 thin consumer).
**Date:** 2026-06-08

> This was the Phase 1 hand-off deliverable in the original design. As of the
> move-flow release integrated here, the `facts` query is **live**, so GitNexus
> ingests Move at full fidelity directly — no signature/regex fallback is needed
> when facts is available, and **zero raw Move source is ever scanned**.

## Surface

`facts` is a **`QueryType` on the `move_package_query` MCP tool** (not a separate
tool):

```jsonc
move_package_query { "package_path": "<dir>", "query": "facts" }
```

Tool description (verbatim): *"Returns structured facts per module: source
locations, friends, attributes, function metadata
(visibility/entry/view/native/inline), type/parameter/return signatures,
declared access specifiers, inferred acquires, AST-derived resource reads/writes,
enum variants, and spec presence. Designed for indexing and governance gates."*

Backward-compatible: `module_summary` / `call_graph` / `function_usage` are
unchanged; `facts` is additive.

## Response schema (live shape)

Top level: a map of fully-qualified module name → module facts.

```jsonc
{
  "0xa::coin": {
    "file": "/abs/path/sources/coin.move",   // module source file (absolute)
    "span": [1, 49],                          // [startLine, endLine]
    "friends": [{ "module": "0xa::coin_admin" }],
    "attributes": [{ "name": "..." }],        // module-level attributes
    "hasSpecs": false,                        // NOTE: plural at module level
    "functions": [ /* MoveFactsFunction */ ],
    "types":     [ /* MoveFactsType */ ],
    "constants": [ { "name": "E_X", "type": "u64", "value": "1" } ]
  }
}
```

### `MoveFactsFunction`

| field | type | provenance |
|-------|------|-----------|
| `name` | string | parser AST |
| `file` | string | compiler source map |
| `span` | `[number, number]` | compiler source map |
| `visibility` | `"public" \| "friend" \| "internal" \| ...` | typed AST |
| `isEntry` | boolean | `entry` modifier |
| `isInline` | boolean | `inline` modifier |
| `isNative` | boolean | `native` modifier |
| `isView` | boolean | `#[view]` attribute |
| `attributes` | `{ name: string }[]` | parsed attribute list |
| `typeParams` | `{ name, abilities: string[], isPhantom }[]` | typed AST |
| `params` | `{ name, type }[]` | typed AST |
| `returnType` | `string \| null` | typed AST |
| `declaredAccess` | `{ kind, resource: { form, value }, negated }[]` | access specifiers |
| `acquiresInferred` | `string[]` (fully-qualified, e.g. `0xa::coin::CoinStore`) | typed AST / bytecode |
| `resourceAccess` | `{ reads: string[], writes: string[] }` (type exprs, e.g. `CoinStore<CoinType>`) | typed AST / bytecode |
| `hasSpec` | boolean | spec block present |

### `MoveFactsType`

| field | type | notes |
|-------|------|-------|
| `kind` | `"struct" \| "enum"` | |
| `name`, `file`, `span` | | |
| `abilities` | `string[]` | subset of `copy/drop/store/key` |
| `typeParams` | `{ name, abilities, isPhantom }[]` | |
| `fields` | `{ name, type, positional }[]` | structs (name is `"0"`,`"1"` for positional) |
| `variants` | `{ name, kind: "unit"\|"positional"\|"named", fields, attributes }[]` | enums |
| `attributes` | `{ name }[]` | e.g. `{ name: "event" }` |
| `hasSpec` | boolean | |

## GitNexus capability-probe contract

Because `facts` is a *query const* (not a tool), the probe inspects the
`move_package_query` `inputSchema` from a `tools/list` response:

```ts
detectMoveFlowCapabilities(tools) // → { hasFactsQuery, hasModuleSummary }
```

- `hasFactsQuery` ⇐ a tool named `move_package_facts` **or** a `"facts"` const /
  enum value anywhere under the `move_package_query` `QueryType` schema.
- `hasModuleSummary` ⇐ presence of the `move_package_query` tool.

On a failed probe, GitNexus degrades to the `module_summary` + normalized
signature path (coarse locations), and **never** to raw-source scanning.

See `gitnexus/src/core/move/mcp-client.ts` (`MoveFlowMcpClient.capabilities`,
`detectMoveFlowCapabilities`) and `gitnexus/src/core/move/compiler-facts.ts`
(`MoveFactsMap` and friends) for the consuming types.

## Graph mapping (reference)

`gitnexus/src/core/move/facts-mapper.ts` maps facts → graph:

| facts | graph |
|-------|-------|
| module | `Module` node |
| function | `Function` node (visibility/isEntry/isView/isInline/isNative/attributes/typeParams/acquires/hasSpec/span) + `DEFINES` |
| struct | `Struct` node (`isResource = abilities∋key`, `isEvent = attr∋event`, fields) + `DEFINES` |
| enum | `Enum` node + one `EnumVariant` per variant (`CONTAINS`) |
| constant | `Const` node + `DEFINES` |
| `friends[]` | `FRIEND_OF` edges |
| `resourceAccess.reads/writes` | `READS_RESOURCE` / `WRITES_RESOURCE` edges |
| `acquiresInferred` | `ACQUIRES` edges |
| entry/view/init_module | `ENTRY_POINT_OF` edges |

All nodes carry `locationFidelity: 'precise'` when facts supplies per-symbol
file/span (always, today).
