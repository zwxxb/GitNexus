/**
 * Normalized compiler facts for Move.
 *
 * `move-flow` is the authoritative source for package/module/function facts.
 * This module keeps the raw MCP shapes in one place and exposes a stable,
 * parsed representation that downstream projections can consume without
 * re-querying move-flow or reparsing signatures independently.
 */

import { parseMoveSignature } from './signature-parser.js';

export interface MoveFlowConstant {
  name: string;
  type: string;
  value: string;
}

export interface MoveFlowStruct {
  name: string;
  abilities: string[];
  fields: string[];
}

export interface MoveFlowFunction {
  name: string;
  signature: string;
}

export interface MoveFlowModuleSummary {
  constants: MoveFlowConstant[];
  structs: MoveFlowStruct[];
  functions: MoveFlowFunction[];
}

export type ModuleSummaryMap = Record<string, MoveFlowModuleSummary>;
export type CallGraphMap = Record<string, string[]>;

// ─────────────────────────────────────────────────────────────────────────
// move-flow `facts` query — full-fidelity, compiler-sourced per-module facts.
//
// Shape mirrors the live `move_package_query { query: "facts" }` response
// (move-flow >= the release that integrated the facts query). These types are
// the source of truth for the thin facts→graph mapper; the `module_summary`
// types above remain the capability-gated fallback when facts is unavailable.
// ─────────────────────────────────────────────────────────────────────────

/** A generic type parameter as reported by the facts query. */
export interface MoveFactsTypeParam {
  name: string;
  abilities: string[];
  isPhantom: boolean;
}

/** A struct field or enum-variant field. */
export interface MoveFactsField {
  /** Field name, or the positional index (`"0"`, `"1"`, …) for positional fields. */
  name: string;
  type: string;
  positional: boolean;
}

/** A parsed attribute, e.g. `{ name: "view" }`, `{ name: "event" }`. */
export interface MoveFactsAttribute {
  name: string;
  [key: string]: unknown;
}

/** A `friend` declaration target. */
export interface MoveFactsFriend {
  module: string;
}

/** One enum variant. */
export interface MoveFactsVariant {
  name: string;
  kind: 'unit' | 'positional' | 'named';
  fields: MoveFactsField[];
  attributes: MoveFactsAttribute[];
}

/** A declared access specifier (Move 2 `acquires`/`reads`/`writes` clauses). */
export interface MoveFactsDeclaredAccess {
  kind: string;
  resource: { form: string; value: string };
  negated: boolean;
  [key: string]: unknown;
}

/** AST-derived resource access for a function. Values are type expressions
 *  such as `"CoinStore<CoinType>"` (not necessarily fully qualified). */
export interface MoveFactsResourceAccess {
  reads: string[];
  writes: string[];
}

/** A function as reported by the facts query. */
export interface MoveFactsFunction {
  name: string;
  file?: string;
  span?: [number, number];
  visibility: 'public' | 'friend' | 'internal' | 'package' | string;
  isEntry: boolean;
  isInline: boolean;
  isNative: boolean;
  isView: boolean;
  attributes: MoveFactsAttribute[];
  typeParams: MoveFactsTypeParam[];
  params: { name: string; type: string }[];
  returnType: string | null;
  declaredAccess: MoveFactsDeclaredAccess[];
  /** Fully-qualified resource names the function acquires (e.g. `0xa::coin::CoinStore`). */
  acquiresInferred: string[];
  resourceAccess: MoveFactsResourceAccess;
  hasSpec: boolean;
}

/** A struct or enum as reported by the facts query. */
export interface MoveFactsType {
  kind: 'struct' | 'enum';
  name: string;
  file?: string;
  span?: [number, number];
  abilities: string[];
  typeParams: MoveFactsTypeParam[];
  /** Present for structs. */
  fields?: MoveFactsField[];
  /** Present for enums. */
  variants?: MoveFactsVariant[];
  attributes: MoveFactsAttribute[];
  hasSpec: boolean;
}

/** Per-module facts. */
export interface MoveFactsModule {
  file?: string;
  span?: [number, number];
  friends: MoveFactsFriend[];
  attributes: MoveFactsAttribute[];
  hasSpecs: boolean;
  functions: MoveFactsFunction[];
  types: MoveFactsType[];
  constants: MoveFlowConstant[];
}

/** The full facts query response: qualified module name → facts. */
export type MoveFactsMap = Record<string, MoveFactsModule>;

// ─────────────────────────────────────────────────────────────────────────
// Fallback: adapt the legacy `module_summary` shape to the `facts` shape so a
// single graph mapper serves both paths. `module_summary` lacks per-symbol
// locations, attributes, acquires, resource access, friends, and enum variants,
// so those degrade to empty (callers mark `locationFidelity: 'package'`).
// ─────────────────────────────────────────────────────────────────────────

/** Parse a `"name: type"` struct-field string into a structured field. */
function parseSummaryField(field: string): MoveFactsField {
  const idx = field.indexOf(':');
  if (idx === -1) return { name: field.trim(), type: '', positional: false };
  return { name: field.slice(0, idx).trim(), type: field.slice(idx + 1).trim(), positional: false };
}

/** Adapt a `module_summary` response to the `facts` shape (degraded fidelity). */
export function moduleSummaryToFacts(summary: ModuleSummaryMap): MoveFactsMap {
  const out: MoveFactsMap = {};
  for (const [moduleQualifiedName, mod] of Object.entries(summary)) {
    const functions: MoveFactsFunction[] = [];
    for (const fn of mod.functions) {
      const parsed = parseMoveSignature(fn.signature);
      if (!parsed.name) continue; // unparseable signature — skip (no orphan node)
      functions.push({
        name: parsed.name,
        visibility: parsed.visibility,
        isEntry: parsed.isEntry,
        isInline: false,
        isNative: false,
        isView: false,
        attributes: [],
        typeParams: parsed.typeParams.map((tp) => ({
          name: tp.name,
          abilities: tp.constraints,
          isPhantom: tp.isPhantom,
        })),
        params: parsed.parameters,
        returnType: parsed.returnType,
        declaredAccess: [],
        acquiresInferred: parsed.acquires,
        resourceAccess: { reads: [], writes: [] },
        hasSpec: false,
      });
    }
    // module_summary cannot distinguish enums from structs, so everything is a struct.
    const types: MoveFactsType[] = mod.structs.map((s) => ({
      kind: 'struct',
      name: s.name,
      abilities: s.abilities,
      typeParams: [],
      fields: s.fields.map(parseSummaryField),
      attributes: [],
      hasSpec: false,
    }));
    out[moduleQualifiedName] = {
      friends: [],
      attributes: [],
      hasSpecs: false,
      functions,
      types,
      constants: mod.constants,
    };
  }
  return out;
}
