import { describe, it, expect } from 'vitest';
import { DEFAULT_TUNABLES } from '../app/config.js';
import { evaluateClockHealth, type ClockInputs } from './clock-health.js';

const t = DEFAULT_TUNABLES;
const base = 1_000_000_000_000; // fixed "now"

function inputs(over: Partial<ClockInputs>): ClockInputs {
  return {
    now: base,
    skewSampleMs: 0,
    lastGoodCheckAt: base,
    allReferencesUnreachable: false,
    futureEnvelopeMs: undefined,
    tunables: t,
    ...over,
  };
}

describe('evaluateClockHealth (design §5)', () => {
  it('healthy when skew within threshold and references reachable', () => {
    const r = evaluateClockHealth(inputs({ skewSampleMs: 5_000 }));
    expect(r.status).toBe('healthy');
    expect(r.coversEnabled).toBe(true);
  });

  it('unhealthy when skew exceeds 30s threshold', () => {
    const r = evaluateClockHealth(inputs({ skewSampleMs: 31_000 }));
    expect(r.status).toBe('unhealthy');
    if (r.status === 'unhealthy') expect(r.reason).toBe('skew');
    expect(r.coversEnabled).toBe(false);
  });

  it('future timestamp past tolerance routes to clock-unhealthy (not refusal)', () => {
    const r = evaluateClockHealth(inputs({ futureEnvelopeMs: 11_000 }));
    expect(r.status).toBe('unhealthy');
    if (r.status === 'unhealthy') expect(r.reason).toBe('future-timestamp');
    expect(r.coversEnabled).toBe(false);
  });

  it('future timestamp within tolerance does not trip', () => {
    const r = evaluateClockHealth(inputs({ futureEnvelopeMs: 9_000 }));
    expect(r.status).toBe('healthy');
  });

  it('all references unreachable but within 1h grace stays healthy', () => {
    const r = evaluateClockHealth(
      inputs({
        allReferencesUnreachable: true,
        lastGoodCheckAt: base - 59 * 60 * 1000, // 59 min ago
      }),
    );
    expect(r.status).toBe('healthy');
    expect(r.coversEnabled).toBe(true);
  });

  it('all references unreachable past 1h grace fails safe (covers disabled)', () => {
    const r = evaluateClockHealth(
      inputs({
        allReferencesUnreachable: true,
        lastGoodCheckAt: base - 61 * 60 * 1000, // 61 min ago
      }),
    );
    expect(r.status).toBe('unhealthy');
    if (r.status === 'unhealthy') expect(r.reason).toBe('offline-grace-expired');
    expect(r.coversEnabled).toBe(false);
  });

  it('lights are never affected by clock state (coversEnabled is the only gate)', () => {
    const unhealthy = evaluateClockHealth(inputs({ skewSampleMs: 99_000 }));
    // The policy only reports coversEnabled; nothing in it disables lights.
    expect(unhealthy).not.toHaveProperty('lightsEnabled');
  });
});
