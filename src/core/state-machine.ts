/**
 * Command state machine (design §5).
 *
 * Per-command lifecycle:
 *   received → pending_confirm? → issued → observed_target | timeout | preempted | failed
 *
 * The machine is pure-ish: it owns RAM-only per-command state and emits Effects
 * (issue HA call, send a reply) that the wiring layer executes. It consumes events
 * (submit, confirm, observeState, markEntityIssueFailed, tick). Time is injected.
 *
 * Every command tracks an outcome per device and resolves only when no device is
 * still pending; every transition goes through `settle()`. A one-device command
 * replies as before (success / timeout / failed / preempted); a multi-device
 * command replies once with a summary.
 *
 * Locked behaviors:
 * - Two-stage cover feedback (progress ack on receipt, success on observed target);
 *   single-stage for a single light or switch (toggle).
 * - Per-device completion timeout → `timeout` + manual-check reply, no success ack.
 * - Conflict preemption: a new command for a device already pending elsewhere
 *   preempts it there (covers also get a stop first). No queue.
 * - Batches are confirm-gated: `pending_confirm`, 20s expiry, bound to
 *   (same UUID + same pending action + live window).
 * - A device already at its target per the pre-issue snapshot is done at once —
 *   HA emits no state_changed for a no-op, so waiting would only time out.
 */

import type { EntitySnapshot } from './status.js';

export type CoverVerb = 'open' | 'close' | 'stop';
export type ToggleVerb = 'on' | 'off';
export type Verb = CoverVerb | ToggleVerb;

/** HA service domains that share the single-stage turn_on/turn_off pipeline. */
export type ToggleDomain = 'light' | 'switch';

/** How long a resolved record is kept before `prune()` drops it. */
const RESOLVED_RETENTION_MS = 10 * 60_000;

/** A preset move is complete when the observed position is within ±tolerance of the target. */
function reachesPosition(target: PositionTarget, observedPosition?: number): boolean {
  if (observedPosition === undefined) return false;
  return Math.abs(observedPosition - target.position) <= target.tolerancePercent;
}

/** A preset target position (issue #1): drive the cover to `position`, ack within ±tolerance. */
export interface PositionTarget {
  readonly position: number;
  readonly tolerancePercent: number;
}

export interface EntityRef {
  readonly entityId: string;
  readonly type: 'cover' | ToggleDomain;
  readonly completionTimeoutMs: number;
  /**
   * When set, this is a preset-position command: actuation goes through the
   * household script (`issue-cover-position`) and completion is judged by
   * observed `current_position` within tolerance rather than the state string.
   */
  readonly target?: PositionTarget | undefined;
}

export type CommandState =
  | 'pending_confirm'
  | 'issued'
  | 'observed_target'
  | 'timeout'
  | 'preempted'
  | 'failed';

type EntityOutcome = 'pending' | 'done' | 'failed' | 'timeout' | 'preempted';

export type Effect =
  | { kind: 'issue-cover'; commandId: string; entityId: string; verb: CoverVerb }
  | {
      kind: 'issue-cover-position';
      commandId: string;
      entityId: string;
      scriptDirection: 'open' | 'close';
      position: number;
    }
  | { kind: 'issue-cover-stop'; commandId: string; entityId: string }
  | {
      kind: 'issue-toggle';
      commandId: string;
      entityId: string;
      domain: ToggleDomain;
      verb: ToggleVerb;
    }
  | { kind: 'reply-progress'; commandId: string }
  | { kind: 'reply-success'; commandId: string }
  | { kind: 'reply-timeout'; commandId: string; entityId: string }
  | { kind: 'reply-failed'; commandId: string }
  | { kind: 'reply-preempted'; commandId: string }
  /** A multi-device command resolved; preempted devices are in no list. */
  | {
      kind: 'reply-summary';
      commandId: string;
      done: string[];
      failed: string[];
      timedOut: string[];
    }
  /** `preset`: at least one device moves to a configured position, not fully. */
  | { kind: 'reply-confirm-prompt'; commandId: string; count: number; verb: Verb; preset: boolean };

