import { describe, it, expect } from 'vitest';
import { DEFAULT_TUNABLES } from '../app/config.js';
import { checkFreshness } from './freshness.js';

const t = DEFAULT_TUNABLES;
const now = 1_000_000_000_000;

describe('checkFreshness (design §5)', () => {
  it('passes a command inside the freshness window', () => {
    const r = checkFreshness({ now, envelopeTs: now - 5_000, tunables: t });
    expect(r.kind).toBe('fresh');
  });

  it('passes a command exactly at the window edge', () => {
    const r = checkFreshness({ now, envelopeTs: now - 30_000, tunables: t });
    expect(r.kind).toBe('fresh');
  });

  it('refuses a command older than the 30s window (ask to resend)', () => {
    const r = checkFreshness({ now, envelopeTs: now - 31_000, tunables: t });
    expect(r.kind).toBe('stale');
  });

  it('routes a future timestamp past 10s tolerance to the clock-unhealthy path', () => {
    const r = checkFreshness({ now, envelopeTs: now + 11_000, tunables: t });
    expect(r.kind).toBe('clock-unhealthy');
    if (r.kind === 'clock-unhealthy') expect(r.futureEnvelopeMs).toBe(11_000);
  });

  it('a small future skew within tolerance is still fresh (not a refusal)', () => {
    const r = checkFreshness({ now, envelopeTs: now + 5_000, tunables: t });
    expect(r.kind).toBe('fresh');
  });

  it('is stateless — repeated calls give the same answer', () => {
    const args = { now, envelopeTs: now - 31_000, tunables: t };
    expect(checkFreshness(args).kind).toBe(checkFreshness(args).kind);
  });
});
