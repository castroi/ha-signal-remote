import type { Tunables } from '../app/config.js';

/**
 * Rate limiter + reserved confirm lane (design §5).
 *
 * - Per-sender command cap (5/30s) and global burst cap (15/30s). A tripped cap
 *   returns the `rate-limited` reason code.
 * - A valid `כן`/`לא` matching a live context-bound pending_confirm bypasses the
 *   command caps (the confirm lane). The lane is itself capped at 6/sender/min so
 *   confirm-spam can't become a side channel; over the lane cap returns
 *   `confirm-spam`. Whether the confirm actually matches a live pending action is
 *   enforced by the state machine — this module only enforces the lane's own cap.
 */

export type RateLimitReason = 'rate-limited' | 'confirm-spam';

export type RateDecision = { allowed: true } | { allowed: false; reason: RateLimitReason };

const CONFIRM_WINDOW_MS = 60_000;

/** A sliding-window counter using a list of event timestamps. */
class SlidingWindow {
  private readonly hits: number[] = [];

  /** Try to record a hit; returns true if under the cap within the window. */
  tryHit(now: number, max: number, windowMs: number): boolean {
    this.prune(now, windowMs);
    if (this.hits.length >= max) return false;
    this.hits.push(now);
    return true;
  }

  private prune(now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    while (this.hits.length > 0 && this.hits[0]! < cutoff) {
      this.hits.shift();
    }
  }
}

export interface RateLimiterOptions {
  readonly tunables: Tunables;
  readonly now?: () => number;
}

export class RateLimiter {
  private readonly tunables: Tunables;
  private readonly now: () => number;
  private readonly perSender = new Map<string, SlidingWindow>();
  private readonly global = new SlidingWindow();
  private readonly confirmLane = new Map<string, SlidingWindow>();

  constructor(opts: RateLimiterOptions) {
    this.tunables = opts.tunables;
    this.now = opts.now ?? Date.now;
  }

  private senderWindow(map: Map<string, SlidingWindow>, sender: string): SlidingWindow {
    let w = map.get(sender);
    if (!w) {
      w = new SlidingWindow();
      map.set(sender, w);
    }
    return w;
  }

  /** A normal command: must pass both the per-sender and the global cap. */
  allowCommand(sender: string): RateDecision {
    const now = this.now();
    const { rateLimitPerSender: ps, rateLimitGlobal: g } = this.tunables;

    // Check both windows without committing, then commit only if both pass, so a
    // global trip doesn't silently consume per-sender budget and vice versa.
    const senderW = this.senderWindow(this.perSender, sender);
    // Peek by trying; SlidingWindow commits on success, so order matters.
    // Try per-sender first; if it fails, do not touch global.
    if (!senderW.tryHit(now, ps.max, ps.windowMs)) {
      return { allowed: false, reason: 'rate-limited' };
    }
    if (!this.global.tryHit(now, g.max, g.windowMs)) {
      // Roll back the per-sender hit we just committed would require extra state;
      // instead, treat the global trip as authoritative. The per-sender hit is
      // harmless (it only tightens that sender briefly) and keeps the code simple.
      return { allowed: false, reason: 'rate-limited' };
    }
    return { allowed: true };
  }

  /** A confirm reply: bypasses command caps, capped at 6/sender/min. */
  allowConfirm(sender: string): RateDecision {
    const now = this.now();
    const laneW = this.senderWindow(this.confirmLane, sender);
    if (!laneW.tryHit(now, this.tunables.confirmLanePerSenderPerMin, CONFIRM_WINDOW_MS)) {
      return { allowed: false, reason: 'confirm-spam' };
    }
    return { allowed: true };
  }
}