interface CommandRecord {
  readonly commandId: string;
  readonly sourceUuid: string;
  readonly verb: Verb;
  readonly entities: EntityRef[];
  state: CommandState;
  /** Per-device outcome, seeded when the command issues. */
  outcomes: Map<string, EntityOutcome>;
  /** Per-device completion deadlines, only for devices still pending. */
  completionDeadlines: Map<string, number>;
  /** Deadline for the pending-confirm expiry. */
  confirmDeadline: number | undefined;
  /** When the record reached a terminal state (for `prune()`). */
  resolvedAt: number | undefined;
}

export interface StateMachineOptions {
  readonly now: () => number;
  readonly decisionWindowMs: number;
  readonly confirmExpiryMs: number;
}

interface SubmitArgs {
  readonly commandId: string;
  readonly sourceUuid: string;
  readonly verb: Verb;
  readonly entity: EntityRef;
  /** Live states read just before issuing; devices already at target settle at once. */
  readonly snapshot?: ReadonlyMap<string, EntitySnapshot> | undefined;
}

interface SubmitAllArgs {
  readonly commandId: string;
  readonly sourceUuid: string;
  readonly verb: Verb;
  readonly entities: EntityRef[];
}

export class CommandStateMachine {
  private readonly now: () => number;
  private readonly confirmExpiryMs: number;
  private readonly commands = new Map<string, CommandRecord>();

  constructor(opts: StateMachineOptions) {
    this.now = opts.now;
    // decisionWindowMs is kept in StateMachineOptions for API compatibility; a
    // failed HA call settles that device as failed immediately (item 6).
    void opts.decisionWindowMs;
    this.confirmExpiryMs = opts.confirmExpiryMs;
  }

  stateOf(commandId: string): CommandState | undefined {
    return this.commands.get(commandId)?.state;
  }

  /** The devices a command targets (e.g. to snapshot them before a confirm issues). */
  entityIdsOf(commandId: string): string[] {
    return this.commands.get(commandId)?.entities.map((e) => e.entityId) ?? [];
  }

  /** A single-entity command (cover, light or switch). Issues immediately. */
  submit(args: SubmitArgs): Effect[] {
    const rec = this.newRecord(args.commandId, args.sourceUuid, args.verb, [args.entity]);
    rec.state = 'issued';
    this.commands.set(args.commandId, rec);
    const effects: Effect[] = [];
    this.issue(rec, effects, args.snapshot);
    return effects;
  }

  /** A batch command: enters pending_confirm with a stated consequence. */
  submitAll(args: SubmitAllArgs): Effect[] {
    const rec = this.newRecord(args.commandId, args.sourceUuid, args.verb, args.entities);
    rec.confirmDeadline = this.now() + this.confirmExpiryMs;
    this.commands.set(args.commandId, rec);
    return [
      {
        kind: 'reply-confirm-prompt',
        commandId: args.commandId,
        count: args.entities.length,
        verb: args.verb,
        preset: args.entities.some((e) => e.target !== undefined),
      },
    ];
  }

  /** Context-bound confirm: same UUID + same pending action + live window. */
  confirm(
    commandId: string,
    sourceUuid: string,
    snapshot?: ReadonlyMap<string, EntitySnapshot>,
  ): { accepted: boolean; effects: Effect[] } {
    const rec = this.commands.get(commandId);
    if (!rec || rec.state !== 'pending_confirm') return { accepted: false, effects: [] };
    if (rec.sourceUuid !== sourceUuid) return { accepted: false, effects: [] };
    if (rec.confirmDeadline !== undefined && this.now() > rec.confirmDeadline) {
      return { accepted: false, effects: [] };
    }
    rec.state = 'issued';
    rec.confirmDeadline = undefined;
    const effects: Effect[] = [];
    this.issue(rec, effects, snapshot);
    return { accepted: true, effects };
  }

  private newRecord(
    commandId: string,
    sourceUuid: string,
    verb: Verb,
    entities: EntityRef[],
  ): CommandRecord {
    return {
      commandId,
      sourceUuid,
      verb,
      entities,
      state: 'pending_confirm',
      outcomes: new Map(),
      completionDeadlines: new Map(),
      confirmDeadline: undefined,
      resolvedAt: undefined,
    };
  }

