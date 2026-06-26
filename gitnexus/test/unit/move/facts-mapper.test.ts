import { describe, it, expect } from 'vitest';
import {
  buildLocalNameIndex,
  mapFactsToGraph,
  resolveFriendEdges,
  resolveResourceEdges,
  resolveTypeRefEdges,
} from '../../../src/core/move/facts-mapper.js';
import { type MoveFactsMap } from '../../../src/core/move/compiler-facts.js';

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
        acquiresInferred: ['0xa::coin::CoinStore'],
        resourceAccess: { reads: ['CoinStore<CoinType>'], writes: [] },
        hasSpec: false,
      },
    ],
    structs: [
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
    structs: [],
    constants: [],
  },
};

function mapFactsToGraphWithResolvedEdges(factsMap: MoveFactsMap): ReturnType<typeof mapFactsToGraph> {
  const mapped = mapFactsToGraph(factsMap, '/pkg');
  const edges = [...mapped.edges];
  const localNameIndex = buildLocalNameIndex(mapped.structNodeMap);
  const addResolvedUsedType = (sourceId: string, targetId: string): void => {
    const fnNode = mapped.nodes.find((n) => n.id === sourceId);
    const typeNode = mapped.nodes.find((n) => n.id === targetId);
    const qualifiedName = typeNode?.properties.qualifiedName;
    if (!fnNode || typeof qualifiedName !== 'string') return;
    const current = Array.isArray(fnNode.properties.usedTypes) ? fnNode.properties.usedTypes : [];
    if (!current.includes(qualifiedName)) fnNode.properties.usedTypes = [...current, qualifiedName];
  };
  resolveResourceEdges(
    mapped.pendingResource,
    mapped.structNodeMap,
    localNameIndex,
    (rel) => edges.push(rel),
  );
  resolveFriendEdges(mapped.pendingFriends, mapped.moduleFileMap, (rel) => edges.push(rel));
  resolveTypeRefEdges(
    mapped.pendingTypeRef,
    mapped.structNodeMap,
    localNameIndex,
    (rel) => {
      edges.push(rel);
      addResolvedUsedType(rel.sourceId, rel.targetId);
    },
  );
  return { ...mapped, edges };
}

