import type { Tunables } from '../app/config.js';

/**
 * Clock-health policy (design §5). Pure: given skew samples, last-good time, now,
 * reference reachability and an optional future-envelope delta, decide whether the
 * clock is healthy and therefore whether covers may operate.
 *
 * Only covers are gated by clock health. Lights are unaffected, so this policy
 * deliberately reports `coversEnabled` and nothing about lights.
 */

export type ClockUnhealthyReason = 'skew' | 'future-timestamp' | 'offline-grace-expired';

export interface ClockInputs {
  readonly now: number;
  /** Measured absolute skew against the external reference, ms. */
  readonly skewSampleMs: number;
  /** Timestamp of the last successful reference check. */
  readonly lastGoodCheckAt: number;
  /** True when every configured reference failed within the check timeout. */
  readonly allReferencesUnreachable: boolean;
  /**
   * If a message envelope timestamp is ahead of `now`, how far ahead (ms).
   * Undefined when evaluating periodic health without a message in hand.
   */
  readonly futureEnvelopeMs: number | undefined;
  readonly tunables: Tunables;
}

export type ClockHealth =
  | { status: 'healthy'; coversEnabled: true }
  | { status: 'unhealthy'; reason: ClockUnhealthyReason; coversEnabled: false };

export function evaluateClockHealth(input: ClockInputs): ClockHealth {
  const { tunables: t } = input;

  // A future-dated envelope past tolerance is a clock disagreement -> safety event.
  if (input.futureEnvelopeMs !== undefined && input.futureEnvelopeMs > t.futureToleranceMs) {
    return { status: 'unhealthy', reason: 'future-timestamp', coversEnabled: false };
  }

  // Measured skew over threshold -> covers safe-mode.
  if (Math.abs(input.skewSampleMs) > t.clockSkewThresholdMs) {
    return { status: 'unhealthy', reason: 'skew', coversEnabled: false };
  }

  // All references unreachable: stay healthy within the last-known-good grace,
  // then fail safe.
  if (input.allReferencesUnreachable) {
    const sinceGood = input.now - input.lastGoodCheckAt;
    if (sinceGood > t.clockOfflineGraceMs) {
      return { status: 'unhealthy', reason: 'offline-grace-expired', coversEnabled: false };
    }
  }

  return { status: 'healthy', coversEnabled: true };
}
