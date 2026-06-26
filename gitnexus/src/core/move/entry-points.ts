/**
 * Move entry point detection.
 *
 * Creates ENTRY_POINT_OF edges for Move functions that serve as external
 * entry points into the contract:
 *   - entry functions (transaction entry points)
 *   - #[view] functions (read-only API queries)
 *   - init_module (lifecycle hook on module publish)
 *
 * Must run AFTER both moveIngest (creates nodes) and the attribute scanner
 * (sets isView, isInitModule flags).
 */

import type { KnowledgeGraph } from '../graph/types.js';
import type { MoveIngestOutput } from './move-ingest.js';
import { randomUUID } from 'node:crypto';
import { moveModuleNodeId, moveModuleQualifiedName } from './symbol-id.js';
import { MOVE_EDGE_REASON } from './constants.js';

export function createMoveEntryPointEdges(
  graph: KnowledgeGraph,
  moveIngest: MoveIngestOutput,
): void {
  for (const [funcQualified, funcNodeId] of moveIngest.functionNodeMap) {
    const funcNode = graph.getNode(funcNodeId);
    if (!funcNode) continue;

    const isEntry = funcNode.properties.isEntry === true;
    const isView = funcNode.properties.isView === true;
    const isInitModule = funcNode.properties.isInitModule === true;

    if (!isEntry && !isView && !isInitModule) continue;

    const moduleQualified = moveModuleQualifiedName(funcQualified);
    const moduleFilePath = moveIngest.moduleFileMap.get(moduleQualified);
    if (!moduleFilePath) continue;

    const moduleNodeId = moveModuleNodeId(moduleQualified, moduleFilePath);
    if (!graph.getNode(moduleNodeId)) continue;

    let reason: string;
    if (isEntry) reason = MOVE_EDGE_REASON.entryFunction;
    else if (isView) reason = MOVE_EDGE_REASON.viewFunction;
    else reason = MOVE_EDGE_REASON.initModule;

    funcNode.properties.entryPointReason = reason;

    graph.addRelationship({
      id: `rel:${randomUUID()}`,
      sourceId: funcNodeId,
      targetId: moduleNodeId,
      type: 'ENTRY_POINT_OF',
      confidence: 1.0,
      reason,
    });
  }
}