describe('mapFactsToGraph', () => {
  it('emits a WRITES_RESOURCE edge from register to CoinStore', () => {
    const { edges } = mapFactsToGraphWithResolvedEdges(facts);
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
    const { edges } = mapFactsToGraphWithResolvedEdges(facts);
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
    const { edges } = mapFactsToGraphWithResolvedEdges(facts);
    expect(edges.some((e) => e.type === 'ACQUIRES' && e.sourceId.includes('balance_of'))).toBe(true);
  });

  it('emits a FRIEND_OF edge to coin_admin', () => {
    const { edges } = mapFactsToGraphWithResolvedEdges(facts);
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
    };
    expect(() => mapFactsToGraph(sparse, '/pkg')).not.toThrow();
    const { nodes } = mapFactsToGraph(sparse, '/pkg');
    const fn = nodes.find((n) => n.properties.name === 'do_thing');
    expect(fn?.properties.isEntry).toBe(true);
    expect(fn?.properties.parameterCount).toBe(0);
    expect(fn?.properties.acquires).toEqual([]);
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

  it('uses the move-friend-or-package reason on FRIEND_OF edges (compiler-derived friends include package-visibility)', () => {
    const { edges } = mapFactsToGraphWithResolvedEdges(facts);
    const friendEdge = edges.find((e) => e.type === 'FRIEND_OF');
    expect(friendEdge?.reason).toBe('move-friend-or-package');
  });

  it('serializes Struct typeParams as typeParamsJson string', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const cs = nodes.find((n) => n.label === 'Struct' && n.properties.name === 'CoinStore');
    expect(cs?.properties.typeParamsJson).toBe(
      JSON.stringify([{ name: 'CoinType', constraints: [], isPhantom: true }]),
    );
    expect(cs?.properties.typeParams).toBeUndefined();
  });

  it('serializes Enum typeParams as typeParamsJson string', () => {
    const enumFacts: MoveFactsMap = {
      '0xa::orders': {
        file: '/pkg/sources/orders.move',
        friends: [],
        attributes: [],
        functions: [],
        structs: [
          {
            kind: 'enum',
            name: 'OrderState',
            file: '/pkg/sources/orders.move',
            span: [1, 5],
            abilities: ['drop'],
            typeParams: [{ name: 'T', abilities: ['copy'], isPhantom: false }],
            variants: [{ name: 'Open', kind: 'unit', fields: [], attributes: [] }],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const { nodes } = mapFactsToGraph(enumFacts, '/pkg');
    const en = nodes.find((n) => n.label === 'Enum');
    expect(en?.properties.typeParamsJson).toBe(
      JSON.stringify([{ name: 'T', constraints: ['copy'], isPhantom: false }]),
    );
    expect(en?.properties.typeParams).toBeUndefined();
  });

  it('marks key enums as resources', () => {
    const enumFacts: MoveFactsMap = {
      '0xa::accounts': {
        file: '/pkg/sources/accounts.move',
        friends: [],
        attributes: [],
        functions: [],
        structs: [
          {
            kind: 'enum',
            name: 'GlobalAccountStates',
            file: '/pkg/sources/accounts.move',
            span: [1, 5],
            abilities: ['key'],
            typeParams: [],
            variants: [{ name: 'Empty', kind: 'unit', fields: [], attributes: [] }],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const { nodes } = mapFactsToGraph(enumFacts, '/pkg');
    const en = nodes.find((n) => n.label === 'Enum' && n.properties.name === 'GlobalAccountStates');
    expect(en?.properties.isResource).toBe(true);
  });

  it('exposes EnumVariant attributes on the node', () => {
    const enumFacts: MoveFactsMap = {
      '0xa::orders': {
        file: '/pkg/sources/orders.move',
        friends: [],
        attributes: [],
        functions: [],
        structs: [
          {
            kind: 'enum',
            name: 'OrderState',
            file: '/pkg/sources/orders.move',
            span: [1, 5],
            abilities: [],
            typeParams: [],
            variants: [
              {
                name: 'Cancelled',
                kind: 'unit',
                fields: [],
                attributes: [{ name: 'deprecated' }],
              },
            ],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const { nodes } = mapFactsToGraph(enumFacts, '/pkg');
    const v = nodes.find((n) => n.label === 'EnumVariant');
    expect(v?.properties.attributes).toEqual(['deprecated']);
    expect(v?.properties.locationFidelity).toBe('module');
  });

  it('does not write moduleAddress on Function nodes (only Module/Struct/Enum carry it)', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const fn = nodes.find((n) => n.label === 'Function' && n.properties.name === 'register');
    expect(fn?.properties.moduleAddress).toBeUndefined();
    const mod = nodes.find((n) => n.label === 'Module' && n.properties.name === 'coin');
    expect(mod?.properties.moduleAddress).toBe('0xa');
    const cs = nodes.find((n) => n.label === 'Struct' && n.properties.name === 'CoinStore');
    expect(cs?.properties.moduleAddress).toBe('0xa');
  });

  it('writes Const data under constType/constValue (matching schema column names)', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const c = nodes.find((n) => n.label === 'Const' && n.properties.name === 'E_NOT_REGISTERED');
    expect(c?.properties.constType).toBe('u64');
    expect(c?.properties.constValue).toBe('1');
    expect(c?.properties.declaredType).toBeUndefined();
    expect(c?.properties.value).toBeUndefined();
    expect(c?.properties.locationFidelity).toBe('module');
  });

  it('emits USES_TYPE edges from function signature types (params + return)', () => {
    const sigFacts: MoveFactsMap = {
      '0xa::coin': {
        file: '/pkg/sources/coin.move',
        friends: [],
        attributes: [],
        functions: [
          {
            name: 'wrap',
            file: '/pkg/sources/coin.move',
            span: [1, 5],
            visibility: 'public',
            isEntry: false,
            isInline: false,
            isNative: false,
            isView: false,
            attributes: [],
            typeParams: [],
            params: [{ name: 'store', type: '&CoinStore' }],
            returnType: 'TransferEvent',
            acquiresInferred: [],
            resourceAccess: { reads: [], writes: [] },
          },
        ],
        structs: [
          {
            kind: 'struct',
            name: 'CoinStore',
            file: '/pkg/sources/coin.move',
            span: [10, 12],
            abilities: ['key'],
            typeParams: [],
            fields: [],
            attributes: [],
          },
          {
            kind: 'struct',
            name: 'TransferEvent',
            file: '/pkg/sources/coin.move',
            span: [20, 22],
            abilities: ['drop'],
            typeParams: [],
            fields: [],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const { edges } = mapFactsToGraphWithResolvedEdges(sigFacts);
    const usesEdges = edges.filter((e) => e.type === 'USES_TYPE');
    const toCoinStore = usesEdges.find((e) => e.targetId.includes('CoinStore'));
    const toEvent = usesEdges.find((e) => e.targetId.includes('TransferEvent'));
    expect(toCoinStore?.reason).toBe('move-fn-param-type');
    expect(toEvent?.reason).toBe('move-fn-return-type');
  });

  it('populates usedTypes from resolved signature type edges only', () => {
    const sigFacts: MoveFactsMap = {
      '0xa::coin': {
        file: '/pkg/sources/coin.move',
        friends: [],
        attributes: [],
        functions: [
          {
            name: 'wrap',
            file: '/pkg/sources/coin.move',
            span: [1, 5],
            visibility: 'public',
            isEntry: false,
            isInline: false,
            isNative: false,
            isView: false,
            attributes: [],
            typeParams: [],
            params: [
              { name: 'stores', type: 'vector<CoinStore<T>>' },
              { name: 'unknown', type: 'UnresolvedType' },
            ],
            returnType: 'TransferEvent',
            acquiresInferred: [],
            resourceAccess: { reads: [], writes: [] },
          },
        ],
        structs: [
          {
            kind: 'struct',
            name: 'CoinStore',
            file: '/pkg/sources/coin.move',
            span: [10, 12],
            abilities: ['key'],
            typeParams: [],
            fields: [],
            attributes: [],
          },
          {
            kind: 'struct',
            name: 'TransferEvent',
            file: '/pkg/sources/coin.move',
            span: [20, 22],
            abilities: ['drop'],
            typeParams: [],
            fields: [],
            attributes: [],
          },
        ],
        constants: [],
      },
    };
    const { nodes } = mapFactsToGraphWithResolvedEdges(sigFacts);
    const wrap = nodes.find((n) => n.label === 'Function' && n.properties.name === 'wrap');
    expect(wrap?.properties.usedTypes).toEqual([
      '0xa::coin::CoinStore',
      '0xa::coin::TransferEvent',
    ]);
  });

  it('populates usedTypes string array on the Function node', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const balanceOf = nodes.find((n) => n.label === 'Function' && n.properties.name === 'balance_of');
    expect(balanceOf?.properties.usedTypes).toEqual([]);
    const register = nodes.find((n) => n.label === 'Function' && n.properties.name === 'register');
    expect(register?.properties.usedTypes).toEqual([]);
  });

  it('does not write isTest/isTestOnly on Function nodes (move-flow strips test items)', () => {
    const { nodes } = mapFactsToGraph(facts, '/pkg');
    const fn = nodes.find((n) => n.label === 'Function' && n.properties.name === 'balance_of');
    expect(fn?.properties.isTest).toBeUndefined();
    expect(fn?.properties.isTestOnly).toBeUndefined();
  });
});
