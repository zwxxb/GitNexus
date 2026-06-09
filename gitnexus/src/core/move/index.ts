/**
 * Move/Aptos compiler-first ingestion — public surface.
 *
 * GitNexus consumes move-flow as the single source of truth (no raw-source
 * scanning). This barrel exposes only the thin-consumer API.
 */

export { createMoveIngestPhase } from './move-ingest.js';
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
  moveEnumNodeId,
  moveConstNodeId,
  moveEnumVariantNodeId,
} from './symbol-id.js';

export { validateMoveIngestOutput } from './consistency.js';
export type { MoveConsistencyIssue, MoveConsistencySeverity } from './consistency.js';

export { createMoveEntryPointEdges } from './entry-points.js';

// Compiler-facts types (facts query + module_summary fallback).
export { moduleSummaryToFacts } from './compiler-facts.js';
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
  ModuleSummaryMap,
  CallGraphMap,
} from './compiler-facts.js';
