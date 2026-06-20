import type { Tunables } from '../app/config.js';

/**
 * Freshness gate + future-timestamp guard (design §5). Stateless: depends only on
 * the Signal envelope timestamp and the current clock.
 *
 * - now - envelopeTs > freshnessWindow  -> stale (refuse + ask to resend)
 * - envelopeTs - now > futureTolerance  -> clock-unhealthy (NOT a normal refusal;
 *   a future-dated envelope is a clock-disagreement safety event, handled by the
 *   clock-health policy which puts covers in safe-mode)
 * - otherwise                            -> fresh
 *
 * The future check is evaluated first: a far-future timestamp would otherwise pass
 * the one-sided age check trivially (negative age).
 */

export interface FreshnessInput {
  readonly now: number;
  readonly envelopeTs: number;
  readonly tunables: Tunables;
}

export type FreshnessResult =
  | { kind: 'fresh' }
  | { kind: 'stale'; ageMs: number }
  | { kind: 'clock-unhealthy'; futureEnvelopeMs: number };

export function checkFreshness(input: FreshnessInput): FreshnessResult {
  const { now, envelopeTs, tunables } = input;
  const ageMs = now - envelopeTs;

  if (-ageMs > tunables.futureToleranceMs) {
    return { kind: 'clock-unhealthy', futureEnvelopeMs: -ageMs };
  }
  if (ageMs > tunables.freshnessWindowMs) {
    return { kind: 'stale', ageMs };
  }
  return { kind: 'fresh' };
}
