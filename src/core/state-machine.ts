/**
 * Command state machine (design §5).
 *
 * Per-command lifecycle:
 *   received → pending_confirm? → issued → observed_target | timeout | preempted | failed
 *
 * The machine is pure-ish: it owns RAM-only per-command state and emits Effects
 * (issue HA call, send a reply) that the wiring layer executes. It consumes events
 * (submit, confirm, observeState, markIssueFailed, tick). Time is injected.
 *
 * Locked behaviors:
 * - Two-stage cover feedback (progress ack on receipt, success on observed target);
 *   single-stage for lights.
 * - Per-entity completion timeout → `timeout` + manual-check reply, no success ack.
 * - Conflict preemption: a new command for an entity already `issued` issues stop
 *   then the new direction; the old command → `preempted`. No queue.
 * - All-covers is confirm-gated: `pending_confirm`, 20s expiry, bound to
 *   (same UUID + same pending action + live window).
 * - HA/WS outage handling via the decision window: a command that never issued →
 *   `failed`; one that issued but lost its stream → `timeout`. No success ack either way.
 */

export type CoverVerb = 'open' | 'close' | 'stop';
export type LightVerb = 'on' | 'off';
export type Verb = CoverVerb | LightVerb;

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
  readonly type: 'cover' | 'light';
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
  | { kind: 'issue-light'; commandId: string; entityId: string; verb: LightVerb }
  | { kind: 'reply-progress'; commandId: string; entityId: string }
  | { kind: 'reply-success'; commandId: string }
  | { kind: 'reply-timeout'; commandId: string; entityId: string }
  | { kind: 'reply-failed'; commandId: string }
  | { kind: 'reply-entity-failed'; commandId: string; entityId: string }
  | { kind: 'reply-preempted'; commandId: string }
  | { kind: 'reply-confirm-prompt'; commandId: string; count: number };

interface CommandRecord {
  readonly commandId: string;
  readonly sourceUuid: string;
  readonly verb: Verb;
  readonly entities: EntityRef[];
  state: CommandState;
  /** True once a command has actually issued to HA (passed to observe/timeout). */
  issued: boolean;
  /**
   * Per-entity completion deadlines (item 8): keyed by entityId so all-covers
   * commands track each cover's individual timeout correctly, and tick can report
   * all timed-out covers rather than only the first one.
   */
  completionDeadlines: Map<string, number>;
  /** Deadline for the pending-confirm expiry. */
  confirmDeadline: number | undefined;
  /** Deadline by which a non-issued command gives up (decision window) → failed. */
  decisionDeadline: number | undefined;
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
}

interface SubmitAllArgs {
  readonly commandId: string;
  readonly sourceUuid: string;
  readonly verb: CoverVerb;
  readonly entities: EntityRef[];
}

export class CommandStateMachine {
  private readonly now: () => number;
  private readonly confirmExpiryMs: number;
  private readonly commands = new Map<string, CommandRecord>();

  constructor(opts: StateMachineOptions) {
    this.now = opts.now;
    // decisionWindowMs is preserved in StateMachineOptions for API compatibility and
    // future use (HA reconnect scenario), but the synchronous markIssueFailed path
    // (item 6) now fails immediately without waiting for the decision window.
    void opts.decisionWindowMs;
    this.confirmExpiryMs = opts.confirmExpiryMs;
  }

  stateOf(commandId: string): CommandState | undefined {
    return this.commands.get(commandId)?.state;
  }

  /** A single-entity command (cover or light). Issues immediately. */
  submit(args: SubmitArgs): Effect[] {
    const effects: Effect[] = [];
    const rec: CommandRecord = {
      commandId: args.commandId,
      sourceUuid: args.sourceUuid,
      verb: args.verb,
      entities: [args.entity],
      state: 'issued',
      issued: true,
      completionDeadlines: new Map(),
      confirmDeadline: undefined,
      decisionDeadline: undefined,
    };
    this.commands.set(args.commandId, rec);
    this.issue(rec, effects);
    return effects;
  }

