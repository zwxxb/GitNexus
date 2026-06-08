/**
 * Move/Aptos compiler-first ingestion — public surface.
 *
 * GitNexus consumes move-flow as the single source of truth (no raw-source
 * scanning). This barrel exposes only the thin-consumer API.
 */

export { createMoveIngestPhase, mapWithConcurrency } from './move-ingest.js';
export type { MoveIngestOutput } from './move-ingest.js';

export {
  MoveFlowMcpClient,
  tryCreateMoveFlowClient,
  detectMoveFlowCapabilities,
} from './mcp-client.js';
export type { MoveFlowClient, MoveFlowCapabilities, MoveFlowToolInfo } from './mcp-client.js';

export { mapFactsToGraph } from './facts-mapper.js';
export type { MoveFactsMapResult } from './facts-mapper.js';

export { parseMoveSignature } from './signature-parser.js';
export type { ParsedMoveSignature, TypeParam } from './signature-parser.js';

export {
  parseMoveModuleQualifiedName,
  moveModuleQualifiedName,
  moveLocalName,
  moveShortSymbol,
  moveModuleNodeId,
  moveFunctionNodeId,
  moveStructNodeId,
  moveConstNodeId,
  moveEnumVariantNodeId,
} from './symbol-id.js';

export { validateMoveIngestOutput } from './consistency.js';
export type { MoveConsistencyIssue, MoveConsistencySeverity } from './consistency.js';

export { createMoveEntryPointEdges } from './entry-points.js';

export {
  extractMoveAddresses,
  parseMoveManifest,
  buildAddressTableForManifest,
} from './move-toml.js';
export type { MoveManifestInfo, MoveDependencySpec } from './move-toml.js';

// Compiler-facts types (facts query + module_summary fallback).
export type {
  MoveFactsMap,
  MoveFactsModule,
  MoveFactsFunction,
  MoveFactsType,
  MoveFactsVariant,
  MoveFactsField,
  MoveFactsTypeParam,
  MoveFactsAttribute,
  MoveFactsResourceAccess,
  MoveFactsDeclaredAccess,
  MoveCompilerFacts,
  MovePackageFacts,
  ModuleSummaryMap,
  CallGraphMap,
} from './compiler-facts.js';
