import { createHmac } from 'node:crypto';

/**
 * Privacy-safe audit logger (design §6).
 *
 * Emits only: timestamp, salted UUID hash, normalized intent, entity, result,
 * latency, and a failure/reason code. The raw message body is NEVER logged, the
 * raw UUID is NEVER logged (only an HMAC over it with the configured salt), and
 * the salt itself is never emitted.
 *
 * The event type is a closed shape: there is no field for a raw body, and the
 * logger explicitly projects only the known fields, so an attached body cannot
 * leak even if a caller spreads extra keys in.
 */

export type AuditResult =
  | 'observed_target'
  | 'timeout'
  | 'preempted'
  | 'failed'
  | 'issued'
  | 'rejected'
  | 'confirm_prompt'
  | 'status'
  | 'help'
  | 'reinitialized';

export type AuditReasonCode =
  | 'rate-limited'
  | 'confirm-spam'
  | 'stale'
  | 'clock-unhealthy'
  | 'ws-down'
  | 'kill-switch'
  | 'entity-unknown'
  | 'no-verb'
  | 'ambiguous'
  | 'unrecognized-control-reply'
  // Fix item 9 (LOW): distinct code for unknown senders (previously reused
  // 'entity-unknown') so audit lines are unambiguous.
  | 'unknown-sender'
  // Fix item 4 (MED): per-entity HA-call failure in an all-covers command.
  | 'entity-issue-failed'
  // Issue #1: preset-position cover commands — live position unreadable, and a
  // deliberate no-op where the cover is already at/past the requested position.
  | 'position-unknown'
  | 'noop-already-there';

export interface AuditEvent {
  readonly ts: number;
  readonly sourceUuid: string;
  readonly intent: string;
  readonly entity: string | undefined;
  readonly result: AuditResult;
  readonly latencyMs: number | undefined;
  readonly reasonCode: AuditReasonCode | undefined;
  readonly commandId?: string;
}

export interface AuditOptions {
  readonly salt: string;
  /** Sink for one serialized record per call; defaults to console.log. */
  readonly sink?: (line: string) => void;
}

export class AuditLogger {
  private readonly salt: string;
  private readonly sink: (line: string) => void;

  constructor(opts: AuditOptions) {
    this.salt = opts.salt;
    this.sink = opts.sink ?? ((line) => console.log(line));
  }

  private hashUuid(uuid: string): string {
    return createHmac('sha256', this.salt).update(uuid).digest('hex');
  }

  log(event: AuditEvent): void {
    // Explicit projection: only these fields are ever serialized.
    const record = {
      ts: event.ts,
      uuidHash: this.hashUuid(event.sourceUuid),
      intent: event.intent,
      entity: event.entity,
      result: event.result,
      latencyMs: event.latencyMs,
      reasonCode: event.reasonCode,
      commandId: event.commandId,
    };
    this.sink(JSON.stringify(record));
  }
}
