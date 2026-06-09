/**
 * Thin facts → graph mapper.
 *
 * Consumes the move-flow `facts` query response (the compiler's full-fidelity,
 * per-module structured facts) and produces standard GraphNode / GraphRelationship
 * objects. This is the heart of the compiler-first Move ingestion: there is
 * **no raw-source scanning** — every fact (visibility, entry/view, attributes,
 * acquires, resource reads/writes, enum variants, friends, locations) comes
 * straight from move-flow.
 */

import { randomUUID } from 'node:crypto';
import type { GraphNode, GraphRelationship, NodeLabel, RelationshipType } from 'gitnexus-shared';
import type { MoveFactsMap, MoveFactsTypeParam } from './compiler-facts.js';
import {
  moveModuleNodeId,
  moveFunctionNodeId,
  moveStructNodeId,
  moveEnumNodeId,
  moveConstNodeId,
  moveEnumVariantNodeId,
  parseMoveModuleQualifiedName,
} from './symbol-id.js';
import {
  ERROR_CODE_PATTERN,
  MOVE_ABILITY,
  MOVE_ATTR,
  MOVE_EDGE_REASON,
  MOVE_LANGUAGE,
  moveRepoRelativePath,
} from './constants.js';

export interface MoveFactsMapResult {
  nodes: GraphNode[];
  edges: GraphRelationship[];
  /** Module qualified name → source file path. */
  moduleFileMap: Map<string, string>;
  /** Function qualified name → graph node ID. */
  functionNodeMap: Map<string, string>;
  /** Struct/enum qualified name → graph node ID. */
  structNodeMap: Map<string, string>;
}

/** Strip generic type arguments: `CoinStore<CoinType>` → `CoinStore`. */
function stripTypeArgs(typeName: string): string {
  const idx = typeName.indexOf('<');
  return (idx === -1 ? typeName : typeName.slice(0, idx)).trim();
}

/** Local name of a (possibly already-local) symbol: `0xa::coin::CoinStore` → `CoinStore`. */
function localName(qualifiedName: string): string {
  const sep = qualifiedName.lastIndexOf('::');
  return sep === -1 ? qualifiedName : qualifiedName.slice(sep + 2);
}

/** Defensive: move-flow omits optional array fields for some symbols. */
function arr<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function mapTypeParams(
  typeParams: MoveFactsTypeParam[] | null | undefined,
): Array<{ name: string; constraints?: string[]; isPhantom?: boolean }> {
  return arr(typeParams).map((tp) => ({
    name: tp.name,
    constraints: arr(tp.abilities),
    isPhantom: tp.isPhantom,
  }));
}

function attributeNames(attributes: { name: string }[] | null | undefined): string[] {
  return arr(attributes).map((a) => a.name);
}

/**
 * Map a full `facts` response (covering every module in a package) to graph
 * nodes + edges. `packageRoot` is used only as a location fallback when the
 * compiler omits a per-symbol file (it never does today, but the field is
 * optional in the schema). When `repoPath` is given, absolute file paths from
 * the compiler are made repo-relative so node IDs align with `File:` nodes.
 */
