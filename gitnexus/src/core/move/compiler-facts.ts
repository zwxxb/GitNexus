/**
 * Normalized compiler facts for Move.
 *
 * `move-flow` is the authoritative source for package/module/function facts.
 * This module keeps the raw MCP shapes in one place and exposes a stable,
 * parsed representation that downstream projections can consume without
 * re-querying move-flow or reparsing signatures independently.
 */

import { parseMoveSignature, type ParsedMoveSignature } from './signature-parser.js';

export interface MoveFlowManifest {
  source_paths: string[];
  dep_paths: string[];
}

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

export interface MoveFlowFunctionUsage {
  called: string[];
  called_transitive?: string[];
  used: string[];
  used_transitive?: string[];
}

export interface MoveFunctionFact {
  qualifiedName: string;
  moduleQualifiedName: string;
  packageRoot: string;
  raw: MoveFlowFunction;
  parsed: ParsedMoveSignature;
}

export interface MoveModuleFact {
  qualifiedName: string;
  packageRoot: string;
  raw: MoveFlowModuleSummary;
  functions: MoveFunctionFact[];
}

export interface MovePackageFacts {
  packageRoot: string;
  manifest: MoveFlowManifest;
  moduleSummary: ModuleSummaryMap;
  callGraph: CallGraphMap;
  modules: MoveModuleFact[];
}

export interface MoveCompilerFacts {
  packages: ReadonlyMap<string, MovePackageFacts>;
  modulesByQualifiedName: ReadonlyMap<string, MoveModuleFact>;
  functionsByQualifiedName: ReadonlyMap<string, MoveFunctionFact>;
}

export function createEmptyMoveCompilerFacts(): MoveCompilerFacts {
  return {
    packages: new Map(),
    modulesByQualifiedName: new Map(),
    functionsByQualifiedName: new Map(),
  };
}

export function buildMovePackageFacts(input: {
  packageRoot: string;
  manifest: MoveFlowManifest;
  moduleSummary: ModuleSummaryMap;
  callGraph: CallGraphMap;
}): MovePackageFacts {
  const modules: MoveModuleFact[] = [];
  for (const [moduleQualifiedName, rawModule] of Object.entries(input.moduleSummary)) {
    const functions: MoveFunctionFact[] = rawModule.functions.map((fn) => {
      const parsed = parseMoveSignature(fn.signature);
      return {
        qualifiedName: `${moduleQualifiedName}::${parsed.name || fn.name}`,
        moduleQualifiedName,
        packageRoot: input.packageRoot,
        raw: fn,
        parsed,
      };
    });
    modules.push({
      qualifiedName: moduleQualifiedName,
      packageRoot: input.packageRoot,
      raw: rawModule,
      functions,
    });
  }

  return {
    packageRoot: input.packageRoot,
    manifest: input.manifest,
    moduleSummary: input.moduleSummary,
    callGraph: input.callGraph,
    modules,
  };
}

export function mergeMovePackageFacts(
  facts: MoveCompilerFacts,
  packageFacts: MovePackageFacts,
): MoveCompilerFacts {
  const packages = new Map(facts.packages);
  const modulesByQualifiedName = new Map(facts.modulesByQualifiedName);
  const functionsByQualifiedName = new Map(facts.functionsByQualifiedName);

  packages.set(packageFacts.packageRoot, packageFacts);
  for (const moduleFact of packageFacts.modules) {
    modulesByQualifiedName.set(moduleFact.qualifiedName, moduleFact);
    for (const fn of moduleFact.functions) {
      if (fn.parsed.name) functionsByQualifiedName.set(fn.qualifiedName, fn);
    }
  }

  return {
    packages,
    modulesByQualifiedName,
    functionsByQualifiedName,
  };
}
