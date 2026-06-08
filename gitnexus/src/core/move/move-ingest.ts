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
 *   - otherwise → degraded ingestion from `module_summary` + the compiler's
 *     normalized signature string only (no attributes/acquires/friends/enum
 *     variants), with node locations coarsened to the package root.
 *
 * Call edges come from the `call_graph` query in both modes.
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
import type { GraphNode } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import type { MoveFlowClient } from './mcp-client.js';
import { mapFactsToGraph } from './facts-mapper.js';
import { parseMoveSignature } from './signature-parser.js';
import {
  moveConstNodeId,
  moveFunctionNodeId,
  moveModuleNodeId,
  moveStructNodeId,
  parseMoveModuleQualifiedName,
} from './symbol-id.js';
import {
  buildMovePackageFacts,
  createEmptyMoveCompilerFacts,
  mergeMovePackageFacts,
  type CallGraphMap,
  type ModuleSummaryMap,
  type MoveCompilerFacts,
  type MoveFlowManifest,
} from './compiler-facts.js';
import { validateMoveIngestOutput, type MoveConsistencyIssue } from './consistency.js';
import { createMoveEntryPointEdges } from './entry-points.js';

const ERROR_CODE_PATTERN = /^E[_A-Z]/;

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
  /** Normalized move-flow facts shared by graph and Understand projections. */
  compilerFacts: MoveCompilerFacts;
  /** Whether the rich `facts` query was used (vs the signature-only fallback). */
  usedFactsQuery: boolean;
  /** Non-fatal consistency issues found after Move ingestion. */
  consistencyIssues: MoveConsistencyIssue[];
}

function makeRelativePath(absolutePath: string, repoPath: string): string {
  if (absolutePath.startsWith(repoPath)) {
    const rel = absolutePath.slice(repoPath.length);
    return rel.startsWith('/') ? rel.slice(1) : rel;
  }
  return absolutePath;
}

