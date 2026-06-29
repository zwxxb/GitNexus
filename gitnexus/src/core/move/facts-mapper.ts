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
  moveLocalName,
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
import { extractTypeNames } from './type-parser.js';

export interface MoveFactsMapResult {
  nodes: GraphNode[];
  edges: GraphRelationship[];
  /** Module qualified name → source file path. */
  moduleFileMap: Map<string, string>;
  /** Function qualified name → graph node ID. */
  functionNodeMap: Map<string, string>;
  /** Struct/enum qualified name → graph node ID. */
  structNodeMap: Map<string, string>;
  /** Resource edges that need the full cross-package type index. */
  pendingResource: PendingResource[];
  /** Friend edges that need the full cross-package module index. */
  pendingFriends: PendingFriend[];
  /** Signature type refs that need the full cross-package type index. */
  pendingTypeRef: PendingTypeRef[];
}

export interface PendingResource {
  fnNodeId: string;
  moduleQualified: string;
  type: RelationshipType;
  target: string;
  reason: string;
}

export interface PendingFriend {
  moduleNodeId: string;
  friend: string;
}

export interface PendingTypeRef {
  fnNodeId: string;
  moduleQualified: string;
  target: string;
  reason: string;
}

/** Strip generic type arguments: `CoinStore<CoinType>` → `CoinStore`. */
function stripTypeArgs(typeName: string): string {
  const idx = typeName.indexOf('<');
  return (idx === -1 ? typeName : typeName.slice(0, idx)).trim();
}

/** Defensive: move-flow omits optional array fields for some symbols. */
function arr<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function typeParamsJson(typeParams: MoveFactsTypeParam[] | null | undefined): string {
  const list = arr(typeParams).map((tp) => ({
    name: tp.name,
    constraints: arr(tp.abilities),
    isPhantom: tp.isPhantom,
  }));
  return JSON.stringify(list);
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
  const pendingResource: PendingResource[] = [];
  const pendingFriends: PendingFriend[] = [];
  const pendingTypeRef: PendingTypeRef[] = [];

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
      const seenTypeRefs = new Set<string>();
      const addSignatureTypes = (typeExpr: string | null | undefined, reason: string): void => {
        if (!typeExpr) return;
        for (const typeName of extractTypeNames(typeExpr)) {
          const key = `${reason}\0${typeName}`;
          if (seenTypeRefs.has(key)) continue;
          seenTypeRefs.add(key);
          pendingTypeRef.push({ fnNodeId, moduleQualified, target: typeName, reason });
        }
      };
      for (const p of arr(fn.params)) {
        addSignatureTypes(p.type, MOVE_EDGE_REASON.fnParamType);
      }
      addSignatureTypes(fn.returnType, MOVE_EDGE_REASON.fnReturnType);
      nodes.push({
        id: fnNodeId,
        label: 'Function',
        properties: {
          name: fn.name,
          filePath: fnFile,
          language: MOVE_LANGUAGE,
          qualifiedName: fnQualified,
          moduleQualifiedName: moduleQualified,
          startLine: fn.span?.[0],
          endLine: fn.span?.[1],
          visibility: fn.visibility,
          visibilityModifier: fn.visibility,
          isEntry: fn.isEntry,
          isView: fn.isView,
          isInline: fn.isInline,
          isNative: fn.isNative,
          isInitModule: fn.name === 'init_module',
          hasSpec: fn.hasSpec,
          attributes: attrs,
          typeParamsJson: typeParamsJson(fn.typeParams),
          acquires: arr(fn.acquiresInferred),
          usedTypes: [],
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
          reason: MOVE_EDGE_REASON.readsResource,
        });
      }
      for (const w of arr(fn.resourceAccess?.writes)) {
        pendingResource.push({
          fnNodeId,
          moduleQualified,
          type: 'WRITES_RESOURCE',
          target: stripTypeArgs(w),
          reason: MOVE_EDGE_REASON.writesResource,
        });
      }
      for (const a of arr(fn.acquiresInferred)) {
        pendingResource.push({
          fnNodeId,
          moduleQualified,
          type: 'ACQUIRES',
          target: a,
          reason: MOVE_EDGE_REASON.acquires,
        });
      }
    }

    // Types (structs + enums)
    for (const ty of arr(mod.structs)) {
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
            hasSpec: ty.hasSpec,
            attributes: attrs,
            typeParamsJson: typeParamsJson(ty.typeParams),
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
            isResource: arr(ty.abilities).includes(MOVE_ABILITY.KEY),
            isEvent: attrs.includes(MOVE_ATTR.EVENT),
            hasSpec: ty.hasSpec,
            attributes: attrs,
            typeParamsJson: typeParamsJson(ty.typeParams),
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
              fieldsJson: JSON.stringify(
                arr(variant.fields).map((f) => ({
                  name: f.name,
                  type: f.type,
                  positional: f.positional,
                })),
              ),
              attributes: attributeNames(variant.attributes),
              locationFidelity: ty.file ? 'module' : 'package',
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
          constType: c.type,
          constValue: c.value,
          isErrorCode: ERROR_CODE_PATTERN.test(c.name),
          locationFidelity: mod.file ? 'module' : 'package',
        },
      });
      edge(moduleNodeId, cNodeId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesConst);
    }
  }

  return {
    nodes,
    edges,
    moduleFileMap,
    functionNodeMap,
    structNodeMap,
    pendingResource,
    pendingFriends,
    pendingTypeRef,
  };
}

