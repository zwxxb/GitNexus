import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

import {
  MoveFlowMcpClient,
  tryCreateMoveFlowClient,
  detectMoveFlowCapabilities,
} from '../../../src/core/move/mcp-client.js';
import { spawn, execFileSync } from 'node:child_process';

const mockSpawn = vi.mocked(spawn);
const mockExecFileSync = vi.mocked(execFileSync);

function createMockProc() {
  const proc = new EventEmitter() as any;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 99999;
  return proc;
}

describe('tryCreateMoveFlowClient', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.MOVE_FLOW;
  });

  it('returns MoveFlowMcpClient when binary is found', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const client = tryCreateMoveFlowClient();
    expect(client).toBeInstanceOf(MoveFlowMcpClient);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/usr/bin/env',
      ['move-flow', '--version'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
  });

  it('returns null when binary is not found', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(tryCreateMoveFlowClient()).toBeNull();
  });

  it('returns null for binary names with shell metacharacters', () => {
    process.env.MOVE_FLOW = 'move-flow; rm -rf /';
    const client = tryCreateMoveFlowClient();
    expect(client).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns null for binary names with backticks', () => {
    process.env.MOVE_FLOW = '`evil`';
    expect(tryCreateMoveFlowClient()).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('allows valid path-like binary names', () => {
    process.env.MOVE_FLOW = '/usr/local/bin/move-flow';
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const client = tryCreateMoveFlowClient();
    expect(client).toBeInstanceOf(MoveFlowMcpClient);
  });
});

describe('MoveFlowMcpClient', () => {
  it('shutdown clears all state', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const client = new MoveFlowMcpClient('move-flow');
    // Manually set internal state to simulate initialized client
    (client as any).proc = proc;
    (client as any).initialized = true;

    await client.shutdown();

    expect(proc.kill).toHaveBeenCalled();
    expect((client as any).proc).toBeNull();
    expect((client as any).initialized).toBe(false);
    expect((client as any).initPromise).toBeNull();
    expect((client as any).pending.size).toBe(0);
  });

  it('shutdown is safe to call when not started', async () => {
    const client = new MoveFlowMcpClient('move-flow');
    await client.shutdown(); // Should not throw
  });
});

describe('detectMoveFlowCapabilities', () => {
  it('reports facts support from a standalone move_package_facts tool name', () => {
    const caps = detectMoveFlowCapabilities(['move_package_query', 'move_package_facts']);
    expect(caps.hasFactsQuery).toBe(true);
    expect(caps.hasModuleSummary).toBe(true);
  });

  it('detects the facts query from the move_package_query inputSchema enum', () => {
    // Reflects reality: `facts` is a `const` in the QueryType `$defs`, not a tool.
    const caps = detectMoveFlowCapabilities([
      { name: 'move_package_manifest' },
      {
        name: 'move_package_query',
        inputSchema: {
          $defs: {
            QueryType: {
              oneOf: [
                { const: 'module_summary' },
                { const: 'call_graph' },
                { const: 'facts' },
              ],
            },
          },
        },
      },
    ]);
    expect(caps.hasFactsQuery).toBe(true);
    expect(caps.hasModuleSummary).toBe(true);
  });

  it('also detects facts from a flat enum schema', () => {
    const caps = detectMoveFlowCapabilities([
      {
        name: 'move_package_query',
        inputSchema: { properties: { query: { enum: ['module_summary', 'facts'] } } },
      },
    ]);
    expect(caps.hasFactsQuery).toBe(true);
  });

  it('falls back to module_summary when facts is absent', () => {
    const caps = detectMoveFlowCapabilities([
      { name: 'move_package_query', inputSchema: { $defs: { QueryType: { oneOf: [{ const: 'module_summary' }] } } } },
      'move_package_manifest',
    ]);
    expect(caps.hasFactsQuery).toBe(false);
    expect(caps.hasModuleSummary).toBe(true);
  });

  it('reports no module_summary when move_package_query is missing entirely', () => {
    const caps = detectMoveFlowCapabilities(['move_package_status']);
    expect(caps.hasFactsQuery).toBe(false);
    expect(caps.hasModuleSummary).toBe(false);
  });
});
