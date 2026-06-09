/**
 * MoveFlowClient implementation that spawns `move-flow mcp` and communicates
 * via MCP JSON-RPC over stdio (newline-delimited JSON).
 *
 * The move-flow binary (Rust/rmcp) is expected at `process.env.MOVE_FLOW`
 * or on $PATH as `move-flow`.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { MoveFactsMap, ModuleSummaryMap, CallGraphMap } from './compiler-facts.js';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * The move-flow surface GitNexus consumes. Defined here (not in the ingest
 * phase) so the client owns its own contract and the ingest phase depends on
 * the client, never the reverse.
 */
export interface MoveFlowClient {
  /** Full-fidelity per-module facts (move_package_query query:"facts"). */
  facts(packagePath: string): Promise<MoveFactsMap>;
  /** Degraded fallback: per-module constants/structs/function-signatures. */
  moduleSummary(packagePath: string): Promise<ModuleSummaryMap>;
  /** Function-level call graph (caller qualified name → callee qualified names). */
  callGraph(packagePath: string): Promise<CallGraphMap>;
  /** Capability probe (cached): which queries this move-flow build supports. */
  capabilities(): Promise<MoveFlowCapabilities>;
  shutdown(): Promise<void>;
}

/** What a given move-flow build can answer. */
export interface MoveFlowCapabilities {
  /** `facts` query available (rich, compiler-sourced per-module facts). */
  hasFactsQuery: boolean;
  /** `module_summary` query available (the signature-parse fallback path). */
  hasModuleSummary: boolean;
}

/** Minimal shape of an entry in an MCP `tools/list` response. */
export interface MoveFlowToolInfo {
  name: string;
  inputSchema?: unknown;
}

/**
 * Derive move-flow capabilities from a `tools/list` response.
 *
 * `facts` is a *query type* on `move_package_query` (a `const` in the tool's
 * `inputSchema` QueryType enum), not a standalone tool — so we detect it by
 * inspecting the schema. A hypothetical future standalone `move_package_facts`
 * tool is also honoured for forward-compatibility.
 *
 * Accepts either bare tool-name strings or `{ name, inputSchema }` entries.
 */
export function detectMoveFlowCapabilities(
  tools: ReadonlyArray<string | MoveFlowToolInfo>,
): MoveFlowCapabilities {
  const names = new Set<string>();
  let querySchema: unknown;
  for (const t of tools) {
    if (typeof t === 'string') {
      names.add(t);
    } else {
      names.add(t.name);
      if (t.name === 'move_package_query') querySchema = t.inputSchema;
    }
  }
  const hasModuleSummary = names.has('move_package_query');
  const hasFactsQuery =
    names.has('move_package_facts') || schemaMentionsFactsQuery(querySchema);
  return { hasFactsQuery, hasModuleSummary };
}

/** True if the `move_package_query` inputSchema declares a `"facts"` query const. */
function schemaMentionsFactsQuery(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  // Walk the JSON-schema object looking for a `const: "facts"` or
  // `enum: [... "facts" ...]` anywhere under the QueryType definition.
  const stack: unknown[] = [schema];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const obj = node as Record<string, unknown>;
    if (obj.const === 'facts') return true;
    if (Array.isArray(obj.enum) && obj.enum.includes('facts')) return true;
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}

export class MoveFlowMcpClient implements MoveFlowClient {
  private proc: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private capsPromise: Promise<MoveFlowCapabilities> | null = null;
  private binaryPath: string;
  private stderrLines: string[] = [];
  private static readonly MAX_STDERR = 20;

  private stderrContext(): string {
    if (this.stderrLines.length === 0) return '';
    return `\nstderr (last ${this.stderrLines.length} lines):\n${this.stderrLines.join('\n')}`;
  }

  constructor(binaryPath?: string) {
    this.binaryPath = binaryPath || process.env.MOVE_FLOW || 'move-flow';
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._start();
    return this.initPromise;
  }

