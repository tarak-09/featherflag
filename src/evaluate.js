/**
 * Flag evaluation.
 *
 * Evaluation is pure and deterministic: the same flag and subject always
 * produce the same answer, on every replica, without coordination. That is what
 * makes a percentage rollout usable — a user who sees a feature on one request
 * must not lose it on the next because a different pod answered.
 */

import { createHash } from 'node:crypto';

export const Reason = {
  DISABLED: 'disabled',
  EXCLUDED: 'excluded',
  INCLUDED: 'included',
  ROLLOUT_IN: 'rollout_in',
  ROLLOUT_OUT: 'rollout_out',
  FULLY_ENABLED: 'fully_enabled',
};

/**
 * Map a subject into a stable bucket in [0, 100).
 *
 * The flag key is part of the hash input so a subject's position is independent
 * per flag. Hashing on the subject alone would mean the same unlucky users sit
 * outside every rollout forever.
 */
export function bucket(flagKey, subject) {
  const digest = createHash('sha256').update(`${flagKey}:${subject}`).digest();
  // 32 bits is far more resolution than the percent granularity needs, and
  // avoids the modulo bias a narrower read would introduce.
  return digest.readUInt32BE(0) % 100;
}

export function evaluate(flag, subject) {
  if (!flag.enabled) {
    return { key: flag.key, enabled: false, reason: Reason.DISABLED };
  }

  // Exclusions win over inclusions: an explicit "never this user" is a
  // stronger statement than any other rule, and is usually a live incident.
  if (flag.exclude.includes(subject)) {
    return { key: flag.key, enabled: false, reason: Reason.EXCLUDED };
  }

  if (flag.include.includes(subject)) {
    return { key: flag.key, enabled: true, reason: Reason.INCLUDED };
  }

  if (flag.rolloutPercentage >= 100) {
    return { key: flag.key, enabled: true, reason: Reason.FULLY_ENABLED };
  }

  if (flag.rolloutPercentage <= 0) {
    return { key: flag.key, enabled: false, reason: Reason.ROLLOUT_OUT };
  }

  const position = bucket(flag.key, subject);
  const inRollout = position < flag.rolloutPercentage;

  return {
    key: flag.key,
    enabled: inRollout,
    reason: inRollout ? Reason.ROLLOUT_IN : Reason.ROLLOUT_OUT,
    bucket: position,
  };
}
