/**
 * Live end-to-end Move ingestion against the real move-flow binary.
 *
 * Gated on move-flow being installed (skipped in CI without the binary). Proves
 * the full compiler-first chain: capability probe → facts query → thin
 * facts→graph mapper → pipeline graph, with full fidelity (resource/friend
 * edges, resource structs, precise locations).
 */
import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { tryCreateMoveFlowClient } from '../../src/core/move/mcp-client.js';

const client = tryCreateMoveFlowClient();
const coinFixture = path.resolve(process.cwd(), 'test/fixtures/move/aptos-framework/coin');

describe.skipIf(!client)('live move-flow ingestion (coin fixture)', () => {
  afterAll(async () => {
    await client?.shutdown();
  });

  it('detects the facts query capability', async () => {
    const caps = await client!.capabilities();
    expect(caps.hasFactsQuery).toBe(true);
  });

  it('builds a full-fidelity Move graph from compiler facts', async () => {
    const result = await runPipelineFromRepo(coinFixture, () => {}, {
      moveFlowClient: client,
      skipGraphPhases: true,
    });
    const nodes = [...result.graph.iterNodes()];
    const edges = [...result.graph.iterRelationships()];

    const moveFns = nodes.filter(
      (n) => n.label === 'Function' && n.properties.language === 'move',
    );
    expect(moveFns.some((n) => n.properties.name === 'register' && n.properties.isEntry)).toBe(true);
    expect(moveFns.some((n) => n.properties.name === 'balance_of' && n.properties.isView)).toBe(
      true,
    );

    const coinStore = nodes.find((n) => n.label === 'Struct' && n.properties.name === 'CoinStore');
    expect(coinStore?.properties.isResource).toBe(true);
    expect(coinStore?.properties.locationFidelity).toBe('precise');

    expect(edges.some((e) => e.type === 'WRITES_RESOURCE')).toBe(true);
    expect(edges.some((e) => e.type === 'FRIEND_OF')).toBe(true);
    expect(edges.some((e) => e.type === 'DEFINES')).toBe(true);
  }, 60000);
});