export function mapFactsToGraph(
  facts: MoveFactsMap,
  packageRoot: string,
  repoPath?: string,
): MoveFactsMapResult {
  const nodes: GraphNode[] = [];
  const edges: GraphRelationship[] = [];
  const moduleFileMap = new Map<string, string>();
  const functionNodeMap = new Map<string, string>();
  const structNodeMap = new Map<string, string>();

  const edge = (
    sourceId: string,
    targetId: string,
    type: RelationshipType,
    confidence: number,
    reason: string,
  ): void => {
    edges.push({ id: `rel:${randomUUID()}`, sourceId, targetId, type, confidence, reason });
  };

  // Deferred work that needs the full struct/module index (pass B).
  const pendingResource: Array<{
    fnNodeId: string;
    moduleQualified: string;
    type: RelationshipType;
    target: string;
    qualified: boolean;
  }> = [];
  const pendingFriends: Array<{ moduleNodeId: string; friend: string }> = [];

  // ── Pass A: nodes (modules, functions, types, constants) ─────────────────
  for (const [moduleQualified, mod] of Object.entries(facts)) {
    const moduleFileAbs = mod.file ?? packageRoot;
    const file = moveRepoRelativePath(moduleFileAbs, repoPath);
    const { address, moduleName } = parseMoveModuleQualifiedName(moduleQualified);
    moduleFileMap.set(moduleQualified, file);

    const moduleNodeId = moveModuleNodeId(moduleQualified, file);
    nodes.push({
      id: moduleNodeId,
      label: 'Module',
      properties: {
        name: moduleName,
        filePath: file,
        language: MOVE_LANGUAGE,
        qualifiedName: moduleQualified,
        moduleQualifiedName: moduleQualified,
        moduleAddress: address,
        startLine: mod.span?.[0],
        endLine: mod.span?.[1],
        hasSpec: mod.hasSpecs,
        attributes: attributeNames(mod.attributes),
        locationFidelity: mod.file ? 'precise' : 'package',
      },
    });

    for (const friend of arr(mod.friends)) {
      pendingFriends.push({ moduleNodeId, friend: friend.module });
    }

    // Functions
    for (const fn of arr(mod.functions)) {
      const fnQualified = `${moduleQualified}::${fn.name}`;
      const fnFile = moveRepoRelativePath(fn.file ?? moduleFileAbs, repoPath);
      const fnNodeId = moveFunctionNodeId(fnQualified, fnFile);
      functionNodeMap.set(fnQualified, fnNodeId);
      const attrs = attributeNames(fn.attributes);
      nodes.push({
        id: fnNodeId,
        label: 'Function',
        properties: {
          name: fn.name,
          filePath: fnFile,
          language: MOVE_LANGUAGE,
          qualifiedName: fnQualified,
          moduleQualifiedName: moduleQualified,
          moduleAddress: address,
          startLine: fn.span?.[0],
          endLine: fn.span?.[1],
          visibility: fn.visibility,
          visibilityModifier: fn.visibility,
          isEntry: fn.isEntry,
          isView: fn.isView,
          isInline: fn.isInline,
          isNative: fn.isNative,
          isInitModule: fn.name === 'init_module',
          isTest: attrs.includes(MOVE_ATTR.TEST),
          isTestOnly: attrs.includes(MOVE_ATTR.TEST_ONLY),
          hasSpec: fn.hasSpec,
          attributes: attrs,
          typeParams: mapTypeParams(fn.typeParams),
          acquires: arr(fn.acquiresInferred),
          returnType: fn.returnType ?? undefined,
          parameterCount: arr(fn.params).length,
          locationFidelity: fn.file ? 'precise' : 'package',
        },
      });
      edge(moduleNodeId, fnNodeId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesFunction);

      for (const r of arr(fn.resourceAccess?.reads)) {
        pendingResource.push({
          fnNodeId,
          moduleQualified,
          type: 'READS_RESOURCE',
          target: stripTypeArgs(r),
          qualified: false,
        });
      }
      for (const w of arr(fn.resourceAccess?.writes)) {
        pendingResource.push({
          fnNodeId,
          moduleQualified,
          type: 'WRITES_RESOURCE',
          target: stripTypeArgs(w),
          qualified: false,
        });
      }
      for (const a of arr(fn.acquiresInferred)) {
        pendingResource.push({
          fnNodeId,
          moduleQualified,
          type: 'ACQUIRES',
          target: a,
          qualified: true,
        });
      }
    }

    // Types (structs + enums)
    for (const ty of arr(mod.types)) {
      const tyQualified = `${moduleQualified}::${ty.name}`;
      const tyFile = moveRepoRelativePath(ty.file ?? moduleFileAbs, repoPath);
      const attrs = attributeNames(ty.attributes);
      if (ty.kind === 'struct') {
        const structNodeId = moveStructNodeId(tyQualified, tyFile);
        structNodeMap.set(tyQualified, structNodeId);
        nodes.push({
          id: structNodeId,
          label: 'Struct',
          properties: {
            name: ty.name,
            filePath: tyFile,
            language: MOVE_LANGUAGE,
            qualifiedName: tyQualified,
            moduleQualifiedName: moduleQualified,
            moduleAddress: address,
            startLine: ty.span?.[0],
            endLine: ty.span?.[1],
            abilities: arr(ty.abilities),
            isResource: arr(ty.abilities).includes(MOVE_ABILITY.KEY),
            isEvent: attrs.includes(MOVE_ATTR.EVENT),
            isTestOnly: attrs.includes(MOVE_ATTR.TEST_ONLY),
            hasSpec: ty.hasSpec,
            attributes: attrs,
            typeParams: mapTypeParams(ty.typeParams),
            fields: (ty.fields ?? []).map((f) => ({
              name: f.name,
              type: f.type,
              positional: f.positional,
            })),
            // STRING[] projection persisted to lbug (`fieldList` column).
            fieldList: (ty.fields ?? []).map((f) => `${f.name}: ${f.type}`),
            moveDeclarationKind: 'struct',
            locationFidelity: ty.file ? 'precise' : 'package',
          },
        });
        edge(moduleNodeId, structNodeId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesStruct);
      } else {
        const eId = moveEnumNodeId(tyQualified, tyFile);
        structNodeMap.set(tyQualified, eId);
        nodes.push({
          id: eId,
          label: 'Enum',
          properties: {
            name: ty.name,
            filePath: tyFile,
            language: MOVE_LANGUAGE,
            qualifiedName: tyQualified,
            moduleQualifiedName: moduleQualified,
            moduleAddress: address,
            startLine: ty.span?.[0],
            endLine: ty.span?.[1],
            abilities: arr(ty.abilities),
            hasSpec: ty.hasSpec,
            attributes: attrs,
            typeParams: mapTypeParams(ty.typeParams),
            moveDeclarationKind: 'enum',
            locationFidelity: ty.file ? 'precise' : 'package',
          },
        });
        edge(moduleNodeId, eId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesEnum);
        for (const variant of arr(ty.variants)) {
          const vId = moveEnumVariantNodeId(tyQualified, variant.name, tyFile);
          nodes.push({
            id: vId,
            label: 'EnumVariant',
            properties: {
              name: variant.name,
              filePath: tyFile,
              language: MOVE_LANGUAGE,
              qualifiedName: `${tyQualified}::${variant.name}`,
              parentEnum: tyQualified,
              moduleQualifiedName: moduleQualified,
              variantKind: variant.kind,
              fields: arr(variant.fields).map((f) => ({
                name: f.name,
                type: f.type,
                positional: f.positional,
              })),
              attributes: attributeNames(variant.attributes),
              locationFidelity: ty.file ? 'precise' : 'package',
            },
          });
          edge(eId, vId, 'CONTAINS', 1.0, MOVE_EDGE_REASON.containsVariant);
        }
      }
    }

    // Constants
    for (const c of arr(mod.constants)) {
      const cQualified = `${moduleQualified}::${c.name}`;
      const cNodeId = moveConstNodeId(cQualified, file);
      nodes.push({
        id: cNodeId,
        label: 'Const',
        properties: {
          name: c.name,
          filePath: file,
          language: MOVE_LANGUAGE,
          qualifiedName: cQualified,
          moduleQualifiedName: moduleQualified,
          declaredType: c.type,
          value: c.value,
          isErrorCode: ERROR_CODE_PATTERN.test(c.name),
          locationFidelity: mod.file ? 'precise' : 'package',
        },
      });
      edge(moduleNodeId, cNodeId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesConst);
    }
  }

  // ── Pass B: resolve resource + friend edges against the full index ───────
  // Prebuild a local-name → node-id[] index once, so resolveStruct is O(1)
  // instead of scanning structNodeMap per pending edge (etna-scale hotspot).
  const structIdsByLocalName = new Map<string, string[]>();
  for (const [qn, id] of structNodeMap) {
    const local = localName(qn);
    const list = structIdsByLocalName.get(local);
    if (list) list.push(id);
    else structIdsByLocalName.set(local, [id]);
  }
  const resolveStruct = (localOrQualified: string, callerModule: string): string | undefined => {
    // Fully-qualified hit (e.g. acquiresInferred values).
    const exact = structNodeMap.get(localOrQualified);
    if (exact) return exact;
    const base = stripTypeArgs(localOrQualified);
    // Same-module preference.
    const sameModule = structNodeMap.get(`${callerModule}::${base}`);
    if (sameModule) return sameModule;
    // Unique local-name match across the package.
    const matches = structIdsByLocalName.get(localName(base)) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  };

  const seenResourceEdges = new Set<string>();
  for (const pr of pendingResource) {
    const targetId = resolveStruct(pr.target, pr.moduleQualified);
    if (!targetId) continue; // resource in a dependency / unresolved — skip dangling edge
    // Dedupe: `CoinStore<A>` and `CoinStore<B>` (or read+acquire of one struct)
    // collapse to the same edge.
    const key = `${pr.fnNodeId}\0${pr.type}\0${targetId}`;
    if (seenResourceEdges.has(key)) continue;
    seenResourceEdges.add(key);
    edge(pr.fnNodeId, targetId, pr.type, 1.0, `move-${pr.type.toLowerCase()}`);
  }

  for (const pf of pendingFriends) {
    const friendFile = moduleFileMap.get(pf.friend);
    if (!friendFile) continue; // cross-package friend — target node not in this graph slice
    const friendNodeId = moveModuleNodeId(pf.friend, friendFile);
    edge(pf.moduleNodeId, friendNodeId, 'FRIEND_OF', 1.0, MOVE_EDGE_REASON.friend);
  }

  return { nodes, edges, moduleFileMap, functionNodeMap, structNodeMap };
}

// Re-export for callers that prefer the label type.
export type { NodeLabel };
