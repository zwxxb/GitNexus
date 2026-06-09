/**
 * Phase: moveIngest
 *
 * Compiler-first Move ingestion via the move-flow MCP server. **No raw Move
 * source is ever read.** On the first package the phase probes move-flow's
 * capabilities:
 *
 *   - `facts` query available → full-fidelity ingestion (locations, visibility,
 *     entry/view, attributes, acquires, resource reads/writes, friends, enum
 *     variants) via the thin `facts → graph` mapper.
 *   - otherwise → degraded ingestion adapted from `module_summary` + the
 *     compiler's normalized signature string (no attributes/acquires/friends/
 *     enum variants; node locations coarsened to the package root).
 *
 * Both paths funnel through the SAME `mapFactsToGraph` builder — the fallback
 * adapts `module_summary` to the `facts` shape (`moduleSummaryToFacts`) so node
 * shapes never diverge. Call edges come from the `call_graph` query in both modes.
 *
 * @deps    structure
 * @reads   scannedFiles (from structure phase)
 * @writes  graph (Module/Function/Struct/Enum/EnumVariant/Const nodes +
 *          CALLS/DEFINES/CONTAINS/FRIEND_OF/READS_RESOURCE/WRITES_RESOURCE/
 *          ACQUIRES/ENTRY_POINT_OF/IMPORTS edges)
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  PipelinePhase,
  PipelineContext,
  PhaseResult,
} from '../ingestion/pipeline-phases/types.js';
import { getPhaseOutput } from '../ingestion/pipeline-phases/types.js';
import type { StructureOutput } from '../ingestion/pipeline-phases/structure.js';
import type { KnowledgeGraph } from '../graph/types.js';
import { MOVE_EDGE_REASON, moveRepoRelativePath } from './constants.js';
import type { MoveFlowClient } from './mcp-client.js';
import { mapFactsToGraph, type MoveFactsMapResult } from './facts-mapper.js';
import { moduleSummaryToFacts, type CallGraphMap } from './compiler-facts.js';
import { moveModuleNodeId } from './symbol-id.js';
import { validateMoveIngestOutput, type MoveConsistencyIssue } from './consistency.js';
import { createMoveEntryPointEdges } from './entry-points.js';

// ── Phase output ───────────────────────────────────────────────────────────

export interface MoveIngestOutput {
  /** Repo-relative paths of `.move` files ingested via the compiler path. */
  ingestedFiles: ReadonlySet<string>;
  /** Move package roots (absolute directories containing Move.toml). */
  packageRoots: string[];
  /** Module qualified names → source file path (repo-relative or package-root). */
  moduleFileMap: ReadonlyMap<string, string>;
  /** Function qualified names → graph node IDs. */
  functionNodeMap: ReadonlyMap<string, string>;
  /** Struct/enum qualified names → graph node IDs. */
  structNodeMap: ReadonlyMap<string, string>;
  /** Module qualified names → absolute package root. */
  modulePackageMap: ReadonlyMap<string, string>;
  /** Function qualified names → absolute package root. */
  functionPackageMap: ReadonlyMap<string, string>;
  /** Repo-relative file paths → absolute package root. */
  filePackageMap: ReadonlyMap<string, string>;
  /** Absolute package root → compiler call graph for that package. */
  callGraphByPackage: ReadonlyMap<string, CallGraphMap>;
  /** Whether the rich `facts` query was used (vs the signature-only fallback). */
  usedFactsQuery: boolean;
  /** Non-fatal consistency issues found after Move ingestion. */
  consistencyIssues: MoveConsistencyIssue[];
}

/** Mutable accumulator shared while ingesting every package. */
interface MoveIngestState {
  ingestedFiles: Set<string>;
  moduleFileMap: Map<string, string>;
  functionNodeMap: Map<string, string>;
  structNodeMap: Map<string, string>;
  modulePackageMap: Map<string, string>;
  functionPackageMap: Map<string, string>;
  filePackageMap: Map<string, string>;
  callGraphByPackage: Map<string, CallGraphMap>;
}

