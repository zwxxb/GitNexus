/**
 * Canonical Move symbol identity helpers.
 *
 * Move symbols need the fully-qualified address/module path in their graph IDs.
 * File path + local name is not unique when a file contains multiple modules or
 * two named-address packages expose the same local names.
 */

export interface ParsedMoveModuleName {
  address: string;
  moduleName: string;
}

export function parseMoveModuleQualifiedName(qualifiedName: string): ParsedMoveModuleName {
  const sep = qualifiedName.indexOf('::');
  if (sep === -1) return { address: '', moduleName: qualifiedName };
  return { address: qualifiedName.slice(0, sep), moduleName: qualifiedName.slice(sep + 2) };
}

export function moveModuleQualifiedName(symbolQualifiedName: string): string {
  const sep = symbolQualifiedName.lastIndexOf('::');
  return sep === -1 ? symbolQualifiedName : symbolQualifiedName.slice(0, sep);
}

export function moveLocalName(qualifiedName: string): string {
  const sep = qualifiedName.lastIndexOf('::');
  return sep === -1 ? qualifiedName : qualifiedName.slice(sep + 2);
}

export function moveShortSymbol(qualifiedName: string): string {
  const moduleQualified = moveModuleQualifiedName(qualifiedName);
  const { moduleName } = parseMoveModuleQualifiedName(moduleQualified);
  return `${moduleName}::${moveLocalName(qualifiedName)}`;
}

export function moveModuleNodeId(moduleQualifiedName: string, filePath: string): string {
  return `Module:${filePath}:${moduleQualifiedName}`;
}

export function moveFunctionNodeId(functionQualifiedName: string, filePath: string): string {
  return `Function:${filePath}:${functionQualifiedName}`;
}

export function moveStructNodeId(structQualifiedName: string, filePath: string): string {
  return `Struct:${filePath}:${structQualifiedName}`;
}

export function moveConstNodeId(constQualifiedName: string, filePath: string): string {
  return `Const:${filePath}:${constQualifiedName}`;
}

export function moveEnumVariantNodeId(
  enumQualifiedName: string,
  variantName: string,
  filePath: string,
): string {
  return `EnumVariant:${filePath}:${enumQualifiedName}::${variantName}`;
}