function emptyOutput(packageRoots: string[]): MoveIngestOutput {
  return {
    ingestedFiles: new Set(),
    packageRoots,
    moduleFileMap: new Map(),
    functionNodeMap: new Map(),
    structNodeMap: new Map(),
    modulePackageMap: new Map(),
    functionPackageMap: new Map(),
    filePackageMap: new Map(),
    callGraphByPackage: new Map(),
    compilerFacts: createEmptyMoveCompilerFacts(),
    usedFactsQuery: false,
    consistencyIssues: [],
  };
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

      // Discover Move packages from scanned Move.toml files.
      const moveTomlFiles = scannedFiles.map((f) => f.path).filter((p) => p.endsWith('Move.toml'));
      const packageRoots = [
        ...new Set(moveTomlFiles.map((p) => path.dirname(path.resolve(ctx.repoPath, p)))),
      ];

      if (!client || packageRoots.length === 0) {
        return emptyOutput(packageRoots);
      }

      const caps = await client.capabilities();
      const useFacts = caps.hasFactsQuery;

      const ingestedFiles = new Set<string>();
      const moduleFileMap = new Map<string, string>();
      const functionNodeMap = new Map<string, string>();
      const structNodeMap = new Map<string, string>();
      const modulePackageMap = new Map<string, string>();
      const functionPackageMap = new Map<string, string>();
      const filePackageMap = new Map<string, string>();
      const callGraphByPackage = new Map<string, CallGraphMap>();
      const deferredCallGraphs: CallGraphMap[] = [];
      let compilerFacts = createEmptyMoveCompilerFacts();

      // Mark every scanned .move file under a package root as ingested so the
      // generic parse phase skips them (we never tree-sit Move source).
      for (const f of scannedFiles) {
        if (!f.path.endsWith('.move')) continue;
        const abs = path.resolve(ctx.repoPath, f.path);
        if (packageRoots.some((root) => abs.startsWith(root))) {
          ingestedFiles.add(makeRelativePath(abs, ctx.repoPath));
        }
      }

      // ── Pass 1: nodes (all packages, so cross-package CALLS resolve) ──────
      for (const pkgRoot of packageRoots) {
        const pkgRel = makeRelativePath(pkgRoot, ctx.repoPath);
        try {
          ctx.onProgress({
            phase: 'moveIngest',
            percent: 18,
            message: `Ingesting Move package: ${path.basename(pkgRoot)}`,
            stats: { filesProcessed: 0, totalFiles, nodesCreated: ctx.graph.nodeCount },
          });

          // Call graph drives CALLS edges in both modes.
          const callGraphData = (await client.callGraph(pkgRoot).catch(() => ({}))) as CallGraphMap;
          callGraphByPackage.set(pkgRoot, callGraphData);
          deferredCallGraphs.push(callGraphData);

          if (useFacts) {
            // Primary path: the rich `facts` query is the *only* move-flow call
            // on the critical path — no module_summary, no signature re-parsing.
            const facts = await client.facts(pkgRoot);
            const mapped = mapFactsToGraph(facts, pkgRoot, ctx.repoPath);
            for (const node of mapped.nodes) ctx.graph.addNode(node);
            for (const rel of mapped.edges) ctx.graph.addRelationship(rel);
            for (const [qn, file] of mapped.moduleFileMap) {
              moduleFileMap.set(qn, file);
              modulePackageMap.set(qn, pkgRoot);
              filePackageMap.set(file, pkgRoot);
            }
            for (const [qn, id] of mapped.functionNodeMap) {
              functionNodeMap.set(qn, id);
              functionPackageMap.set(qn, pkgRoot);
            }
            for (const [qn, id] of mapped.structNodeMap) structNodeMap.set(qn, id);
          } else {
            // Degraded path: module_summary + normalized signature only (no
            // attributes/acquires/friends/enum-variants, package-root locations).
            const manifest = (await client
              .manifest(pkgRoot)
              .catch(() => ({ source_paths: [], dep_paths: [] }))) as MoveFlowManifest;
            const summary = (await client.moduleSummary(pkgRoot)) as ModuleSummaryMap;
            compilerFacts = mergeMovePackageFacts(
              compilerFacts,
              buildMovePackageFacts({
                packageRoot: pkgRoot,
                manifest,
                moduleSummary: summary,
                callGraph: callGraphData,
              }),
            );
            ingestFromModuleSummary(ctx, summary, pkgRoot, pkgRel, {
              moduleFileMap,
              functionNodeMap,
              structNodeMap,
              modulePackageMap,
              functionPackageMap,
              filePackageMap,
            });
          }
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

      // ── Pass 2: CALLS edges (now functionNodeMap has every package) ──────
      for (const callGraphData of deferredCallGraphs) {
        for (const [callerQualified, callees] of Object.entries(callGraphData)) {
          const callerId = functionNodeMap.get(callerQualified);
          if (!callerId) continue;
          for (const calleeQualified of callees) {
            const calleeId = functionNodeMap.get(calleeQualified);
            if (!calleeId) continue;
            ctx.graph.addRelationship({
              id: `rel:${randomUUID()}`,
              sourceId: callerId,
              targetId: calleeId,
              type: 'CALLS',
              confidence: 1.0,
              reason: 'move-compiler-call-graph',
            });
          }
        }
      }

      // ── Pass 3: File→File IMPORTS from cross-module calls ────────────────
      const importPairs = new Set<string>();
      ctx.graph.forEachRelationship((r) => {
        if (r.type !== 'IMPORTS') return;
        if (!r.sourceId.startsWith('File:') || !r.targetId.startsWith('File:')) return;
        importPairs.add(`${r.sourceId.slice(5)}\0${r.targetId.slice(5)}`);
      });
      for (const callGraphData of deferredCallGraphs) {
        for (const [callerQualified, callees] of Object.entries(callGraphData)) {
          const callerModule = callerQualified.slice(0, callerQualified.lastIndexOf('::'));
          const callerFile = moduleFileMap.get(callerModule);
          if (!callerFile) continue;
          for (const calleeQualified of callees) {
            const calleeModule = calleeQualified.slice(0, calleeQualified.lastIndexOf('::'));
            const calleeFile = moduleFileMap.get(calleeModule);
            if (!calleeFile || calleeFile === callerFile) continue;
            const pairKey = `${callerFile}\0${calleeFile}`;
            if (importPairs.has(pairKey)) continue;
            importPairs.add(pairKey);
            const sourceFileId = `File:${callerFile}`;
            const targetFileId = `File:${calleeFile}`;
            if (ctx.graph.getNode(sourceFileId) && ctx.graph.getNode(targetFileId)) {
              ctx.graph.addRelationship({
                id: `rel:${randomUUID()}`,
                sourceId: sourceFileId,
                targetId: targetFileId,
                type: 'IMPORTS',
                confidence: 0.9,
                reason: 'move-cross-module-dependency',
              });
            }
          }
        }
      }

      // File→Module CONTAINS where the File node exists.
      for (const [qn, file] of moduleFileMap) {
        const fileNodeId = `File:${file}`;
        const moduleNodeId = moveModuleNodeId(qn, file);
        if (ctx.graph.getNode(fileNodeId) && ctx.graph.getNode(moduleNodeId)) {
          ctx.graph.addRelationship({
            id: `rel:${randomUUID()}`,
            sourceId: fileNodeId,
            targetId: moduleNodeId,
            type: 'CONTAINS',
            confidence: 1.0,
            reason: 'move-module-in-file',
          });
        }
      }


      const output: MoveIngestOutput = {
        ingestedFiles,
        packageRoots,
        moduleFileMap,
        functionNodeMap,
        structNodeMap,
        modulePackageMap,
        functionPackageMap,
        filePackageMap,
        callGraphByPackage,
        compilerFacts,
        usedFactsQuery: useFacts,
        consistencyIssues: [],
      };

      // Entry-point edges (entry/view/init_module) from node flags.
      createMoveEntryPointEdges(ctx.graph, output);

      output.consistencyIssues = validateMoveIngestOutput(ctx.graph, output);
      return output;
    },
  };
}

