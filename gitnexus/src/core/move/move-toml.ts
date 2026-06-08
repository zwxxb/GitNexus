/**
 * Minimal Move.toml resolver used by the Move source index.
 *
 * This intentionally handles the package metadata GitNexus needs for source
 * evidence: `[addresses]`, `[dev-addresses]`, local dependencies, and
 * `addr_subst`. It is not a general TOML implementation.
 */

import * as path from 'node:path';

export interface MoveDependencySpec {
  localPath: string | null;
  addrSubst: Record<string, string>;
}

export interface MoveManifestInfo {
  dir: string;
  packageRoot: string;
  addresses: Record<string, string>;
  devAddresses: Record<string, string>;
  dependencies: MoveDependencySpec[];
}

export function extractMoveAddresses(body: string): Record<string, string> {
  return {
    ...extractAddressSection(body, 'addresses'),
    ...extractAddressSection(body, 'dev-addresses'),
  };
}

export function parseMoveManifest(
  body: string,
  dir: string,
  packageRoot: string,
): MoveManifestInfo {
  return {
    dir,
    packageRoot,
    addresses: extractAddressSection(body, 'addresses'),
    devAddresses: extractAddressSection(body, 'dev-addresses'),
    dependencies: [
      ...extractDependencies(body, 'dependencies'),
      ...extractDependencies(body, 'dev-dependencies'),
    ],
  };
}

export function buildAddressTableForManifest(
  manifest: MoveManifestInfo,
  manifestsByPackageRoot: ReadonlyMap<string, MoveManifestInfo>,
  visiting: Set<string>,
): Record<string, string> {
  if (visiting.has(manifest.packageRoot)) return {};
  visiting.add(manifest.packageRoot);
  const table: Record<string, string> = {
    ...manifest.addresses,
    ...manifest.devAddresses,
  };

  for (const dep of manifest.dependencies) {
    const depRoot = dep.localPath ? path.resolve(manifest.packageRoot, dep.localPath) : null;
    const depManifest = depRoot ? manifestsByPackageRoot.get(depRoot) : undefined;
    const depAddresses = depManifest
      ? buildAddressTableForManifest(depManifest, manifestsByPackageRoot, new Set(visiting))
      : {};
    const renamedTargets = new Set(
      Object.entries(dep.addrSubst)
        .filter(([alias, target]) => alias !== target && !isMoveAddressLiteral(target))
        .map(([, target]) => target),
    );

    for (const [name, value] of Object.entries(depAddresses)) {
      if (!renamedTargets.has(name) && table[name] == null) table[name] = value;
    }

    for (const [alias, target] of Object.entries(dep.addrSubst)) {
      table[alias] = isMoveAddressLiteral(target) ? target : (depAddresses[target] ?? target);
    }
  }

  visiting.delete(manifest.packageRoot);
  return table;
}

function extractAddressSection(body: string, sectionName: string): Record<string, string> {
  const out: Record<string, string> = {};
  const section = sectionBody(body, sectionName);
  if (!section) return out;
  for (const line of section.split(/\r?\n/)) {
    const parsed = parseTomlAssignment(line);
    if (parsed) out[parsed.key] = parsed.value;
  }
  return out;
}

function extractDependencies(body: string, sectionName: string): MoveDependencySpec[] {
  const section = sectionBody(body, sectionName);
  if (!section) return [];
  const deps: MoveDependencySpec[] = [];
  for (const assignment of topLevelTomlAssignments(section)) {
    const objectStart = assignment.indexOf('{');
    const objectEnd = assignment.lastIndexOf('}');
    if (objectStart === -1 || objectEnd <= objectStart) continue;
    const objectBody = assignment.slice(objectStart + 1, objectEnd);
    const localMatch = objectBody.match(/\blocal\s*=\s*(["'])(.*?)\1/);
    const addrSubst = extractAddrSubst(objectBody);
    deps.push({
      localPath: localMatch?.[2] ?? null,
      addrSubst,
    });
  }
  return deps;
}

function topLevelTomlAssignments(section: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    current = current ? `${current} ${line}` : line;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote && line[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    if (depth === 0) {
      out.push(current);
      current = '';
    }
  }
  if (current) out.push(current);
  return out.filter((assignment) => assignment.includes('='));
}

function extractAddrSubst(objectBody: string): Record<string, string> {
  const start = objectBody.search(/\baddr_subst\s*=/);
  if (start === -1) return {};
  const braceStart = objectBody.indexOf('{', start);
  if (braceStart === -1) return {};
  const braceEnd = findInlineMatchingBrace(objectBody, braceStart);
  if (braceEnd === -1) return {};
  const inner = objectBody.slice(braceStart + 1, braceEnd);
  const out: Record<string, string> = {};
  for (const piece of inner.split(',')) {
    const parsed = parseTomlAssignment(piece);
    if (parsed) out[parsed.key] = parsed.value;
  }
  return out;
}

function findInlineMatchingBrace(source: string, openBrace: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote && source[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isMoveAddressLiteral(value: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(value) || value === '_';
}

function sectionBody(body: string, sectionName: string): string | null {
  const lines = body.split(/\r?\n/);
  let inSection = false;
  const sectionLines: string[] = [];
  for (const line of lines) {
    const trimmed = stripTomlComment(line).trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (inSection) break;
      inSection = trimmed === `[${sectionName}]`;
      continue;
    }
    if (inSection) sectionLines.push(line);
  }
  return inSection || sectionLines.length > 0 ? sectionLines.join('\n') : null;
}

function parseTomlAssignment(line: string): { key: string; value: string } | null {
  const cleaned = stripTomlComment(line).trim();
  const eq = cleaned.indexOf('=');
  if (eq === -1) return null;
  const key = unquoteTomlScalar(cleaned.slice(0, eq).trim());
  const rest = cleaned.slice(eq + 1).trim();
  if (!key) return null;
  const value = readTomlScalar(rest);
  return value == null ? null : { key, value };
}

function readTomlScalar(rest: string): string | null {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    if (end === -1) return null;
    return rest.slice(1, end);
  }
  const match = /^([A-Za-z_][A-Za-z0-9_]*|0x[0-9a-fA-F]+|_)/.exec(rest);
  return match?.[1] ?? null;
}

function unquoteTomlScalar(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}
