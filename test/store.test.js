import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FlagStore, FlagValidationError, parseFlags } from '../src/store.js';

const valid = { key: 'my-flag', enabled: true };

const expectError = (document, pattern) => {
  assert.throws(() => parseFlags(document), (error) => {
    assert.ok(error instanceof FlagValidationError, `expected FlagValidationError, got ${error.name}`);
    assert.match(error.message, pattern);
    return true;
  });
};

describe('parseFlags', () => {
  it('accepts a bare array', () => {
    assert.equal(parseFlags([valid]).length, 1);
  });

  it('accepts an object with a flags array', () => {
    assert.equal(parseFlags({ flags: [valid] }).length, 1);
  });

  it('accepts a JSON string', () => {
    assert.equal(parseFlags(JSON.stringify({ flags: [valid] })).length, 1);
  });

  it('defaults rolloutPercentage to 100', () => {
    assert.equal(parseFlags([valid])[0].rolloutPercentage, 100);
  });

  it('defaults include and exclude to empty', () => {
    const flag = parseFlags([valid])[0];
    assert.deepEqual([...flag.include], []);
    assert.deepEqual([...flag.exclude], []);
  });

  it('freezes flags so evaluation cannot mutate them', () => {
    const flag = parseFlags([valid])[0];
    assert.throws(() => {
      flag.enabled = false;
    }, TypeError);
  });
});

describe('parseFlags validation', () => {
  it('rejects a non-array document', () => {
    expectError({ nope: [] }, /expected a JSON array/);
  });

  it('rejects a missing key', () => {
    expectError([{ enabled: true }], /'key' must match/);
  });

  it('rejects an uppercase key', () => {
    expectError([{ key: 'MyFlag', enabled: true }], /'key' must match/);
  });

  it('rejects a missing enabled field', () => {
    expectError([{ key: 'my-flag' }], /'enabled' is required/);
  });

  it('rejects a non-boolean enabled field', () => {
    expectError([{ key: 'my-flag', enabled: 'yes' }], /'enabled' is required/);
  });

  it('rejects an out-of-range rollout', () => {
    expectError([{ ...valid, rolloutPercentage: 101 }], /between 0 and 100/);
    expectError([{ ...valid, rolloutPercentage: -1 }], /between 0 and 100/);
  });

  it('rejects a fractional rollout', () => {
    expectError([{ ...valid, rolloutPercentage: 12.5 }], /between 0 and 100/);
  });

  it('rejects unknown fields, which are usually typos', () => {
    expectError([{ ...valid, rollout: 50 }], /unknown field\(s\): rollout/);
  });

  it('rejects a non-string subject list', () => {
    expectError([{ ...valid, include: [42] }], /'include' must be an array of non-empty strings/);
  });

  it('rejects a subject in both include and exclude', () => {
    expectError([{ ...valid, include: ['a'], exclude: ['a'] }], /both include and exclude/);
  });

  it('rejects duplicate keys and names both positions', () => {
    expectError([valid, valid], /duplicate key 'my-flag'.*flags\[0\]/);
  });

  it('names the offending index', () => {
    expectError([valid, { key: 'ok' }], /flags\[1\]/);
  });
});

describe('FlagStore', () => {
  const store = FlagStore.fromDocument({
    flags: [
      { key: 'zebra', enabled: true },
      { key: 'alpha', enabled: false },
    ],
  });

  it('looks flags up by key', () => {
    assert.equal(store.get('alpha').enabled, false);
    assert.equal(store.get('missing'), undefined);
  });

  it('reports membership', () => {
    assert.equal(store.has('zebra'), true);
    assert.equal(store.has('missing'), false);
  });

  it('lists flags in a stable order', () => {
    assert.deepEqual(store.list().map((f) => f.key), ['alpha', 'zebra']);
  });

  it('reports its size', () => {
    assert.equal(store.size, 2);
    assert.equal(new FlagStore().size, 0);
  });
});
