/**
 * Shared Move/Aptos constants and helpers — single source of truth for the
 * magic strings that span the mapper, the ingest phase, the entry-point linker,
 * and the MCP backend. A typo in any duplicated literal silently breaks a query
 * with no compile error, so they live here.
 */

import type { RelationshipType } from 'gitnexus-shared';

/** `NodeProperties.language` tag for every Move symbol. */
export const MOVE_LANGUAGE = 'move';

/** Parsed Move attribute names of interest. */
export const MOVE_ATTR = {
  EVENT: 'event',
  VIEW: 'view',
  TEST: 'test',
  TEST_ONLY: 'test_only',
} as const;

/** Move struct abilities of interest. */
export const MOVE_ABILITY = {
  KEY: 'key',
} as const;

/** Resource-access edge types (function → resource struct). */
export const MOVE_RESOURCE_EDGE_TYPES: readonly RelationshipType[] = [
  'ACQUIRES',
  'READS_RESOURCE',
  'WRITES_RESOURCE',
];

/** `reason` strings for Move graph edges. */
export const MOVE_EDGE_REASON = {
  definesFunction: 'move-module-defines-function',
  definesStruct: 'move-module-defines-struct',
  definesEnum: 'move-module-defines-enum',
  definesConst: 'move-module-defines-const',
  containsVariant: 'move-enum-contains-variant',
  friend: 'move-friend-declaration',
  calls: 'move-compiler-call-graph',
  crossModuleDependency: 'move-cross-module-dependency',
  moduleInFile: 'move-module-in-file',
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
