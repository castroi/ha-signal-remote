/**
 * Home Assistant WebSocket adapter + WS-health gate (design §5, §7).
 *
 * The adapter authenticates with the same scoped token used for REST (§6),
 * subscribes to `state_changed`, and forwards end-state to the state machine as
 * the completion-ack / timeout detector.
 *
 * The WsHealthGate is the fail-closed cover policy: covers are disabled whenever
 * the WS is not continuously healthy for the debounce window, so a flapping
 * connection cannot briefly re-enable covers and accept an untrackable command.
 * Lights are unaffected — the gate only reports cover state.
 */

export interface WsHealthGateOptions {
  readonly debounceMs: number;
  readonly now: () => number;
}

export class WsHealthGate {
  private readonly debounceMs: number;
  private readonly now: () => number;
  private connected = false;
  /** When the current continuous-healthy streak began; undefined if down. */
  private healthySince: number | undefined = undefined;

  constructor(opts: WsHealthGateOptions) {
    this.debounceMs = opts.debounceMs;
    this.now = opts.now;
  }

  onConnected(): void {
    if (!this.connected) {
      this.connected = true;
      this.healthySince = this.now();
    }
  }

  onDisconnected(): void {
    this.connected = false;
    this.healthySince = undefined;
  }

  /** Covers enabled only after the WS has been healthy for the full debounce. */
  coversEnabled(): boolean {
    if (!this.connected || this.healthySince === undefined) return false;
    return this.now() - this.healthySince >= this.debounceMs;
  }

  refusalReason(): 'ws-down' | undefined {
    return this.coversEnabled() ? undefined : 'ws-down';
  }
}

/**
 * Bounded exponential backoff with two-sided jitter (item 9).
 *
 * Previous: step + floor(rng() * step) → range [step, 2·step), could exceed cap,
 * jitter was one-sided (only upward).
 *
 * Fixed: clamp the computed step to capMs first, then apply ±50% jitter so the
 * result is in [step*0.5, step*1.5], clamped again to [1, capMs].
 */
export function computeBackoff(
  attempt: number,
  baseMs: number,
  capMs: number,
  rng: () => number = Math.random,
): number {
  const step = Math.min(capMs, baseMs * 2 ** attempt);
  // Two-sided jitter: ±50% of the step, so range is [step*0.5, step*1.5].
  const jitter = (rng() - 0.5) * step;
  return Math.max(1, Math.min(capMs, Math.round(step + jitter)));
}

export interface HaWsSocket {
  send(data: string): void;
  onMessage(handler: (raw: string) => void): void;
  onClose(handler: () => void): void;
}

export interface StateChange {
  readonly entityId: string;
  readonly state: string;
}

export interface HaWsClientOptions {
  readonly socket: HaWsSocket;
  readonly token: string;
  readonly onStateChanged: (change: StateChange) => void;
  readonly onConnected?: () => void;
  readonly onDisconnected?: () => void;
}

interface HaWsFrame {
  type?: string;
  event?: {
    event_type?: string;
    data?: { entity_id?: string; new_state?: { state?: string } };
  };
}

export class HaWsClient {
  private readonly socket: HaWsSocket;
  private readonly token: string;
  private readonly onStateChanged: (change: StateChange) => void;
  private readonly onConnected: () => void;
  private readonly onDisconnected: () => void;
  private subscriptionId = 1;

  constructor(opts: HaWsClientOptions) {
    this.socket = opts.socket;
    this.token = opts.token;
    this.onStateChanged = opts.onStateChanged;
    this.onConnected = opts.onConnected ?? (() => {});
    this.onDisconnected = opts.onDisconnected ?? (() => {});
  }

  start(): void {
    this.socket.onMessage((raw) => this.handle(raw));
    this.socket.onClose(() => this.onDisconnected());
  }

  private handle(raw: string): void {
    let frame: HaWsFrame;
    try {
      frame = JSON.parse(raw) as HaWsFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case 'auth_required':
        this.socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        return;
      case 'auth_ok':
        this.socket.send(
          JSON.stringify({
            id: this.subscriptionId++,
            type: 'subscribe_events',
            event_type: 'state_changed',
          }),
        );
        this.onConnected();
        return;
      case 'event': {
        if (frame.event?.event_type !== 'state_changed') return;
        const entityId = frame.event.data?.entity_id;
        const state = frame.event.data?.new_state?.state;
        if (entityId === undefined || state === undefined) return;
        this.onStateChanged({ entityId, state });
        return;
      }
      default:
        return;
    }
  }
}
