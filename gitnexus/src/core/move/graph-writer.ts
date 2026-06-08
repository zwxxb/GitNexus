/**
 * Small graph projection helper for Move ingestion.
 *
 * Keep low-level relationship construction in one place so Move phases can
 * express graph intent instead of repeatedly creating UUID-backed edge shapes.
 */

import { randomUUID } from 'node:crypto';
import type { GraphNode, RelationshipType } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';

export class MoveGraphWriter {
  constructor(private readonly graph: KnowledgeGraph) {}

  addNode(node: GraphNode): void {
    this.graph.addNode(node);
  }

  addRelationship(input: {
    sourceId: string;
    targetId: string;
    type: RelationshipType;
    confidence: number;
    reason: string;
  }): void {
    this.graph.addRelationship({
      id: `rel:${randomUUID()}`,
      sourceId: input.sourceId,
      targetId: input.targetId,
      type: input.type,
      confidence: input.confidence,
      reason: input.reason,
    });
  }
}