  /** All-covers command: enters pending_confirm with a stated consequence. */
  submitAllCovers(args: SubmitAllArgs): Effect[] {
    const rec: CommandRecord = {
      commandId: args.commandId,
      sourceUuid: args.sourceUuid,
      verb: args.verb,
      entities: args.entities,
      state: 'pending_confirm',
      issued: false,
      completionDeadlines: new Map(),
      confirmDeadline: this.now() + this.confirmExpiryMs,
      decisionDeadline: undefined,
    };
    this.commands.set(args.commandId, rec);
    return [
      { kind: 'reply-confirm-prompt', commandId: args.commandId, count: args.entities.length },
    ];
  }

  /** Context-bound confirm: same UUID + same pending action + live window. */
  confirm(commandId: string, sourceUuid: string): { accepted: boolean; effects: Effect[] } {
    const rec = this.commands.get(commandId);
    if (!rec || rec.state !== 'pending_confirm') return { accepted: false, effects: [] };
    if (rec.sourceUuid !== sourceUuid) return { accepted: false, effects: [] };
    if (rec.confirmDeadline !== undefined && this.now() > rec.confirmDeadline) {
      return { accepted: false, effects: [] };
    }
    rec.state = 'issued';
    rec.issued = true;
    rec.confirmDeadline = undefined;
    const effects: Effect[] = [];
    this.issue(rec, effects);
    return { accepted: true, effects };
  }

  /** Issue the command to HA and arrange feedback/timeouts. */
  private issue(rec: CommandRecord, effects: Effect[]): void {
    const now = this.now();
    for (const entity of rec.entities) {
      if (entity.type === 'cover') {
        // Preempt any other command already issued on this entity.
        this.preemptHolder(entity.entityId, rec.commandId, effects);
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
        effects.push({ kind: 'reply-progress', commandId: rec.commandId, entityId: entity.entityId });
        // Per-entity deadline (item 8): store in the map so all-covers commands track
        // each cover independently.
        rec.completionDeadlines.set(entity.entityId, now + entity.completionTimeoutMs);
      } else {
        effects.push({
          kind: 'issue-light',
          commandId: rec.commandId,
          entityId: entity.entityId,
          verb: rec.verb as LightVerb,
        });
        rec.completionDeadlines.set(entity.entityId, now + entity.completionTimeoutMs);
      }
    }
  }

  private preemptHolder(entityId: string, newCommandId: string, effects: Effect[]): void {
    for (const other of this.commands.values()) {
      if (
        other.commandId !== newCommandId &&
        other.state === 'issued' &&
        other.entities.some((e) => e.entityId === entityId && e.type === 'cover')
      ) {
        other.state = 'preempted';
        other.completionDeadlines.clear();
        // Stop the in-flight cover and notify the original sender (item 7).
        effects.push({ kind: 'issue-cover-stop', commandId: newCommandId, entityId });
        effects.push({ kind: 'reply-preempted', commandId: other.commandId });
      }
    }
  }

  /**
   * HA state observed for an entity; resolves the single issued command on it.
   * `observedPosition` carries `attributes.current_position` (when reported) so
   * preset-position commands can be judged against their per-entity target.
   */
  observeState(entityId: string, observedState: string, observedPosition?: number): Effect[] {
    const effects: Effect[] = [];
    // Find the single most-recent issued command tracking this entity and resolve it.
    // Using the first match is correct because preemption transitions older commands
    // to 'preempted' before a new one is issued, so at most one command per entity
    // should be in 'issued' at any time.
    for (const rec of this.commands.values()) {
      if (rec.state !== 'issued') continue;
      const ref = rec.entities.find((e) => e.entityId === entityId);
      if (!ref) continue;
      const reached = ref.target
        ? reachesPosition(ref.target, observedPosition)
        : this.reachesTarget(rec.verb, observedState);
      if (reached) {
        rec.state = 'observed_target';
        rec.completionDeadlines.clear();
        effects.push({ kind: 'reply-success', commandId: rec.commandId });
        // Resolve only one command per event: the machine ensures a single issued
        // command per entity at a time via preemption.
        break;
      }
    }
    return effects;
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
   * Mark that a command's issue never landed on HA (e.g. REST call failed / HA
   * unreachable). Transitions to `failed` immediately and emits `reply-failed` so
   * `observeState` cannot emit a false success ack during the decision window
   * (design §5, item 6). A definitive REST failure is terminal; the decision window
   * is for HA reconnect scenarios, not synchronous call failures.
   *
   * For single-entity commands this is equivalent to markEntityIssueFailed.
   */
  markIssueFailed(commandId: string): Effect[] {
    const rec = this.commands.get(commandId);
    if (!rec || rec.state !== 'issued') return [];
    rec.issued = false;
    rec.state = 'failed';
    rec.completionDeadlines.clear();
    rec.decisionDeadline = undefined;
    return [{ kind: 'reply-failed', commandId: rec.commandId }];
  }