  private async _start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('move-flow MCP server did not respond within 30s'));
      }, 30000);

      this.proc = spawn(this.binaryPath, ['mcp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc.stderr!.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (!line) continue;
          this.stderrLines.push(line);
          if (this.stderrLines.length > MoveFlowMcpClient.MAX_STDERR) {
            this.stderrLines.shift();
          }
        }
      });

      this.proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn move-flow: ${err.message}${this.stderrContext()}`));
      });

      this.proc.on('exit', (code) => {
        if (!this.initialized) {
          clearTimeout(timeout);
          reject(
            new Error(`move-flow exited with code ${code} during init${this.stderrContext()}`),
          );
          return;
        }
        // Post-init unexpected death: reject all pending requests
        for (const [, p] of this.pending) {
          p.reject(
            new Error(`move-flow exited unexpectedly (code ${code})${this.stderrContext()}`),
          );
        }
        this.pending.clear();
        this.initialized = false;
        this.initPromise = null;
        this.proc = null;
      });

      const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (msg.id != null) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) {
                p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
              } else {
                p.resolve(msg.result);
              }
            }
          }
        } catch {
          /* ignore non-JSON lines */
        }
      });

      // Send initialize
      const initId = ++this.requestId;
      this.pending.set(initId, {
        resolve: () => {
          clearTimeout(timeout);
          this.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as any);
          this.initialized = true;
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.send({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'gitnexus', version: '1.0.0' },
        },
      });
    });
  }

  private send(msg: Record<string, unknown>): void {
    this.proc!.stdin!.write(JSON.stringify(msg) + '\n');
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<any> {
    await this.ensureStarted();

    return new Promise<any>((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.proc?.kill();
        } catch {
          /* process may already be dead */
        }
        reject(new Error(`move-flow '${toolName}' timed out after 120s`));
      }, 120000);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          if (result?.content?.[0]?.text) {
            try {
              resolve(JSON.parse(result.content[0].text));
            } catch {
              resolve(result.content[0].text);
            }
          } else {
            resolve(result);
          }
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      });
    });
  }

  async moduleSummary(packagePath: string): Promise<ModuleSummaryMap> {
    return (await this.callTool('move_package_query', {
      package_path: packagePath,
      query: 'module_summary',
    })) as ModuleSummaryMap;
  }

  async callGraph(packagePath: string): Promise<CallGraphMap> {
    return (await this.callTool('move_package_query', {
      package_path: packagePath,
      query: 'call_graph',
    })) as CallGraphMap;
  }

  async facts(packagePath: string): Promise<MoveFactsMap> {
    return (await this.callTool('move_package_query', {
      package_path: packagePath,
      query: 'facts',
    })) as MoveFactsMap;
  }

  /** Raw JSON-RPC request (non-`tools/call`), e.g. `tools/list`. */
  private async rpcRequest(method: string, params?: unknown): Promise<any> {
    await this.ensureStarted();
    return new Promise<any>((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`move-flow '${method}' timed out after 30s`));
      }, 30000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async capabilities(): Promise<MoveFlowCapabilities> {
    if (this.capsPromise) return this.capsPromise;
    this.capsPromise = (async () => {
      try {
        const listed = await this.rpcRequest('tools/list', {});
        const tools = (listed?.tools ?? []) as MoveFlowToolInfo[];
        return detectMoveFlowCapabilities(tools);
      } catch {
        // If the probe fails, assume the conservative fallback path only.
        return { hasFactsQuery: false, hasModuleSummary: true };
      }
    })();
    return this.capsPromise;
  }

  async shutdown(): Promise<void> {
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
    this.initPromise = null;
    this.capsPromise = null;
    this.pending.clear();
    this.stderrLines.length = 0;
  }
}

/**
 * Try to create a MoveFlowMcpClient. Returns null if move-flow binary
 * is not found on the system.
 */
const SAFE_BINARY = /^[\w./-]+$/;

export function tryCreateMoveFlowClient(): MoveFlowMcpClient | null {
  const binary = process.env.MOVE_FLOW || 'move-flow';
  if (!SAFE_BINARY.test(binary)) return null;
  try {
    execFileSync('/usr/bin/env', [binary, '--version'], { stdio: 'ignore', timeout: 5000 });
    return new MoveFlowMcpClient(binary);
  } catch {
    return null;
  }
}