function createState(): MoveIngestState {
  return {
    ingestedFiles: new Set(),
    moduleFileMap: new Map(),
    functionNodeMap: new Map(),
    structNodeMap: new Map(),
    modulePackageMap: new Map(),
    functionPackageMap: new Map(),
    filePackageMap: new Map(),
    callGraphByPackage: new Map(),
  };
}

function toOutput(
  state: MoveIngestState,
  packageRoots: string[],
  usedFactsQuery: boolean,
): MoveIngestOutput {
  return {
    ingestedFiles: state.ingestedFiles,
    packageRoots,
    moduleFileMap: state.moduleFileMap,
    functionNodeMap: state.functionNodeMap,
    structNodeMap: state.structNodeMap,
    modulePackageMap: state.modulePackageMap,
    functionPackageMap: state.functionPackageMap,
    filePackageMap: state.filePackageMap,
    callGraphByPackage: state.callGraphByPackage,
    usedFactsQuery,
    consistencyIssues: [],
  };
}

/** Add a mapped package's nodes/edges to the graph and merge its identity maps. */
function applyMapped(
  graph: KnowledgeGraph,
  mapped: MoveFactsMapResult,
  pkgRoot: string,
  state: MoveIngestState,
): void {
  for (const node of mapped.nodes) graph.addNode(node);
  for (const rel of mapped.edges) graph.addRelationship(rel);
  for (const [qn, file] of mapped.moduleFileMap) {
    state.moduleFileMap.set(qn, file);
    state.modulePackageMap.set(qn, pkgRoot);
    state.filePackageMap.set(file, pkgRoot);
  }
  for (const [qn, id] of mapped.functionNodeMap) {
    state.functionNodeMap.set(qn, id);
    state.functionPackageMap.set(qn, pkgRoot);
  }
  for (const [qn, id] of mapped.structNodeMap) state.structNodeMap.set(qn, id);
}