/** Degraded ingestion from module_summary + normalized signature (no source). */
function ingestFromModuleSummary(
  ctx: PipelineContext,
  summary: ModuleSummaryMap,
  pkgRoot: string,
  pkgRel: string,
  maps: {
    moduleFileMap: Map<string, string>;
    functionNodeMap: Map<string, string>;
    structNodeMap: Map<string, string>;
    modulePackageMap: Map<string, string>;
    functionPackageMap: Map<string, string>;
    filePackageMap: Map<string, string>;
  },
): void {
  for (const [qualifiedName, mod] of Object.entries(summary)) {
    const { address, moduleName } = parseMoveModuleQualifiedName(qualifiedName);
    // module_summary carries no per-module file — coarsen to the package root.
    const relPath = pkgRel || `${moduleName}.move`;
    maps.moduleFileMap.set(qualifiedName, relPath);
    maps.modulePackageMap.set(qualifiedName, pkgRoot);
    maps.filePackageMap.set(relPath, pkgRoot);

    const moduleId = moveModuleNodeId(qualifiedName, relPath);
    ctx.graph.addNode({
      id: moduleId,
      label: 'Module',
      properties: {
        name: moduleName,
        filePath: relPath,
        language: SupportedLanguages.Move,
        isExported: true,
        moduleAddress: address,
        qualifiedName,
        locationFidelity: 'package',
      },
    });

    for (const fn of mod.functions) {
      const parsed = parseMoveSignature(fn.signature);
      if (!parsed.name) continue;
      const funcQualified = `${qualifiedName}::${parsed.name}`;
      const funcId = moveFunctionNodeId(funcQualified, relPath);
      const funcNode: GraphNode = {
        id: funcId,
        label: 'Function',
        properties: {
          name: parsed.name,
          filePath: relPath,
          language: SupportedLanguages.Move,
          isExported: parsed.visibility === 'public',
          visibility: parsed.visibility,
          ...(parsed.visibilityModifier ? { visibilityModifier: parsed.visibilityModifier } : {}),
          isEntry: parsed.isEntry,
          returnType: parsed.returnType ?? undefined,
          parameterCount: parsed.parameters.length,
          ...(parsed.typeParams.length > 0 ? { typeParams: parsed.typeParams } : {}),
          ...(parsed.acquires.length > 0 ? { acquires: parsed.acquires } : {}),
          qualifiedName: funcQualified,
          moduleQualifiedName: qualifiedName,
          locationFidelity: 'package',
        },
      };
      ctx.graph.addNode(funcNode);
      maps.functionNodeMap.set(funcQualified, funcId);
      maps.functionPackageMap.set(funcQualified, pkgRoot);
      ctx.graph.addRelationship({
        id: `rel:${randomUUID()}`,
        sourceId: moduleId,
        targetId: funcId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: 'move-module-defines-function',
      });
    }

    for (const struct of mod.structs) {
      const structQualified = `${qualifiedName}::${struct.name}`;
      const structId = moveStructNodeId(structQualified, relPath);
      ctx.graph.addNode({
        id: structId,
        label: 'Struct',
        properties: {
          name: struct.name,
          filePath: relPath,
          language: SupportedLanguages.Move,
          isExported: true,
          abilities: struct.abilities,
          isResource: struct.abilities.includes('key'),
          fieldList: struct.fields,
          qualifiedName: structQualified,
          moduleQualifiedName: qualifiedName,
          locationFidelity: 'package',
        },
      });
      maps.structNodeMap.set(structQualified, structId);
      ctx.graph.addRelationship({
        id: `rel:${randomUUID()}`,
        sourceId: moduleId,
        targetId: structId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: 'move-module-defines-struct',
      });
    }

    for (const constant of mod.constants) {
      const constQualified = `${qualifiedName}::${constant.name}`;
      const constId = moveConstNodeId(constQualified, relPath);
      ctx.graph.addNode({
        id: constId,
        label: 'Const',
        properties: {
          name: constant.name,
          filePath: relPath,
          language: SupportedLanguages.Move,
          isExported: true,
          declaredType: constant.type,
          value: constant.value,
          isErrorCode: ERROR_CODE_PATTERN.test(constant.name),
          qualifiedName: constQualified,
          moduleQualifiedName: qualifiedName,
          locationFidelity: 'package',
        },
      });
      ctx.graph.addRelationship({
        id: `rel:${randomUUID()}`,
        sourceId: moduleId,
        targetId: constId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: 'move-module-defines-const',
      });
    }
  }
}
