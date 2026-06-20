/**
 * Always-on dedup cache (design §5). RAM-only, TTL 90s by default.
 *
 * Key = (sourceUuid, envelope_timestamp, normalized_command). The timestamp is
 * load-bearing: two genuine identical commands at different times both run; a
 * redelivery shares the key and is dropped.
 */

export interface DedupKey {
  readonly sourceUuid: string;
  readonly envelopeTs: number;
  readonly normalizedCommand: string;
}

export interface DedupOptions {
  readonly ttlMs: number;
  readonly now?: () => number;
}

// ASCII unit separator: cannot appear in normalized Hebrew text or a UUID.
const SEP = '\x1f';

function keyOf(k: DedupKey): string {
  return `${k.sourceUuid}${SEP}${k.envelopeTs}${SEP}${k.normalizedCommand}`;
}

export class DedupCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, number>(); // key -> expiry epoch ms

  constructor(opts: DedupOptions) {
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Returns true if this key was already seen within the TTL (i.e. a duplicate
   * that should be dropped). Returns false for a first sighting and records it.
   */
  seen(key: DedupKey): boolean {
    const now = this.now();
    const k = keyOf(key);
    const expiry = this.entries.get(k);
    if (expiry !== undefined && expiry > now) {
      return true;
    }
    this.entries.set(k, now + this.ttlMs);
    return false;
  }

  /** Remove expired entries so RAM use stays bounded. */
  sweep(): void {
    const now = this.now();
    for (const [k, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(k);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