export function createMoveIngestPhase(
  client: MoveFlowClient | null,
): PipelinePhase<MoveIngestOutput> {
  return {
    name: 'moveIngest',
    deps: ['structure'],

    async execute(
      ctx: PipelineContext,
      deps: ReadonlyMap<string, PhaseResult<unknown>>,
    ): Promise<MoveIngestOutput> {
      const { scannedFiles, totalFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');

      const packageRoots = [
        ...new Set(
          scannedFiles
            .map((f) => f.path)
            .filter((p) => p.endsWith('Move.toml'))
            .map((p) => path.dirname(path.resolve(ctx.repoPath, p))),
        ),
      ];
      if (!client || packageRoots.length === 0) {
        return toOutput(createState(), packageRoots, false);
      }

      const useFacts = (await client.capabilities()).hasFactsQuery;
      const state = createState();

      // Mark every scanned .move file under a package root as ingested so the
      // generic parse phase skips them (we never tree-sit Move source).
      for (const f of scannedFiles) {
        if (!f.path.endsWith('.move')) continue;
        const abs = path.resolve(ctx.repoPath, f.path);
        if (packageRoots.some((root) => abs.startsWith(root))) {
          state.ingestedFiles.add(moveRepoRelativePath(abs, ctx.repoPath));
        }
      }

      // Pass 1: per-package nodes/edges (all packages first, so cross-package
      // CALLS in Pass 2 can resolve callees in later packages).
      for (const pkgRoot of packageRoots) {
        try {
          ctx.onProgress({
            phase: 'moveIngest',
            percent: 18,
            message: `Ingesting Move package: ${path.basename(pkgRoot)}`,
            stats: { filesProcessed: 0, totalFiles, nodesCreated: ctx.graph.nodeCount },
          });

          const callGraphData = await client.callGraph(pkgRoot).catch(() => ({}));
          state.callGraphByPackage.set(pkgRoot, callGraphData);

          const factsMap = useFacts
            ? await client.facts(pkgRoot)
            : moduleSummaryToFacts(await client.moduleSummary(pkgRoot));
          applyMapped(ctx.graph, mapFactsToGraph(factsMap, pkgRoot, ctx.repoPath), pkgRoot, state);
        } catch (err) {
          ctx.onProgress({
            phase: 'moveIngest',
            percent: 20,
            message: `Move ingest skipped ${path.basename(pkgRoot)}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            stats: { filesProcessed: 0, totalFiles, nodesCreated: ctx.graph.nodeCount },
          });
        }
      }

      // Pass 2+: link edges that need the full cross-package node index.
      linkCallEdges(ctx.graph, state);
      linkFileImports(ctx.graph, state);
      linkFileModuleContains(ctx.graph, state);

      const output = toOutput(state, packageRoots, useFacts);
      createMoveEntryPointEdges(ctx.graph, output);

      output.consistencyIssues = validateMoveIngestOutput(ctx.graph, output);
      reportConsistencyIssues(ctx, output.consistencyIssues);
      return output;
    },
  };
}

function relId(): string {
  return `rel:${randomUUID()}`;
}

/** CALLS edges from each package's call graph (resolved across all packages). */
function linkCallEdges(graph: KnowledgeGraph, state: MoveIngestState): void {
  for (const callGraph of state.callGraphByPackage.values()) {
    for (const [callerQualified, callees] of Object.entries(callGraph)) {
      const callerId = state.functionNodeMap.get(callerQualified);
      if (!callerId) continue;
      for (const calleeQualified of callees) {
        const calleeId = state.functionNodeMap.get(calleeQualified);
        if (!calleeId) continue;
        graph.addRelationship({
          id: relId(),
          sourceId: callerId,
          targetId: calleeId,
          type: 'CALLS',
          confidence: 1.0,
          reason: MOVE_EDGE_REASON.calls,
        });
      }
    }
  }
}

/** File→File IMPORTS derived from cross-module CALLS (deduped against existing). */
function linkFileImports(graph: KnowledgeGraph, state: MoveIngestState): void {
  const seen = new Set<string>();
  graph.forEachRelationship((r) => {
    if (r.type !== 'IMPORTS') return;
    if (!r.sourceId.startsWith('File:') || !r.targetId.startsWith('File:')) return;
    seen.add(`${r.sourceId.slice(5)}\0${r.targetId.slice(5)}`);
  });
  const moduleOf = (qualified: string): string => qualified.slice(0, qualified.lastIndexOf('::'));
  for (const callGraph of state.callGraphByPackage.values()) {
    for (const [callerQualified, callees] of Object.entries(callGraph)) {
      const callerFile = state.moduleFileMap.get(moduleOf(callerQualified));
      if (!callerFile) continue;
      for (const calleeQualified of callees) {
        const calleeFile = state.moduleFileMap.get(moduleOf(calleeQualified));
        if (!calleeFile || calleeFile === callerFile) continue;
        const key = `${callerFile}\0${calleeFile}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sourceFileId = `File:${callerFile}`;
        const targetFileId = `File:${calleeFile}`;
        if (graph.getNode(sourceFileId) && graph.getNode(targetFileId)) {
          graph.addRelationship({
            id: relId(),
            sourceId: sourceFileId,
            targetId: targetFileId,
            type: 'IMPORTS',
            confidence: 0.9,
            reason: MOVE_EDGE_REASON.crossModuleDependency,
          });
        }
      }
    }
  }
}

/** File→Module CONTAINS where the File node exists (from the structure phase). */
function linkFileModuleContains(graph: KnowledgeGraph, state: MoveIngestState): void {
  for (const [qn, file] of state.moduleFileMap) {
    const fileNodeId = `File:${file}`;
    const moduleNodeId = moveModuleNodeId(qn, file);
    if (graph.getNode(fileNodeId) && graph.getNode(moduleNodeId)) {
      graph.addRelationship({
        id: relId(),
        sourceId: fileNodeId,
        targetId: moduleNodeId,
        type: 'CONTAINS',
        confidence: 1.0,
        reason: MOVE_EDGE_REASON.moduleInFile,
      });
    }
  }
}

/** Surface consistency errors so they reach a human/log (not just the output). */
function reportConsistencyIssues(ctx: PipelineContext, issues: MoveConsistencyIssue[]): void {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length === 0) return;
  ctx.onProgress({
    phase: 'moveIngest',
    percent: 22,
    message: `Move ingest: ${errors.length} consistency error(s) (e.g. ${errors[0].message})`,
    stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: ctx.graph.nodeCount },
  });
}
