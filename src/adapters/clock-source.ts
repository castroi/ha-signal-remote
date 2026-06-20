/**
 * Clock-source adapter (design §5). Tries an ordered list of external time
 * references; "unreachable" means every reference failed within the check
 * timeout. Returns a skew sample (local now minus reference time) when at least
 * one reference answers.
 *
 * The reference probe is injected so the policy stays testable without network.
 */

export interface ReferenceProbe {
  /** Returns the reference's current epoch ms, or rejects/throws on failure. */
  (signal: AbortSignal): Promise<number>;
}

export interface ClockCheckResult {
  readonly allReferencesUnreachable: boolean;
  /** Local-minus-reference skew in ms, undefined when all unreachable. */
  readonly skewSampleMs: number | undefined;
  readonly checkedAt: number;
}

export interface ClockSourceOptions {
  readonly references: readonly ReferenceProbe[];
  readonly checkTimeoutMs: number;
  readonly now?: () => number;
}

export class ClockSource {
  private readonly references: readonly ReferenceProbe[];
  private readonly checkTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: ClockSourceOptions) {
    this.references = opts.references;
    this.checkTimeoutMs = opts.checkTimeoutMs;
    this.now = opts.now ?? Date.now;
  }

  async check(): Promise<ClockCheckResult> {
    const checkedAt = this.now();
    for (const probe of this.references) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.checkTimeoutMs);
      try {
        const referenceMs = await probe(controller.signal);
        clearTimeout(timer);
        return {
          allReferencesUnreachable: false,
          skewSampleMs: this.now() - referenceMs,
          checkedAt,
        };
      } catch {
        clearTimeout(timer);
        // Try the next reference in order.
      }
    }
    return { allReferencesUnreachable: true, skewSampleMs: undefined, checkedAt };
  }
}
