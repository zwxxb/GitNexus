import { describe, it, expect } from 'vitest';
import { mapFactsToGraph } from '../../../src/core/move/facts-mapper.js';
import {
  moduleSummaryToFacts,
  type MoveFactsMap,
  type ModuleSummaryMap,
} from '../../../src/core/move/compiler-facts.js';

// Trimmed-but-faithful slice of a real `move_package_query { query: "facts" }`
// response for the `coin` fixture (coin + coin_admin modules).
const facts: MoveFactsMap = {
  '0xa::coin': {
    file: '/pkg/sources/coin.move',
    span: [1, 49],
    friends: [{ module: '0xa::coin_admin' }],
    attributes: [],
    hasSpecs: false,
    functions: [
      {
        name: 'register',
        file: '/pkg/sources/coin.move',
        span: [19, 21],
        visibility: 'public',
        isEntry: true,
        isInline: false,
        isNative: false,
        isView: false,
        attributes: [],
        typeParams: [{ name: 'CoinType', abilities: [], isPhantom: false }],
        params: [{ name: 'account', type: '&signer' }],
        returnType: null,
        declaredAccess: [],
        acquiresInferred: [],
        resourceAccess: { reads: [], writes: ['CoinStore<CoinType>'] },
        hasSpec: false,
      },
      {
        name: 'balance_of',
        file: '/pkg/sources/coin.move',
        span: [34, 37],
        visibility: 'public',
        isEntry: false,
        isInline: false,
        isNative: false,
        isView: true,
        attributes: [{ name: 'view' }],
        typeParams: [{ name: 'CoinType', abilities: [], isPhantom: false }],
        params: [{ name: 'addr', type: 'address' }],
        returnType: 'u64',
        declaredAccess: [],
        acquiresInferred: ['0xa::coin::CoinStore'],
        resourceAccess: { reads: ['CoinStore<CoinType>'], writes: [] },
        hasSpec: false,
      },
    ],
    types: [
      {
        kind: 'struct',
        name: 'CoinStore',
        file: '/pkg/sources/coin.move',
        span: [5, 7],
        abilities: ['key'],
        typeParams: [{ name: 'CoinType', abilities: [], isPhantom: true }],
        fields: [{ name: 'balance', type: 'u64', positional: false }],
        attributes: [],
        hasSpec: false,
      },
      {
        kind: 'struct',
        name: 'TransferEvent',
        file: '/pkg/sources/coin.move',
        span: [10, 14],
        abilities: ['drop', 'store'],
        typeParams: [],
        fields: [{ name: 'amount', type: 'u64', positional: false }],
        attributes: [{ name: 'event' }],
        hasSpec: false,
      },
    ],
    constants: [{ name: 'E_NOT_REGISTERED', type: 'u64', value: '1' }],
  },
  '0xa::coin_admin': {
    file: '/pkg/sources/coin.move',
    span: [51, 55],
    friends: [],
    attributes: [],
    hasSpecs: false,
    functions: [],
    types: [],
    constants: [],
  },
};

