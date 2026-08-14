import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bucket, evaluate, Reason } from '../src/evaluate.js';

const flag = (overrides = {}) => ({
  key: 'test-flag',
  enabled: true,
  rolloutPercentage: 100,
  include: [],
  exclude: [],
  ...overrides,
});

describe('bucket', () => {
  it('is deterministic for the same flag and subject', () => {
    assert.equal(bucket('flag-a', 'user-1'), bucket('flag-a', 'user-1'));
  });

  it('always lands in [0, 100)', () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = bucket('flag-a', `user-${i}`);
      assert.ok(Number.isInteger(value) && value >= 0 && value < 100, `got ${value}`);
    }
  });

  it('places the same subject differently across flags', () => {
    // Hashing on the subject alone would leave the same unlucky users outside
    // every rollout forever.
    const positions = ['flag-a', 'flag-b', 'flag-c', 'flag-d'].map((key) => bucket(key, 'user-1'));
    assert.ok(new Set(positions).size > 1, 'subject occupies an identical bucket in every flag');
  });

  it('distributes roughly uniformly', () => {
    const subjects = Array.from({ length: 10000 }, (_, i) => `user-${i}`);
    const under10 = subjects.filter((s) => bucket('rollout', s) < 10).length;
    // Expect ~1000. A wide band keeps this from flaking while still catching a
    // hash that clusters.
    assert.ok(under10 > 850 && under10 < 1150, `expected ~1000 in the first decile, got ${under10}`);
  });
});

describe('evaluate', () => {
  it('returns disabled when the flag is off, ignoring rollout', () => {
    const result = evaluate(flag({ enabled: false, rolloutPercentage: 100 }), 'user-1');
    assert.deepEqual(result, { key: 'test-flag', enabled: false, reason: Reason.DISABLED });
  });

  it('honours an explicit include', () => {
    const result = evaluate(flag({ rolloutPercentage: 0, include: ['vip'] }), 'vip');
    assert.equal(result.enabled, true);
    assert.equal(result.reason, Reason.INCLUDED);
  });

  it('lets exclude win over include', () => {
    // An explicit "never this user" is usually a live incident, and is a
    // stronger statement than any other rule.
    const result = evaluate(flag({ include: ['user-1'], exclude: ['user-1'] }), 'user-1');
    assert.equal(result.enabled, false);
    assert.equal(result.reason, Reason.EXCLUDED);
  });

  it('lets exclude win over a full rollout', () => {
    const result = evaluate(flag({ rolloutPercentage: 100, exclude: ['user-1'] }), 'user-1');
    assert.equal(result.enabled, false);
  });

  it('enables everyone at 100 percent', () => {
    const result = evaluate(flag({ rolloutPercentage: 100 }), 'anyone');
    assert.equal(result.enabled, true);
    assert.equal(result.reason, Reason.FULLY_ENABLED);
  });

  it('enables nobody at 0 percent', () => {
    const result = evaluate(flag({ rolloutPercentage: 0 }), 'anyone');
    assert.equal(result.enabled, false);
    assert.equal(result.reason, Reason.ROLLOUT_OUT);
  });

  it('is stable across repeated evaluations', () => {
    const subject = 'user-42';
    const target = flag({ rolloutPercentage: 50 });
    const first = evaluate(target, subject);
    for (let i = 0; i < 100; i += 1) {
      assert.equal(evaluate(target, subject).enabled, first.enabled);
    }
  });

  it('never removes a subject when the rollout only grows', () => {
    // The property that makes a ramp safe: raising the percentage must not
    // take the feature away from anyone who already had it.
    const subjects = Array.from({ length: 500 }, (_, i) => `user-${i}`);

    for (const subject of subjects) {
      let wasEnabled = false;
      for (let pct = 0; pct <= 100; pct += 5) {
        const enabled = evaluate(flag({ rolloutPercentage: pct }), subject).enabled;
        if (wasEnabled) {
          assert.ok(enabled, `subject ${subject} lost the flag when rollout reached ${pct}%`);
        }
        wasEnabled = enabled;
      }
    }
  });

  it('reports the bucket for partial rollouts so decisions are debuggable', () => {
    const result = evaluate(flag({ rolloutPercentage: 50 }), 'user-1');
    assert.equal(typeof result.bucket, 'number');
  });
});
