/**
 * Move function signature parser.
 *
 * Parses move-flow module_summary signature strings into structured data.
 * Signatures follow the pattern:
 *   "<visibility> [entry] fun <name>[<T: ability>](<params>)[: <returnType>] [acquires R1, R2]"
 *
 * Examples:
 *   "public entry fun place_order(user: &signer, size: u64): u64"
 *   "friend fun initialize(admin: &signer)"
 *   "private entry fun increment_time(account: &signer, increment_microseconds: u64)"
 *   "public fun transfer(f: |u64| u64 has copy + drop, x: u64): u64"
 *   "public fun borrow<T: key + store>(id: u64): &T acquires Store"
 */

export interface TypeParam {
  name: string;
  /** Ability constraints, e.g. ["key", "store"]. Empty for unconstrained. */
  constraints: string[];
  /** True when the type parameter is phantom (not used in function body). */
  isPhantom: boolean;
}

export interface ParsedMoveSignature {
  visibility: 'public' | 'friend' | 'package' | 'private';
  /** Contents of legacy restricted visibility, e.g. `friend` in `public(friend)`. */
  visibilityModifier?: string;
  isEntry: boolean;
  name: string;
  /** Generic type parameters, e.g. `<T: key + store, phantom U>`. */
  typeParams: TypeParam[];
  parameters: { name: string; type: string }[];
  returnType: string | null;
  /** Resources this function acquires from global storage, e.g. ["Balance", "Store"]. */
  acquires: string[];
}

/**
 * Find the matching closing delimiter for a given opening one,
 * handling nested `<>`, `()`, `||` (lambda types).
 */