  /** Issue the command to HA and arrange feedback/timeouts. */
  private issue(
    rec: CommandRecord,
    effects: Effect[],
    snapshot?: ReadonlyMap<string, EntitySnapshot>,
  ): void {
    const now = this.now();
    for (const entity of rec.entities) {
      // Preempt any other command still waiting on this device.
      this.preemptHolder(entity, rec.commandId, effects);
      if (entity.type === 'cover') {
        if (entity.target) {
          // Preset-position command: actuate via the household script. The verb is
          // already base-mapped to open/close by the bridge before submit, so a
          // preset entity is only ever issued under 'open' or 'close'.
          effects.push({
            kind: 'issue-cover-position',
            commandId: rec.commandId,
            entityId: entity.entityId,
            scriptDirection: rec.verb as 'open' | 'close',
            position: entity.target.position,
          });
        } else {
          effects.push({
            kind: 'issue-cover',
            commandId: rec.commandId,
            entityId: entity.entityId,
            verb: rec.verb as CoverVerb,
          });
        }
      } else {
        effects.push({
          kind: 'issue-toggle',
          commandId: rec.commandId,
          entityId: entity.entityId,
          domain: entity.type,
          verb: rec.verb as ToggleVerb,
        });
      }
      const current = snapshot?.get(entity.entityId);
      if (current && this.reached(rec.verb, entity, current.state, current.position)) {
        rec.outcomes.set(entity.entityId, 'done');
      } else {
        rec.outcomes.set(entity.entityId, 'pending');
        rec.completionDeadlines.set(entity.entityId, now + entity.completionTimeoutMs);
      }
    }

    if (!this.hasPending(rec)) {
      this.resolve(rec, effects);
      return;
    }
    // Covers ack on receipt; a batch acks once. A single toggle stays single-stage.
    if (rec.entities.length > 1 || rec.entities.some((e) => e.type === 'cover')) {
      effects.push({ kind: 'reply-progress', commandId: rec.commandId });
    }
  }

  private preemptHolder(entity: EntityRef, newCommandId: string, effects: Effect[]): void {
    for (const other of this.commands.values()) {
      if (
        other.commandId !== newCommandId &&
        other.state === 'issued' &&
        other.outcomes.get(entity.entityId) === 'pending'
      ) {
        // Stop an in-flight cover before the new direction (item 7).
        if (entity.type === 'cover') {
          effects.push({ kind: 'issue-cover-stop', commandId: newCommandId, entityId: entity.entityId });
        }
        this.settle(other, entity.entityId, 'preempted', effects);
      }
    }
  }

  /**
   * HA state observed for an entity; settles it on the command still waiting for it.
   * `observedPosition` carries `attributes.current_position` (when reported) so
   * preset-position commands can be judged against their per-entity target.
   */
  observeState(entityId: string, observedState: string, observedPosition?: number): Effect[] {
    const effects: Effect[] = [];
    // Preemption guarantees at most one issued command is pending on a device.
    for (const rec of this.commands.values()) {
      if (rec.state !== 'issued' || rec.outcomes.get(entityId) !== 'pending') continue;
      const ref = rec.entities.find((e) => e.entityId === entityId)!;
      if (this.reached(rec.verb, ref, observedState, observedPosition)) {
        this.settle(rec, entityId, 'done', effects);
        break;
      }
    }
    return effects;
  }

  private reached(verb: Verb, ref: EntityRef, state: string, position?: number): boolean {
    return ref.target ? reachesPosition(ref.target, position) : this.reachesTarget(verb, state);
  }

  private reachesTarget(verb: Verb, observed: string): boolean {
    switch (verb) {
      case 'open':
        return observed === 'open';
      case 'close':
        return observed === 'closed';
      case 'stop':
        // A stop command is complete only when the cover actually reports 'stopped'
        // (design §5). Accepting 'open' or 'closed' would falsely ack a stop that
        // happened to observe an incidental terminal position.
        return observed === 'stopped';
      case 'on':
        return observed === 'on';
      case 'off':
        return observed === 'off';
    }
  }

  /**
   * A device's HA call never landed (REST failure / HA unreachable): settle it as
   * failed immediately so observeState cannot race to a false success (item 6).
   * The other devices of a batch keep being tracked.
   */
  markEntityIssueFailed(commandId: string, entityId: string): Effect[] {
    const rec = this.commands.get(commandId);
    if (!rec) return [];
    const effects: Effect[] = [];
    this.settle(rec, entityId, 'failed', effects);
    return effects;
  }

