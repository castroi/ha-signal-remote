import { describe, it, expect } from 'vitest';
import { DedupCache } from './dedup.js';

describe('DedupCache (design §5, go-live gate 6)', () => {
  it('accepts a first-seen command and drops an exact redelivery', () => {
    const now = 1000;
    const cache = new DedupCache({ ttlMs: 90_000, now: () => now });
    const key = { sourceUuid: 'u1', envelopeTs: 5000, normalizedCommand: 'close salon' };

    expect(cache.seen(key)).toBe(false); // first delivery -> process
    expect(cache.seen(key)).toBe(true); // redelivery -> drop
  });

  it('two genuine same-text commands at different timestamps both pass', () => {
    const now = 1000;
    const cache = new DedupCache({ ttlMs: 90_000, now: () => now });
    expect(
      cache.seen({ sourceUuid: 'u1', envelopeTs: 5000, normalizedCommand: 'close salon' }),
    ).toBe(false);
    expect(
      cache.seen({ sourceUuid: 'u1', envelopeTs: 6000, normalizedCommand: 'close salon' }),
    ).toBe(false);
  });

  it('different senders with same text+timestamp are distinct', () => {
    const now = 1000;
    const cache = new DedupCache({ ttlMs: 90_000, now: () => now });
    const k = { envelopeTs: 5000, normalizedCommand: 'close salon' };
    expect(cache.seen({ ...k, sourceUuid: 'u1' })).toBe(false);
    expect(cache.seen({ ...k, sourceUuid: 'u2' })).toBe(false);
  });

  it('entries expire after the TTL', () => {
    let now = 1000;
    const cache = new DedupCache({ ttlMs: 90_000, now: () => now });
    const key = { sourceUuid: 'u1', envelopeTs: 5000, normalizedCommand: 'close salon' };
    expect(cache.seen(key)).toBe(false);
    now += 90_001; // past TTL
    expect(cache.seen(key)).toBe(false); // expired -> treated as new
  });

  it('sweep removes expired entries (RAM not unbounded)', () => {
    let now = 1000;
    const cache = new DedupCache({ ttlMs: 90_000, now: () => now });
    cache.seen({ sourceUuid: 'u1', envelopeTs: 5000, normalizedCommand: 'a' });
    cache.seen({ sourceUuid: 'u1', envelopeTs: 5000, normalizedCommand: 'b' });
    expect(cache.size()).toBe(2);
    now += 90_001;
    cache.sweep();
    expect(cache.size()).toBe(0);
  });
});
