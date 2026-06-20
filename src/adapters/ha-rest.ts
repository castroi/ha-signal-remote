/**
 * Home Assistant REST adapter (design §7, §6 A02/A03).
 *
 * Issues service calls over HTTP only — never shell strings. The long-lived token
 * is sent in the Authorization header and is never logged or echoed in errors.
 * Any non-2xx or transport error maps to a `failed` result so the state machine
 * never produces a false success ack.
 */

// CoverVerb and LightVerb are the canonical declarations in state-machine.ts;
// import and re-export from there to keep a single definition (item 11).
import type { CoverVerb, LightVerb } from '../core/state-machine.js';
export type { CoverVerb, LightVerb };

export type HaCallResult = { ok: true } | { ok: false; reason: 'failed' };

const COVER_SERVICE: Record<CoverVerb, string> = {
  open: 'open_cover',
  close: 'close_cover',
  stop: 'stop_cover',
};

const LIGHT_SERVICE: Record<LightVerb, string> = {
  on: 'turn_on',
  off: 'turn_off',
};

export interface HaRestOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class HaRestClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HaRestOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  callCover(entityId: string, verb: CoverVerb): Promise<HaCallResult> {
    return this.callService('cover', COVER_SERVICE[verb], entityId);
  }

  callLight(entityId: string, verb: LightVerb): Promise<HaCallResult> {
    return this.callService('light', LIGHT_SERVICE[verb], entityId);
  }

  private async callService(
    domain: string,
    service: string,
    entityId: string,
  ): Promise<HaCallResult> {
    const url = `${this.baseUrl}/api/services/${domain}/${service}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ entity_id: entityId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Deliberately do not include response body or token in the result.
        return { ok: false, reason: 'failed' };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: 'failed' };
    } finally {
      clearTimeout(timer);
    }
  }
}