  /** Time-driven transitions: confirm expiry and per-device completion timeouts. */
  tick(): Effect[] {
    const now = this.now();
    const effects: Effect[] = [];
    for (const rec of this.commands.values()) {
      if (
        rec.state === 'pending_confirm' &&
        rec.confirmDeadline !== undefined &&
        now > rec.confirmDeadline
      ) {
        rec.state = 'failed';
        rec.confirmDeadline = undefined;
        rec.resolvedAt = now;
        effects.push({ kind: 'reply-failed', commandId: rec.commandId });
        continue;
      }
      if (rec.state !== 'issued') continue;
      for (const [entityId, deadline] of [...rec.completionDeadlines]) {
        if (now > deadline) this.settle(rec, entityId, 'timeout', effects);
      }
    }
    return effects;
  }

  /** Drop records resolved more than 10 minutes ago; returns their command ids. */
  prune(): string[] {
    const cutoff = this.now() - RESOLVED_RETENTION_MS;
    const pruned: string[] = [];
    for (const [commandId, rec] of this.commands) {
      if (rec.resolvedAt !== undefined && rec.resolvedAt < cutoff) {
        this.commands.delete(commandId);
        pruned.push(commandId);
      }
    }
    return pruned;
  }

  /**
   * Cancel a pending_confirm command cleanly (`לא`, or superseded by a newer
   * batch). Transitions to `failed` without emitting `reply-failed`; the caller
   * sends the user-facing notice.
   */
  cancelPendingConfirm(commandId: string): void {
    const rec = this.commands.get(commandId);
    if (!rec || rec.state !== 'pending_confirm') return;
    rec.state = 'failed';
    rec.confirmDeadline = undefined;
    rec.resolvedAt = this.now();
  }

  /** Clear all pending/in-flight state (safe startup, kill switch). */
  clearAll(): void {
    this.commands.clear();
  }

  /** Covers still pending on an issued command (for the kill-switch stop). */
  issuedCoverEntityIds(): string[] {
    const ids: string[] = [];
    for (const rec of this.commands.values()) {
      if (rec.state !== 'issued') continue;
      for (const e of rec.entities) {
        if (e.type === 'cover' && rec.outcomes.get(e.entityId) === 'pending') ids.push(e.entityId);
      }
    }
    return ids;
  }

  private hasPending(rec: CommandRecord): boolean {
    for (const outcome of rec.outcomes.values()) if (outcome === 'pending') return true;
    return false;
  }

  /** Record one device's outcome; resolve the command once none is pending. Idempotent. */
  private settle(rec: CommandRecord, entityId: string, outcome: EntityOutcome, effects: Effect[]): void {
    if (rec.state !== 'issued' || rec.outcomes.get(entityId) !== 'pending') return;
    rec.outcomes.set(entityId, outcome);
    rec.completionDeadlines.delete(entityId);
    if (!this.hasPending(rec)) this.resolve(rec, effects);
  }

  private resolve(rec: CommandRecord, effects: Effect[]): void {
    const by = (o: EntityOutcome) =>
      rec.entities.map((e) => e.entityId).filter((id) => rec.outcomes.get(id) === o);
    const done = by('done');
    const failed = by('failed');
    const timedOut = by('timeout');
    const preempted = by('preempted');
    rec.resolvedAt = this.now();
    rec.completionDeadlines.clear();

    if (preempted.length === rec.entities.length) rec.state = 'preempted';
    else if (timedOut.length > 0) rec.state = 'timeout';
    else if (failed.length > 0) rec.state = 'failed';
    else rec.state = 'observed_target';

    if (rec.entities.length > 1) {
      // A batch whose every device was taken over by newer commands says nothing.
      if (rec.state !== 'preempted') {
        effects.push({ kind: 'reply-summary', commandId: rec.commandId, done, failed, timedOut });
      }
      return;
    }
    switch (rec.state) {
      case 'observed_target':
        effects.push({ kind: 'reply-success', commandId: rec.commandId });
        break;
      case 'timeout':
        effects.push({ kind: 'reply-timeout', commandId: rec.commandId, entityId: timedOut[0]! });
        break;
      case 'failed':
        effects.push({ kind: 'reply-failed', commandId: rec.commandId });
        break;
      case 'preempted':
        effects.push({ kind: 'reply-preempted', commandId: rec.commandId });
        break;
    }
  }
}
