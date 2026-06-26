/**
 * Shared Move/Aptos constants and helpers — single source of truth for the
 * magic strings that span the mapper, the ingest phase, the entry-point linker,
 * and the MCP backend. A typo in any duplicated literal silently breaks a query
 * with no compile error, so they live here.
 */

/** `NodeProperties.language` tag for every Move symbol. */
export const MOVE_LANGUAGE = 'move';

/** Parsed Move attribute names of interest. */
export const MOVE_ATTR = {
  EVENT: 'event',
} as const;

/** Move struct abilities of interest. */
export const MOVE_ABILITY = {
  KEY: 'key',
} as const;

/**
 * `reason` strings for Move graph edges.
 *
 * Note on `friend`: move-flow's `friends` array on a module is a *compiler-
 * derived* set that conflates two source-level concepts: explicit
 * `friend X::Y;` declarations and the Move-2 cross-module visibility that
 * `package fun` (and friend-restricted `public(friend)`) implicitly grants.
 * The facts payload does not preserve which of the two produced each entry,
 * so the `move-friend-or-package` reason is intentionally ambiguous; a
 * downstream filter (e.g. re-parsing source) is needed to distinguish them.
 */
export const MOVE_EDGE_REASON = {
  definesFunction: 'move-module-defines-function',
  definesStruct: 'move-module-defines-struct',
  definesEnum: 'move-module-defines-enum',
  definesConst: 'move-module-defines-const',
  containsVariant: 'move-enum-contains-variant',
  friend: 'move-friend-or-package',
  calls: 'move-compiler-call-graph',
  crossModuleDependency: 'move-cross-module-dependency',
  moduleInFile: 'move-module-in-file',
  // Resource-access edges (function → resource struct)
  readsResource: 'move-reads_resource',
  writesResource: 'move-writes_resource',
  acquires: 'move-acquires',
  fnParamType: 'move-fn-param-type',
  fnReturnType: 'move-fn-return-type',
  // Entry-point edge reasons (also set as funcNode.properties.entryPointReason)
  entryFunction: 'move-entry-function',
  viewFunction: 'move-view-function',
  initModule: 'move-init-module',
} as const;

/** Error-code constant naming convention (e.g. `E_NOT_REGISTERED`). */
export const ERROR_CODE_PATTERN = /^E[_A-Z]/;

/**
 * Make an absolute path repo-relative so node IDs and `File:` node links align.
 * Returns the input unchanged when `repoPath` is absent or non-matching.
 */
export function moveRepoRelativePath(absPath: string, repoPath?: string): string {
  if (!repoPath) return absPath;
  if (absPath.startsWith(repoPath)) {
    const rel = absPath.slice(repoPath.length);
    return rel.startsWith('/') ? rel.slice(1) : rel;
  }
  return absPath;
}
