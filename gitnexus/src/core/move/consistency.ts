import type { KnowledgeGraph } from '../graph/types.js';
import type { MoveIngestOutput } from './move-ingest.js';
import { moveModuleQualifiedName } from './symbol-id.js';

export type MoveConsistencySeverity = 'warning' | 'error';

export interface MoveConsistencyIssue {
  code:
    | 'duplicate-node-id'
    | 'missing-owned-caller'
    | 'missing-owned-callee'
    | 'malformed-source-evidence';
  severity: MoveConsistencySeverity;
  message: string;
  details?: Record<string, unknown>;
}

export function validateMoveIngestOutput(
  graph: KnowledgeGraph,
  moveIngest: MoveIngestOutput,
): MoveConsistencyIssue[] {
  const issues: MoveConsistencyIssue[] = [];

  reportDuplicateValues('function', moveIngest.functionNodeMap, issues);
  reportDuplicateValues('struct', moveIngest.structNodeMap, issues);

  for (const [moduleQualified, filePath] of moveIngest.moduleFileMap) {
    if (!filePath.endsWith('.move')) {
      issues.push({
        code: 'malformed-source-evidence',
        severity: 'warning',
        message: `Move module ${moduleQualified} has non-Move source evidence: ${filePath}`,
        details: { moduleQualified, filePath },
      });
      continue;
    }
    const fileNode = graph.getNode(`File:${filePath}`);
    const knownSource = moveIngest.ingestedFiles.has(filePath) || !!fileNode;
    if (!knownSource) {
      issues.push({
        code: 'malformed-source-evidence',
        severity: 'warning',
        message: `Move module ${moduleQualified} points at a source file not seen by ingestion: ${filePath}`,
        details: { moduleQualified, filePath },
      });
    }
  }

  for (const [packageRoot, callGraph] of moveIngest.callGraphByPackage) {
    for (const [callerQualified, callees] of Object.entries(callGraph)) {
      const callerPackage = moveIngest.functionPackageMap.get(callerQualified);
      if (callerPackage === packageRoot && !moveIngest.functionNodeMap.has(callerQualified)) {
        issues.push({
          code: 'missing-owned-caller',
          severity: 'warning',
          message: `Move call graph caller has package ownership but no function node: ${callerQualified}`,
          details: { packageRoot, callerQualified },
        });
      }

      for (const calleeQualified of callees) {
        const calleeModule = moveModuleQualifiedName(calleeQualified);
        if (!moveIngest.modulePackageMap.has(calleeModule)) continue;
        if (moveIngest.functionNodeMap.has(calleeQualified)) continue;
        issues.push({
          code: 'missing-owned-callee',
          severity: 'warning',
          message: `Move call graph callee belongs to this repo but has no function node: ${calleeQualified}`,
          details: { packageRoot, callerQualified, calleeQualified },
        });
      }
    }
  }

  return issues;
}

function reportDuplicateValues(
  kind: string,
  map: ReadonlyMap<string, string>,
  issues: MoveConsistencyIssue[],
): void {
  const byId = new Map<string, string[]>();
  for (const [qualifiedName, nodeId] of map) {
    const list = byId.get(nodeId) ?? [];
    list.push(qualifiedName);
    byId.set(nodeId, list);
  }
  for (const [nodeId, symbols] of byId) {
    if (symbols.length < 2) continue;
    issues.push({
      code: 'duplicate-node-id',
      severity: 'error',
      message: `Multiple Move ${kind} symbols map to the same graph node ID: ${nodeId}`,
      details: { nodeId, symbols },
    });
  }
}