  /**
   * Per-entity issue failure for all-covers commands (fix item 4).
   *
   * When one cover's HA call fails in an all-covers command, only that cover
   * is removed from tracking. The remaining covers continue to be tracked to
   * `observed_target` or `timeout` independently. If ALL entities fail, the
   * command transitions to `failed` and emits `reply-failed`; otherwise it emits
   * `reply-entity-failed` for just the failing entity.
   *
   * For single-entity commands this is identical in behaviour to markIssueFailed.
   */
  markEntityIssueFailed(commandId: string, entityId: string): Effect[] {
    const rec = this.commands.get(commandId);
    if (!rec || rec.state !== 'issued') return [];

    // Remove this entity's deadline — it will no longer be tracked.
    rec.completionDeadlines.delete(entityId);

    // If all entities have now failed (no remaining deadlines and no other
    // entities could still succeed), fail the whole command.
    if (rec.completionDeadlines.size === 0) {
      rec.issued = false;
      rec.state = 'failed';
      rec.decisionDeadline = undefined;
      return [{ kind: 'reply-failed', commandId: rec.commandId }];
    }

    // Other entities are still in flight — report this entity's failure individually.
    return [{ kind: 'reply-entity-failed', commandId: rec.commandId, entityId }];
  }

  /** Time-driven transitions: confirm expiry, completion timeout, decision window. */
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
        effects.push({ kind: 'reply-failed', commandId: rec.commandId });
        continue;
      }
      if (
        rec.state === 'issued' &&
        rec.decisionDeadline !== undefined &&
        now > rec.decisionDeadline
      ) {
        // Never issued to HA -> failed; no success ack.
        rec.state = 'failed';
        rec.decisionDeadline = undefined;
        effects.push({ kind: 'reply-failed', commandId: rec.commandId });
        continue;
      }
      if (rec.state === 'issued' && rec.completionDeadlines.size > 0) {
        // Per-entity completion deadlines (item 8): collect all timed-out entities
        // and report each in a separate reply-timeout effect so no cover is silently
        // dropped when an all-covers command has mixed timeouts.
        const timedOut: string[] = [];
        for (const [entityId, deadline] of rec.completionDeadlines) {
          if (now > deadline) timedOut.push(entityId);
        }
        if (timedOut.length > 0) {
          rec.state = 'timeout';
          rec.completionDeadlines.clear();
          for (const entityId of timedOut) {
            effects.push({ kind: 'reply-timeout', commandId: rec.commandId, entityId });
          }
        }
      }
    }
    return effects;
  }

  /**
   * Cancel a pending_confirm command cleanly (fix item 6 — supersede on new
   * all-covers submission). Transitions the old command to `failed` without
   * emitting a `reply-failed` effect so no spurious failure reply reaches the
   * user. The caller is responsible for sending an appropriate user-facing notice.
   */
  cancelPendingConfirm(commandId: string): void {
    const rec = this.commands.get(commandId);
    if (!rec || rec.state !== 'pending_confirm') return;
    rec.state = 'failed';
    rec.confirmDeadline = undefined;
  }

  /** Clear all pending/in-flight state (safe startup, kill switch). */
  clearAll(): void {
    this.commands.clear();
  }

  /** Entity ids currently in the `issued` state (for kill-switch stop). */
  issuedCoverEntityIds(): string[] {
    const ids: string[] = [];
    for (const rec of this.commands.values()) {
      if (rec.state !== 'issued') continue;
      for (const e of rec.entities) {
        if (e.type === 'cover') ids.push(e.entityId);
      }
    }
    return ids;
  }
}
