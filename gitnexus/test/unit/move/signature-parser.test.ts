import { describe, it, expect } from 'vitest';
import { parseMoveSignature } from '../../../src/core/move/signature-parser.js';

describe('parseMoveSignature', () => {
  it('parses public entry function', () => {
    const result = parseMoveSignature(
      'public entry fun place_order(user: &signer, market: 0x1::object::Object<perp_market::PerpMarket>, size: u64): u64',
    );
    expect(result.visibility).toBe('public');
    expect(result.isEntry).toBe(true);
    expect(result.name).toBe('place_order');
    expect(result.parameters).toHaveLength(3);
    expect(result.parameters[0]).toEqual({ name: 'user', type: '&signer' });
    expect(result.parameters[2]).toEqual({ name: 'size', type: 'u64' });
    expect(result.returnType).toBe('u64');
  });

  it('parses friend function with no return', () => {
    const result = parseMoveSignature(
      'friend fun initialize(admin: &signer, collateral_token: 0x1::object::Object<0x1::fungible_asset::Metadata>, backstop_liquidator: address)',
    );
    expect(result.visibility).toBe('friend');
    expect(result.isEntry).toBe(false);
    expect(result.name).toBe('initialize');
    expect(result.parameters).toHaveLength(3);
    expect(result.returnType).toBeNull();
  });

  it('parses private entry function', () => {
    const result = parseMoveSignature(
      'private entry fun increment_time(account: &signer, increment_microseconds: u64)',
    );
    expect(result.visibility).toBe('private');
    expect(result.isEntry).toBe(true);
    expect(result.name).toBe('increment_time');
    expect(result.parameters).toHaveLength(2);
  });

  it('parses public function with no params', () => {
    const result = parseMoveSignature(
      'public fun primary_asset_metadata(): 0x1::object::Object<0x1::fungible_asset::Metadata>',
    );
    expect(result.visibility).toBe('public');
    expect(result.isEntry).toBe(false);
    expect(result.name).toBe('primary_asset_metadata');
    expect(result.parameters).toHaveLength(0);
    expect(result.returnType).toBe('0x1::object::Object<0x1::fungible_asset::Metadata>');
  });

  it('parses restricted public visibility', () => {
    const result = parseMoveSignature('public(friend) fun package_visible(x: u64)');
    expect(result.visibility).toBe('friend');
    expect(result.visibilityModifier).toBe('friend');
    expect(result.name).toBe('package_visible');
  });

  it('parses package visibility shorthand', () => {
    const result = parseMoveSignature('package fun same_package_only(x: u64)');
    expect(result.visibility).toBe('package');
    expect(result.name).toBe('same_package_only');
  });

  it('parses bare entry functions as entry points', () => {
    const result = parseMoveSignature('entry fun publish(account: &signer)');
    expect(result.visibility).toBe('private');
    expect(result.isEntry).toBe(true);
    expect(result.name).toBe('publish');
  });

  it('treats public(package) as package visibility', () => {
    const result = parseMoveSignature('public(package) fun scoped(x: u64)');
    expect(result.visibility).toBe('package');
    expect(result.visibilityModifier).toBe('package');
  });

  it('parses function with function type parameters', () => {
    const result = parseMoveSignature(
      'friend fun add_secondary_asset_with_liquidation_burn(admin: &signer, asset_type: 0x1::object::Object<0x1::fungible_asset::Metadata>, price_fn: ||u64 has copy + drop + store, haircut_bps: u64)',
    );
    expect(result.visibility).toBe('friend');
    expect(result.name).toBe('add_secondary_asset_with_liquidation_burn');
    expect(result.parameters.length).toBeGreaterThanOrEqual(4);
  });

  it('parses function returning Option', () => {
    const result = parseMoveSignature(
      'public fun request_withdrawal_from_cross(owner: &signer, metadata: 0x1::object::Object<0x1::fungible_asset::Metadata>, amount: u64, recipient: address): 0x1::option::Option<u128>',
    );
    expect(result.returnType).toBe('0x1::option::Option<u128>');
    expect(result.parameters).toHaveLength(4);
  });

  it('parses friend entry function', () => {
    const result = parseMoveSignature(
      'friend entry fun delist_market(admin: &signer, market: 0x1::object::Object<perp_market::PerpMarket>, reason: 0x1::option::Option<0x1::string::String>)',
    );
    expect(result.visibility).toBe('friend');
    expect(result.isEntry).toBe(true);
    expect(result.name).toBe('delist_market');
    expect(result.parameters).toHaveLength(3);
  });

  it('returns default values for empty string', () => {
    const result = parseMoveSignature('');
    expect(result.visibility).toBe('private');
    expect(result.isEntry).toBe(false);
    expect(result.name).toBe('');
    expect(result.parameters).toHaveLength(0);
    expect(result.returnType).toBeNull();
  });

  it('returns empty name when fun keyword is missing', () => {
    const result = parseMoveSignature('public something_else(x: u64)');
    expect(result.name).toBe('');
  });

  it('defaults to private visibility when none specified', () => {
    const result = parseMoveSignature('fun helper(x: u64): u64');
    expect(result.visibility).toBe('private');
    expect(result.isEntry).toBe(false);
    expect(result.name).toBe('helper');
    expect(result.parameters).toHaveLength(1);
    expect(result.returnType).toBe('u64');
  });

  it('parses function with empty parameter list', () => {
    const result = parseMoveSignature('public fun now(): u64');
    expect(result.name).toBe('now');
    expect(result.parameters).toHaveLength(0);
    expect(result.returnType).toBe('u64');
  });

  it('parses generics with simple ability constraints', () => {
    const result = parseMoveSignature('public fun borrow<T: key + store>(id: u64): &T');
    expect(result.typeParams).toEqual([
      { name: 'T', constraints: ['key', 'store'], isPhantom: false },
    ]);
  });

  it('parses generics with phantom marker', () => {
    const result = parseMoveSignature('public fun mint<phantom CoinType>(amount: u64)');
    expect(result.typeParams).toEqual([{ name: 'CoinType', constraints: [], isPhantom: true }]);
  });

  it('parses generics with nested angle brackets in constraint (D-SIG-1)', () => {
    const result = parseMoveSignature('public fun f<T: Foo<U>, V>(x: T, y: V): u64');
    expect(result.typeParams).toHaveLength(2);
    expect(result.typeParams[0]).toEqual({ name: 'T', constraints: ['Foo<U>'], isPhantom: false });
    expect(result.typeParams[1]).toEqual({ name: 'V', constraints: [], isPhantom: false });
  });

  it('parses generics with multi-arg nested instantiation in constraint (D-SIG-1)', () => {
    const result = parseMoveSignature('public fun pair<T: Bar<u64, address>, V>(x: T): V');
    expect(result.typeParams).toHaveLength(2);
    expect(result.typeParams[0].name).toBe('T');
    expect(result.typeParams[0].constraints).toEqual(['Bar<u64, address>']);
    expect(result.typeParams[1]).toEqual({ name: 'V', constraints: [], isPhantom: false });
  });

  it('preserves generic type arguments in acquires resource paths (D-SIG-2)', () => {
    const result = parseMoveSignature(
      'public fun take<T>(): u64 acquires 0x1::coin::CoinStore<AptosCoin>',
    );
    expect(result.acquires).toEqual(['0x1::coin::CoinStore<AptosCoin>']);
  });

  it('parses acquires with multiple generic resources (D-SIG-2)', () => {
    const result = parseMoveSignature(
      'public fun multi<T>(): u64 acquires Store<u64>, Vault<address, u128>',
    );
    expect(result.acquires).toEqual(['Store<u64>', 'Vault<address, u128>']);
  });

  it('strips source terminators from acquires clauses (D-SIG-2)', () => {
    const result = parseMoveSignature('public fun f() acquires Store;');
    expect(result.acquires).toEqual(['Store']);
  });

  it('keeps nested lambda type as a single parameter (D-SIG-3 narrow case)', () => {
    const result = parseMoveSignature('public fun f(g: |x: |u64| u64| u64, y: u64): u64');
    // The nested lambda parameter should not be split into multiple parameters
    // by the comma scanner when its inner arg list contains no commas.
    expect(result.parameters).toHaveLength(2);
    expect(result.parameters[0].name).toBe('g');
    expect(result.parameters[1]).toEqual({ name: 'y', type: 'u64' });
  });

  it('keeps nested lambda with multi-arg inner list as a single parameter (D-SIG-3)', () => {
    const result = parseMoveSignature('public fun f(g: |x: |u64, address| u64| u64, y: u64): u64');
    expect(result.parameters).toHaveLength(2);
    expect(result.parameters[0].name).toBe('g');
    expect(result.parameters[0].type).toBe('|x: |u64, address| u64| u64');
    expect(result.parameters[1]).toEqual({ name: 'y', type: 'u64' });
  });

  it('keeps lambda-returning-lambda types as a single parameter (D-SIG-3)', () => {
    const result = parseMoveSignature('public fun f(g: |u64| |u8, u16| u8, y: u64): u64');
    expect(result.parameters).toHaveLength(2);
    expect(result.parameters[0]).toEqual({ name: 'g', type: '|u64| |u8, u16| u8' });
    expect(result.parameters[1]).toEqual({ name: 'y', type: 'u64' });
  });

  it('keeps zero-arg lambda-returning-lambda types as a single parameter (D-SIG-3)', () => {
    const result = parseMoveSignature('public fun f(g: || |u8, u16| u8, y: u64): u64');
    expect(result.parameters).toHaveLength(2);
    expect(result.parameters[0]).toEqual({ name: 'g', type: '|| |u8, u16| u8' });
    expect(result.parameters[1]).toEqual({ name: 'y', type: 'u64' });
  });
});