describe('mapFactsToGraph', () => {
  it('emits a WRITES_RESOURCE edge from register to CoinStore', () => {
    const { edges } = mapFactsToGraph(facts, '/pkg');
    expect(
      edges.some(
        (e) =>
          e.type === 'WRITES_RESOURCE' &&
          e.sourceId.includes('register') &&
          e.targetId.includes('CoinStore'),
      ),
    ).toBe(true);
  });

  it('emits a READS_RESOURCE edge from balance_of to CoinStore', () => {
    const { edges } = mapFactsToGraph(facts, '/pkg');
    expect(
      edges.some(
        (e) =>
          e.type === 'READS_RESOURCE' &&
          e.sourceId.includes('balance_of') &&
          e.targetId.includes('CoinStore'),
      ),
    ).toBe(true);
  });

  it('emits an ACQUIRES edge from the fully-qualified acquiresInferred name', () => {
    const { edges } = mapFactsToGraph(facts, '/pkg');
    expect(edges.some((e) => e.type === 'ACQUIRES' && e.sourceId.includes('balance_of'))).toBe(true);
  });

  it('emits a FRIEND_OF edge to coin_admin', () => {
    const { edges } = mapFactsToGraph(facts, '/pkg');
    expect(edges.some((e) => e.type === 'FRIEND_OF' && e.targetId.includes('coin_admin'))).toBe(
      true,
    );
  });

  it('marks struct CoinStore as a resource (key ability)', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const cs = nodes.find((n) => n.properties.name === 'CoinStore');
    expect(cs?.label).toBe('Struct');
    expect(cs?.properties.isResource).toBe(true);
  });

  it('marks struct TransferEvent as an event (event attribute)', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const ev = nodes.find((n) => n.properties.name === 'TransferEvent');
    expect(ev?.properties.isEvent).toBe(true);
  });

  it('marks balance_of as a view entry point with precise location', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const fn = nodes.find((n) => n.properties.name === 'balance_of');
    expect(fn?.properties.isView).toBe(true);
    expect(fn?.properties.locationFidelity).toBe('precise');
    expect(fn?.properties.startLine).toBe(34);
  });

  it('tolerates functions/modules with missing optional arrays (real move-flow shape)', () => {
    // move-flow omits optional array fields (acquiresInferred, resourceAccess,
    // params, typeParams, attributes, friends, types, constants) for some symbols.
    // The mapper must not throw "not iterable" and skip the whole package.
    const sparse = {
      '0xb::sparse': {
        file: '/pkg/sources/sparse.move',
        // no friends / attributes / types / constants
        hasSpecs: false,
        functions: [
          {
            name: 'do_thing',
            visibility: 'public',
            isEntry: true,
            isInline: false,
            isNative: false,
            isView: false,
            hasSpec: false,
            // acquiresInferred, resourceAccess, params, typeParams, attributes all absent
          },
        ],
      },
    } as unknown as MoveFactsMap;
    expect(() => mapFactsToGraph(sparse, '/pkg')).not.toThrow();
    const { nodes } = mapFactsToGraph(sparse, '/pkg');
    const fn = nodes.find((n) => n.properties.name === 'do_thing');
    expect(fn?.properties.isEntry).toBe(true);
    expect(fn?.properties.parameterCount).toBe(0);
    expect(fn?.properties.acquires).toEqual([]);
  });

  it('fallback: moduleSummaryToFacts feeds the same mapper (degraded, package-fidelity)', () => {
    const summary: ModuleSummaryMap = {
      '0xa::coin': {
        constants: [{ name: 'E_NOT_REGISTERED', type: 'u64', value: '1' }],
        structs: [{ name: 'CoinStore', abilities: ['key'], fields: ['balance: u64'] }],
        functions: [{ name: 'register', signature: 'public entry fun register<CoinType>(account: &signer)' }],
      },
    };
    const { nodes } = mapFactsToGraph(moduleSummaryToFacts(summary), '/pkg', '/pkg');
    const fn = nodes.find((n) => n.properties.name === 'register');
    expect(fn?.label).toBe('Function');
    expect(fn?.properties.isEntry).toBe(true);
    expect(fn?.properties.locationFidelity).toBe('package'); // module_summary has no per-symbol file
    const cs = nodes.find((n) => n.properties.name === 'CoinStore');
    expect(cs?.properties.isResource).toBe(true); // key ability survives the adapter
    expect(nodes.some((n) => n.label === 'Const' && n.properties.name === 'E_NOT_REGISTERED')).toBe(
      true,
    );
  });

  it('emits Module/Function/Struct/Const nodes and DEFINES edges', () => {
    const { nodes, edges, functionNodeMap, structNodeMap, moduleFileMap } = mapFactsToGraph(
      facts,
      '/pkg',
    );
    expect(nodes.some((n) => n.label === 'Module' && n.properties.name === 'coin')).toBe(true);
    expect(nodes.some((n) => n.label === 'Const' && n.properties.name === 'E_NOT_REGISTERED')).toBe(
      true,
    );
    expect(edges.some((e) => e.type === 'DEFINES')).toBe(true);
    expect(functionNodeMap.has('0xa::coin::register')).toBe(true);
    expect(structNodeMap.has('0xa::coin::CoinStore')).toBe(true);
    expect(moduleFileMap.get('0xa::coin')).toBe('/pkg/sources/coin.move');
  });
});
