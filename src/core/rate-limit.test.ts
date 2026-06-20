import { describe, it, expect } from 'vitest';
import { DEFAULT_TUNABLES } from '../app/config.js';
import { RateLimiter } from './rate-limit.js';

const t = DEFAULT_TUNABLES;

describe('RateLimiter (design §5, go-live gate 7)', () => {
  it('allows up to the per-sender cap then trips', () => {
    const now = 0;
    const rl = new RateLimiter({ tunables: t, now: () => now });
    for (let i = 0; i < 5; i++) {
      expect(rl.allowCommand('s1').allowed).toBe(true);
    }
    const sixth = rl.allowCommand('s1');
    expect(sixth.allowed).toBe(false);
    if (!sixth.allowed) expect(sixth.reason).toBe('rate-limited');
  });

  it('the per-sender window slides — capacity returns after 30s', () => {
    let now = 0;
    const rl = new RateLimiter({ tunables: t, now: () => now });
    for (let i = 0; i < 5; i++) rl.allowCommand('s1');
    expect(rl.allowCommand('s1').allowed).toBe(false);
    now += 30_001;
    expect(rl.allowCommand('s1').allowed).toBe(true);
  });

  it('trips on the global burst cap even across senders', () => {
    const now = 0;
    const rl = new RateLimiter({ tunables: t, now: () => now });
    // 15 global cap; spread across senders so per-sender (5) is not the limiter.
    let allowed = 0;
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 4; i++) {
        if (rl.allowCommand(`sender${s}`).allowed) allowed++;
      }
    }
    expect(allowed).toBe(15); // global cap reached, remaining rejected
  });

  it('a valid confirm bypasses a tripped command cap (confirm lane)', () => {
    const now = 0;
    const rl = new RateLimiter({ tunables: t, now: () => now });
    for (let i = 0; i < 5; i++) rl.allowCommand('s1');
    expect(rl.allowCommand('s1').allowed).toBe(false); // command cap tripped
    // but a confirm still resolves
    expect(rl.allowConfirm('s1').allowed).toBe(true);
  });

  it('the confirm lane itself is capped at 6/sender/minute', () => {
    const now = 0;
    const rl = new RateLimiter({ tunables: t, now: () => now });
    for (let i = 0; i < 6; i++) {
      expect(rl.allowConfirm('s1').allowed).toBe(true);
    }
    const seventh = rl.allowConfirm('s1');
    expect(seventh.allowed).toBe(false);
    if (!seventh.allowed) expect(seventh.reason).toBe('confirm-spam');
  });

  it('confirm-lane cap is per-sender (one sender spamming does not block another)', () => {
    const now = 0;
    const rl = new RateLimiter({ tunables: t, now: () => now });
    for (let i = 0; i < 6; i++) rl.allowConfirm('s1');
    expect(rl.allowConfirm('s1').allowed).toBe(false);
    expect(rl.allowConfirm('s2').allowed).toBe(true);
  });
});