function findMatchingClose(s: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a parameter list string by commas, respecting nested `<>`, `()`, and
 * lambda types `|...|` (including nested lambdas like `|x: |u64, address| u64|
 * u64`).  Returns raw "name: type" fragments.
 *
 * `|` is ambiguous (open or close), so we disambiguate by inspecting the
 * previous non-whitespace character: if it's a type-position boundary
 * (`:`, `,`, `(`, `<`, or beginning of string), the pipe opens a lambda;
 * otherwise it closes one.  This handles single-arg, multi-arg, zero-arg
 * (`||`), and nested lambda types correctly for signatures emitted by
 * move-flow.
 */
function splitParams(paramStr: string): string[] {
  const parts: string[] = [];
  let bracketDepth = 0;
  let lambdaDepth = 0;
  let current = '';
  let prevNonWs = '';
  const opensLambdaAfter = (c: string) => c === '' || ':,(<'.includes(c);

  for (let i = 0; i < paramStr.length; i++) {
    const ch = paramStr[i];
    if (ch === '<' || ch === '(') {
      bracketDepth++;
      current += ch;
    } else if (ch === '>' || ch === ')') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += ch;
    } else if (ch === '|') {
      const prevCh = i > 0 ? paramStr[i - 1] : '';
      if (opensLambdaAfter(prevNonWs) || (prevNonWs === '|' && /\s/.test(prevCh))) {
        lambdaDepth++;
      } else {
        lambdaDepth = Math.max(0, lambdaDepth - 1);
      }
      current += ch;
    } else if (ch === ',' && bracketDepth === 0 && lambdaDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '\n') {
      prevNonWs = ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

/**
 * Extract the parameter block from a signature string.
 * Returns the contents between the first balanced `(...)` that represents params.
 */
function extractParamBlock(sig: string): { paramStr: string; afterParams: string } | null {
  let funIdx = sig.indexOf(' fun ');
  if (funIdx === -1) {
    if (sig.startsWith('fun ')) {
      funIdx = 0;
    } else {
      return null;
    }
  }

  const parenStart = sig.indexOf('(', funIdx);
  if (parenStart === -1) return null;

  const parenEnd = findMatchingClose(sig, parenStart, '(', ')');
  if (parenEnd === -1) return null;

  return {
    paramStr: sig.slice(parenStart + 1, parenEnd),
    afterParams: sig.slice(parenEnd + 1).trim(),
  };
}

/**
 * Parse generic type parameters from the portion of a signature between the
 * function name and the opening `(`.  Handles:
 *   `<T>`
 *   `<T: key + store>`
 *   `<phantom CoinType>`
 *   `<T: key, phantom U: store>`
 */
function extractTypeParams(sig: string): TypeParam[] {
  const funIdx = Math.max(sig.indexOf(' fun '), 0);
  const nameMatch = sig.slice(funIdx).match(/\bfun\s+\w+\s*(<[^(]*>)/);
  if (!nameMatch) return [];

  const inner = nameMatch[1].slice(1, -1).trim();
  if (!inner) return [];

  const params: TypeParam[] = [];
  // Split on commas that are not inside nested angle brackets
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '<') {
      depth++;
      current += ch;
    } else if (ch === '>') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      params.push(parseOneTypeParam(current.trim()));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) params.push(parseOneTypeParam(current.trim()));
  return params;
}

function parseOneTypeParam(raw: string): TypeParam {
  const isPhantom = raw.startsWith('phantom ');
  const withoutPhantom = isPhantom ? raw.slice('phantom '.length).trim() : raw;
  const colonIdx = withoutPhantom.indexOf(':');
  if (colonIdx === -1) {
    return { name: withoutPhantom, constraints: [], isPhantom };
  }
  const name = withoutPhantom.slice(0, colonIdx).trim();
  const constraintStr = withoutPhantom.slice(colonIdx + 1).trim();
  const constraints = constraintStr
    .split('+')
    .map((c) => c.trim())
    .filter(Boolean);
  return { name, constraints, isPhantom };
}

/**
 * Extract `acquires` resource names from the post-params portion of a signature.
 * Handles: `acquires Balance`, `acquires Balance, Store`,
 * `acquires 0x1::coin::CoinStore`, and generic resources like
 * `acquires CoinStore<AptosCoin>` or `Vault<address, u128>`.
 */
function extractAcquires(afterParams: string): string[] {
  const idx = afterParams.search(/\bacquires\b/);
  if (idx === -1) return [];
  // Skip the keyword and any whitespace.
  const remainder = afterParams.slice(idx + 'acquires'.length).replace(/^\s+/, '');
  // Walk to the end of the clause: either end-of-string or `{` at depth 0.
  let depth = 0;
  let end = remainder.length;
  for (let i = 0; i < remainder.length; i++) {
    const ch = remainder[i];
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if ((ch === '{' || ch === ';') && depth === 0) {
      end = i;
      break;
    }
  }
  const clause = remainder.slice(0, end).trim();
  if (!clause) return [];
  // Split on top-level commas, preserving generic-instantiation argument lists.
  const parts: string[] = [];
  let current = '';
  depth = 0;
  for (const ch of clause) {
    if (ch === '<') {
      depth++;
      current += ch;
    } else if (ch === '>') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === ',' && depth === 0) {
      const t = current.trim();
      if (t) parts.push(t);
      current = '';
    } else {
      current += ch;
    }
  }
  const t = current.trim();
  if (t) parts.push(t);
  return parts;
}

export function parseMoveSignature(signature: string): ParsedMoveSignature {
  const sig = signature.trim();

  let visibility: ParsedMoveSignature['visibility'] = 'private';
  let visibilityModifier: string | undefined;
  const restrictedPublic = sig.match(/^public\s*\(\s*([^)]+?)\s*\)/);
  if (restrictedPublic) {
    visibilityModifier = restrictedPublic[1].trim();
    if (visibilityModifier === 'friend' || visibilityModifier === 'package') {
      visibility = visibilityModifier;
    } else {
      visibility = 'public';
    }
  } else if (sig.startsWith('public ')) visibility = 'public';
  else if (sig.startsWith('friend ')) visibility = 'friend';
  else if (sig.startsWith('package ')) visibility = 'package';

  const isEntry = /\bentry\s+fun\b/.test(sig);

  const funMatch = sig.match(/\bfun\s+(\w+)/);
  const name = funMatch ? funMatch[1] : '';

  const typeParams = extractTypeParams(sig);

  const paramBlock = extractParamBlock(sig);
  const parameters: { name: string; type: string }[] = [];
  let returnType: string | null = null;
  let acquires: string[] = [];

  if (paramBlock) {
    if (paramBlock.paramStr.trim()) {
      const rawParams = splitParams(paramBlock.paramStr);
      for (const raw of rawParams) {
        const colonIdx = raw.indexOf(':');
        if (colonIdx !== -1) {
          parameters.push({
            name: raw.slice(0, colonIdx).trim(),
            type: raw.slice(colonIdx + 1).trim(),
          });
        } else {
          parameters.push({ name: raw.trim(), type: '' });
        }
      }
    }

    const after = paramBlock.afterParams;
    // Return type comes before `acquires`; strip it first.
    const acquiresIdx = after.search(/\bacquires\b/);
    const beforeAcquires = acquiresIdx === -1 ? after : after.slice(0, acquiresIdx).trim();
    if (beforeAcquires.startsWith(':')) {
      // Strip trailing `acquires ...` from the return type string so it stays clean.
      returnType = beforeAcquires.slice(1).trim() || null;
    }
    acquires = extractAcquires(after);
  }

  return {
    visibility,
    ...(visibilityModifier ? { visibilityModifier } : {}),
    isEntry,
    name,
    typeParams,
    parameters,
    returnType,
    acquires,
  };
}