export function buildLocalNameIndex(structNodeMap: ReadonlyMap<string, string>): Map<string, string[]> {
  const structIdsByLocalName = new Map<string, string[]>();
  for (const [qn, id] of structNodeMap) {
    const key = moveLocalName(qn);
    const list = structIdsByLocalName.get(key);
    if (list) list.push(id);
    else structIdsByLocalName.set(key, [id]);
  }
  return structIdsByLocalName;
}

function resolveStructRef(
  localOrQualified: string,
  callerModule: string,
  structNodeMap: ReadonlyMap<string, string>,
  structIdsByLocalName: ReadonlyMap<string, readonly string[]>,
): { targetId: string } | { unresolved: true } | { ambiguous: true } {
  const exact = structNodeMap.get(localOrQualified);
  if (exact) return { targetId: exact };

  const base = stripTypeArgs(localOrQualified);
  const sameModule = structNodeMap.get(`${callerModule}::${base}`);
  if (sameModule) return { targetId: sameModule };

  const matches = structIdsByLocalName.get(moveLocalName(base)) ?? [];
  if (matches.length === 1) return { targetId: matches[0] };
  return matches.length > 1 ? { ambiguous: true } : { unresolved: true };
}

export function resolveResourceEdges(
  pendingResource: readonly PendingResource[],
  structNodeMap: ReadonlyMap<string, string>,
  structIdsByLocalName: ReadonlyMap<string, readonly string[]>,
  edgeSink: (rel: GraphRelationship) => void,
  onUnresolved?: (pending: PendingResource) => void,
  onAmbiguous?: (pending: PendingResource) => void,
): void {
  const seenResourceEdges = new Set<string>();
  for (const pr of pendingResource) {
    const resolved = resolveStructRef(
      pr.target,
      pr.moduleQualified,
      structNodeMap,
      structIdsByLocalName,
    );
    if ('unresolved' in resolved) {
      onUnresolved?.(pr);
      continue;
    }
    if ('ambiguous' in resolved) {
      onAmbiguous?.(pr);
      continue;
    }

    const key = `${pr.fnNodeId}\0${pr.type}\0${resolved.targetId}`;
    if (seenResourceEdges.has(key)) continue;
    seenResourceEdges.add(key);
    edgeSink({
      id: `rel:${randomUUID()}`,
      sourceId: pr.fnNodeId,
      targetId: resolved.targetId,
      type: pr.type,
      confidence: 1.0,
      reason: pr.reason,
    });
  }
}

export function resolveFriendEdges(
  pendingFriends: readonly PendingFriend[],
  moduleFileMap: ReadonlyMap<string, string>,
  edgeSink: (rel: GraphRelationship) => void,
): void {
  for (const pf of pendingFriends) {
    const friendFile = moduleFileMap.get(pf.friend);
    if (!friendFile) continue;
    edgeSink({
      id: `rel:${randomUUID()}`,
      sourceId: pf.moduleNodeId,
      targetId: moveModuleNodeId(pf.friend, friendFile),
      type: 'FRIEND_OF',
      confidence: 1.0,
      reason: MOVE_EDGE_REASON.friend,
    });
  }
}

export function resolveTypeRefEdges(
  pendingTypeRef: readonly PendingTypeRef[],
  structNodeMap: ReadonlyMap<string, string>,
  structIdsByLocalName: ReadonlyMap<string, readonly string[]>,
  edgeSink: (rel: GraphRelationship) => void,
  onUnresolved?: (pending: PendingTypeRef) => void,
  onAmbiguous?: (pending: PendingTypeRef) => void,
): void {
  const seenTypeEdges = new Set<string>();
  for (const pr of pendingTypeRef) {
    const resolved = resolveStructRef(
      pr.target,
      pr.moduleQualified,
      structNodeMap,
      structIdsByLocalName,
    );
    if ('unresolved' in resolved) {
      onUnresolved?.(pr);
      continue;
    }
    if ('ambiguous' in resolved) {
      onAmbiguous?.(pr);
      continue;
    }

    const key = `${pr.fnNodeId}\0${pr.reason}\0${resolved.targetId}`;
    if (seenTypeEdges.has(key)) continue;
    seenTypeEdges.add(key);
    edgeSink({
      id: `rel:${randomUUID()}`,
      sourceId: pr.fnNodeId,
      targetId: resolved.targetId,
      type: 'USES_TYPE',
      confidence: 1.0,
      reason: pr.reason,
    });
  }
}

// Re-export for callers that prefer the label type.
export type { NodeLabel };
