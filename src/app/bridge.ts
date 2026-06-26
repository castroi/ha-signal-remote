import type { Config, EntityDef, Verb } from './config.js';
import { DEFAULT_TOLERANCE_PERCENT } from './config.js';
import { normalize } from '../core/normalize.js';
import { DedupCache } from '../core/dedup.js';
import { checkFreshness } from '../core/freshness.js';
import { evaluateClockHealth } from '../core/clock-health.js';
import { RateLimiter } from '../core/rate-limit.js';
import { parseCommand } from '../core/parse.js';
import {
  CommandStateMachine,
  type Effect,
  type EntityRef,
  type CoverVerb,
  type LightVerb,
  type PositionTarget,
} from '../core/state-machine.js';
import { WsHealthGate } from '../adapters/ha-ws.js';
import { KillSwitch } from '../core/kill-switch.js';
import { buildStatus, formatStatus, type CoversDisabledReason } from '../core/status.js';
import { type AuditLogger } from '../core/audit.js';
import type { HaCallResult } from '../adapters/ha-rest.js';
import type { IncomingEnvelope } from '../adapters/signal.js';

/**
 * App wiring (design §5). Drives the full pipeline:
 *   receive → normalize → dedup → freshness → clock → rate-limit → parse →
 *   state-machine → HA → reply.
 *
 * Safe startup: all RAM state begins cleared; the bridge refuses action until a
 * fresh command arrives and emits "state tracking reinitialized" once. In-flight
 * commands at restart are abandoned, not resumed.
 *
 * Ports (HA REST, Signal send) are injected so the pipeline is testable without
 * hardware.
 */

export interface HaRestPort {
  callCover(entityId: string, verb: CoverVerb): Promise<HaCallResult>;
  callLight(entityId: string, verb: LightVerb): Promise<HaCallResult>;
  /** Read a cover's live current_position (0–100); undefined when unreadable/unreported. */
  getCoverPosition(entityId: string): Promise<number | undefined>;
  /** Drive covers to a preset position via the household HA script. */
  callPositionScript(
    scriptEntityId: string,
    entityIds: readonly string[],
    position: number,
  ): Promise<HaCallResult>;
}

export interface SignalSendPort {
  send(sourceUuid: string, recipient: string, message: string): Promise<boolean>;
}

export interface ClockStatePort {
  /** Current measured skew sample (ms), last good check time, reachability. */
  snapshot(): {
    skewSampleMs: number;
    lastGoodCheckAt: number;
    allReferencesUnreachable: boolean;
  };
}

export interface BridgeDeps {
  readonly config: Config;
  readonly haRest: HaRestPort;
  readonly signal: SignalSendPort;
  readonly clock: ClockStatePort;
  readonly audit?: AuditLogger;
  readonly now?: () => number;
  readonly genCommandId?: () => string;
  readonly emitNotice?: (text: string) => void;
}

const REPLY = {
  reinitialized: 'מעקב מצב אותחל מחדש',
  stale: 'הפקודה ישנה מדי, שלח שוב',
  coversDisabledWs: 'אין כרגע מעקב מצב, התריסים מושבתים זמנית',
  coversDisabledClock: 'בעיית שעון, התריסים מושבתים זמנית',
  rateLimited: 'יותר מדי פקודות, נסה עוד רגע',
  killed: 'המערכת בכיבוי חירום',
  progress: 'מבצע…',
  success: 'בוצע',
  alreadyThere: 'התריס כבר במצב המבוקש',
  positionUnknown: 'לא ניתן לקרוא את מצב התריס',
  failed: 'הפעולה נכשלה',
  preempted: 'הפקודה בוטלה (פקודה חדשה)',
  menu: 'לא הבנתי. נסה: פתח/סגור/עצור + חדר, או "תריסים" לכל התריסים',
  unrecognizedControlReply: 'לא הבנתי. נסה: פתח/סגור/עצור + חדר, או "תריסים" לכל התריסים',
  confirmCancelled: 'בוטל',
};

export class Bridge {
  private readonly cfg: Config;
  private readonly haRest: HaRestPort;
  private readonly signal: SignalSendPort;
  private readonly clock: ClockStatePort;
  private readonly audit: AuditLogger | undefined;
  private readonly now: () => number;
  private readonly genCommandId: () => string;
  private readonly emitNotice: (text: string) => void;

  private dedup!: DedupCache;
  private rateLimiter!: RateLimiter;
  private stateMachine!: CommandStateMachine;
  private readonly wsGate: WsHealthGate;
  private readonly killSwitch = new KillSwitch();
  private cmdSeq = 0;
  private reinitialized = false;
  /**
   * Fix item 8 (LOW): latch the most-recently-detected future-timestamp delta
   * so the periodic cover gate reflects it consistently. Set whenever
   * freshness returns 'clock-unhealthy'; cleared (undefined) once the skew
   * sample from the reference supersedes it. The clockHealth() method threads
   * this into evaluateClockHealth so coversEnabled() is consistent with the
   * per-envelope path.
   */
  private latchedFutureEnvelopeMs: number | undefined = undefined;
  /** Maps commandId -> the sender to reply to, for state-machine effect routing. */
  private readonly replyTo = new Map<string, { uuid: string; number: string }>();
  /**
   * Maps sourceUuid -> commandId of the live pending_confirm for that sender (item 1).
   * Bound to: same UUID + same pending action + same live expiry window (§5).
   */
  private readonly pendingConfirm = new Map<string, string>();

  constructor(deps: BridgeDeps) {
    this.cfg = deps.config;
    this.haRest = deps.haRest;
    this.signal = deps.signal;
    this.clock = deps.clock;
    this.audit = deps.audit;
    this.now = deps.now ?? Date.now;
    this.genCommandId = deps.genCommandId ?? (() => `cmd-${++this.cmdSeq}`);
    this.emitNotice = deps.emitNotice ?? (() => {});
    this.wsGate = new WsHealthGate({
      debounceMs: this.cfg.tunables.wsHealthyDebounceMs,
      now: this.now,
    });
    this.startup();
  }

  /** Safe startup: clear all RAM state, emit reinitialized once. */
  startup(): void {
    this.dedup = new DedupCache({ ttlMs: this.cfg.tunables.dedupTtlMs, now: this.now });
    this.rateLimiter = new RateLimiter({ tunables: this.cfg.tunables, now: this.now });
    this.stateMachine = new CommandStateMachine({
      now: this.now,
      decisionWindowMs: this.cfg.tunables.haReconnectDecisionWindowMs,
      confirmExpiryMs: this.cfg.tunables.confirmExpiryMs,
    });
    this.replyTo.clear();
    this.pendingConfirm.clear();
    this.latchedFutureEnvelopeMs = undefined;
    this.reinitialized = false;
  }

  onWsConnected(): void {
    this.wsGate.onConnected();
  }
  onWsDisconnected(): void {
    this.wsGate.onDisconnected();
  }

  engageKill(): void {
    const toStop = this.killSwitch.engage(this.stateMachine.issuedCoverEntityIds());
    // Best-effort stop on all in-flight covers.
    for (const entityId of toStop) {
      void this.haRest.callCover(entityId, 'stop');
    }
  }

  /** Main entrypoint for an incoming Signal envelope. */
  async handleEnvelope(env: IncomingEnvelope): Promise<void> {
    if (!this.reinitialized) {
      this.emitNotice(REPLY.reinitialized);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: 'startup',
        entity: undefined,
        result: 'reinitialized',
        latencyMs: undefined,
        reasonCode: undefined,
      });
      this.reinitialized = true;
    }

    const normalized = normalize(env.message);

    // Dedup (RAM, TTL): drop redeliveries.
    if (
      this.dedup.seen({
        sourceUuid: env.sourceUuid,
        envelopeTs: env.timestamp,
        normalizedCommand: normalized,
      })
    ) {
      return;
    }

    // Parse first so reserved control words (סטטוס) bypass freshness/rate gates.
    const parsed = parseCommand(env.message, this.cfg.aliases);
    if (parsed.kind === 'control-reply' && parsed.word === 'סטטוס') {
      await this.reply(env, this.statusMessage());
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: 'status',
        entity: undefined,
        result: 'status',
        latencyMs: undefined,
        reasonCode: undefined,
      });
      return;
    }

    // Help/menu — like status, always answered for authorized senders (even in
    // kill-switch safe mode); never a device action, so resolve before the gates.
    if (parsed.kind === 'control-reply' && (parsed.word === 'עזרה' || parsed.word === 'תפריט')) {
      await this.reply(env, this.cfg.aliases.helpText());
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: 'help',
        entity: undefined,
        result: 'help',
        latencyMs: undefined,
        reasonCode: undefined,
      });
      return;
    }

    // Item 1: כן/לא — confirm flow. Resolve before freshness/rate gates (confirm
    // lane is exempt from normal caps per §5) but still go through dedup above.
    if (parsed.kind === 'control-reply' && (parsed.word === 'כן' || parsed.word === 'לא')) {
      await this.handleConfirmReply(env, parsed.word as 'כן' | 'לא');
      return;
    }

    if (this.killSwitch.blocksCommands()) {
      await this.reply(env, REPLY.killed);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: normalized,
        entity: undefined,
        result: 'rejected',
        latencyMs: undefined,
        reasonCode: 'kill-switch',
      });
      return;
    }

    // Freshness gate + future-timestamp guard (item 2).
    const fresh = checkFreshness({
      now: this.now(),
      envelopeTs: env.timestamp,
      tunables: this.cfg.tunables,
    });
    if (fresh.kind === 'stale') {
      await this.reply(env, REPLY.stale);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: normalized,
        entity: undefined,
        result: 'rejected',
        latencyMs: undefined,
        reasonCode: 'stale',
      });
      return;
    }
    if (fresh.kind === 'clock-unhealthy') {
      // A future-dated envelope is a clock-disagreement safety event (design §5,
      // go-live gate 8): route to covers safe-mode, not a normal refusal. Covers
      // are disabled; lights are still operable but the command at hand is refused.
      // Fix item 8 (LOW): latch the detected future delta so the ongoing
      // coversEnabled() gate also reflects this clock disagreement consistently.
      const futureDeltaMs = env.timestamp - this.now();
      if (futureDeltaMs > 0) {
        this.latchedFutureEnvelopeMs = futureDeltaMs;
      }
      await this.reply(env, REPLY.coversDisabledClock);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: normalized,
        entity: undefined,
        result: 'rejected',
        latencyMs: undefined,
        reasonCode: 'clock-unhealthy',
      });
      return;
    }

    // Rate limit (commands; confirms use the confirm lane above).
    if (!this.rateLimiter.allowCommand(env.sourceUuid).allowed) {
      await this.reply(env, REPLY.rateLimited);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: normalized,
        entity: undefined,
        result: 'rejected',
        latencyMs: undefined,
        reasonCode: 'rate-limited',
      });
      return;
    }

    switch (parsed.kind) {
      case 'no-verb':
        await this.reply(env, REPLY.menu);
        this.audit?.log({
          ts: this.now(),
          sourceUuid: env.sourceUuid,
          intent: normalized,
          entity: undefined,
          result: 'rejected',
          latencyMs: undefined,
          reasonCode: 'no-verb',
        });
        return;
      case 'control-reply':
        // Defensive fallback: every current reserved word (סטטוס, עזרה, תפריט,
        // כן, לא) is intercepted by a dedicated handler above, so this is reached
        // only if a future reserved word is added without one.
        await this.reply(env, REPLY.unrecognizedControlReply);
        this.audit?.log({
          ts: this.now(),
          sourceUuid: env.sourceUuid,
          intent: normalized,
          entity: undefined,
          result: 'rejected',
          latencyMs: undefined,
          reasonCode: 'unrecognized-control-reply',
        });
        return;
      case 'entity-unknown':
        await this.reply(env, `לא מכיר "${parsed.rejectedWord}". יעדים: ${parsed.validTargets.join(', ')}`);
        this.audit?.log({
          ts: this.now(),
          sourceUuid: env.sourceUuid,
          intent: normalized,
          entity: undefined,
          result: 'rejected',
          latencyMs: undefined,
          reasonCode: 'entity-unknown',
        });
        return;
      case 'ambiguous':
        await this.reply(env, `איזה? ${parsed.candidates.join(', ')}`);
        this.audit?.log({
          ts: this.now(),
          sourceUuid: env.sourceUuid,
          intent: normalized,
          entity: undefined,
          result: 'rejected',
          latencyMs: undefined,
          reasonCode: 'ambiguous',
        });
        return;
      case 'command':
        await this.dispatchCommand(env, parsed.verb, parsed.scope);
        return;
    }
  }

  /**
   * Handle a כן/לא confirm reply (item 1).
   *
   * Uses the reserved confirm lane (exempt from normal caps, capped at 6/sender/min).
   * Looks up the sender's live pending_confirm commandId, validates it via the state
   * machine's context binding (same UUID + same action + live window), then executes
   * the resulting effects on כן or cancels on לא.
   */
  private async handleConfirmReply(env: IncomingEnvelope, word: 'כן' | 'לא'): Promise<void> {
    const commandId = this.pendingConfirm.get(env.sourceUuid);

    if (commandId === undefined) {
      // No live pending_confirm for this sender: unrecognized control reply.
      await this.reply(env, REPLY.unrecognizedControlReply);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: word,
        entity: undefined,
        result: 'rejected',
        latencyMs: undefined,
        reasonCode: 'unrecognized-control-reply',
      });
      return;
    }

    // Gate through the confirm lane (exempt from normal caps, but capped at 6/min).
    const laneDecision = this.rateLimiter.allowConfirm(env.sourceUuid);
    if (!laneDecision.allowed) {
      await this.reply(env, REPLY.rateLimited);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: word,
        entity: undefined,
        result: 'rejected',
        latencyMs: undefined,
        reasonCode: 'confirm-spam',
      });
      return;
    }

    if (word === 'לא') {
      // Cancel: remove pending context. The state machine will expire it via tick()
      // if the record is still pending_confirm; we just clear the bridge-side binding.
      this.pendingConfirm.delete(env.sourceUuid);
      await this.reply(env, REPLY.confirmCancelled);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: word,
        entity: undefined,
        result: 'rejected',
        latencyMs: undefined,
        reasonCode: undefined,
        commandId,
      });
      return;
    }

    // Fix item 3 (MED): Re-check safety gates at confirm time. A כן arriving
    // after the kill switch is engaged or WS/clock went unhealthy must NOT
    // actuate covers. The confirm lane is exempt from rate caps only — not from
    // safety gates (§5 kill-switch + fail-closed design).
    if (this.killSwitch.blocksCommands()) {
      this.pendingConfirm.delete(env.sourceUuid);
      await this.reply(env, REPLY.killed);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: word,
        entity: undefined,
        result: 'rejected',
        latencyMs: undefined,
        reasonCode: 'kill-switch',
        commandId,
      });
      return;
    }
    if (!this.coversEnabled()) {
      this.pendingConfirm.delete(env.sourceUuid);
      await this.reply(env, this.coverRefusalMessage());
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: word,
        entity: undefined,
        result: 'rejected',
        latencyMs: undefined,
        reasonCode: this.wsGate.coversEnabled() ? 'clock-unhealthy' : 'ws-down',
        commandId,
      });
      return;
    }

    // כן: context-bound confirm through the state machine.
    const result = this.stateMachine.confirm(commandId, env.sourceUuid);
    if (!result.accepted) {
      // The state machine rejected it (expired, wrong sender, already resolved).
      this.pendingConfirm.delete(env.sourceUuid);
      await this.reply(env, REPLY.unrecognizedControlReply);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: word,
        entity: undefined,
        result: 'rejected',
        latencyMs: undefined,
        reasonCode: 'unrecognized-control-reply',
        commandId,
      });
      return;
    }

    // Confirmed: clear the pending binding and execute effects (issue all covers).
    this.pendingConfirm.delete(env.sourceUuid);
    await this.runEffects(result.effects);
    this.audit?.log({
      ts: this.now(),
      sourceUuid: env.sourceUuid,
      intent: word,
      entity: undefined,
      result: 'issued',
      latencyMs: undefined,
      reasonCode: undefined,
      commandId,
    });
  }

  private async dispatchCommand(
    env: IncomingEnvelope,
    verb: Verb,
    scope: { type: 'entity'; entityId: string } | { type: 'all-covers' },
  ): Promise<void> {
    if (scope.type === 'entity') {
      const entity = this.cfg.aliases.entities.get(scope.entityId);
      if (!entity) {
        await this.reply(env, REPLY.menu);
        return;
      }
      // Covers are gated by WS health + clock health (fail-closed).
      if (entity.type === 'cover' && !this.coversEnabled()) {
        await this.reply(env, this.coverRefusalMessage());
        this.audit?.log({
          ts: this.now(),
          sourceUuid: env.sourceUuid,
          intent: `${verb} ${entity.entityId}`,
          entity: entity.entityId,
          result: 'rejected',
          latencyMs: undefined,
          reasonCode: this.wsGate.coversEnabled() ? 'clock-unhealthy' : 'ws-down',
        });
        return;
      }

      const effectiveVerb = baseVerb(verb);
      // A preset (open_to/close_to) verb with a configured target drives the cover
      // through the household script; an unset target falls through to full open/close.
      const target = this.targetFor(entity, verb);
      if (target) {
        // Read the live position and refuse a move that would reverse direction
        // (issue #1 reversal guard) — the household script guards too, but the
        // bridge pre-check lets a no-op reply distinctly instead of timing out.
        const current = await this.haRest.getCoverPosition(entity.entityId);
        if (current === undefined) {
          await this.reply(env, REPLY.positionUnknown);
          this.audit?.log({
            ts: this.now(),
            sourceUuid: env.sourceUuid,
            intent: `${effectiveVerb} ${entity.entityId}`,
            entity: entity.entityId,
            result: 'rejected',
            latencyMs: undefined,
            reasonCode: 'position-unknown',
          });
          return;
        }
        // A target is only produced for the open_to/close_to verbs, so the
        // direction here is unambiguous.
        const direction = verb === 'open_to' ? 'open' : 'close';
        if (!shouldMove(direction, current, target)) {
          await this.reply(env, REPLY.alreadyThere);
          this.audit?.log({
            ts: this.now(),
            sourceUuid: env.sourceUuid,
            intent: `${effectiveVerb} ${entity.entityId}`,
            entity: entity.entityId,
            result: 'rejected',
            latencyMs: undefined,
            reasonCode: 'noop-already-there',
          });
          return;
        }
      }

      const commandId = this.genCommandId();
      this.replyTo.set(commandId, { uuid: env.sourceUuid, number: env.sourceNumber ?? '' });
      const ref = toRef(entity, target);
      const effects = this.stateMachine.submit({
        commandId,
        sourceUuid: env.sourceUuid,
        verb: effectiveVerb,
        entity: ref,
      });
      await this.runEffects(effects);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: `${effectiveVerb} ${entity.entityId}`,
        entity: entity.entityId,
        result: 'issued',
        latencyMs: undefined,
        reasonCode: undefined,
        commandId,
      });
    } else {
      // all-covers: confirm-gated, also fail-closed on WS/clock.
      if (!this.coversEnabled()) {
        await this.reply(env, this.coverRefusalMessage());
        this.audit?.log({
          ts: this.now(),
          sourceUuid: env.sourceUuid,
          intent: `${verb} all-covers`,
          entity: undefined,
          result: 'rejected',
          latencyMs: undefined,
          reasonCode: this.wsGate.coversEnabled() ? 'clock-unhealthy' : 'ws-down',
        });
        return;
      }
      // Fix item 6: if this sender already has a pending_confirm, cancel the
      // prior command cleanly so it does not emit a spurious failure reply ~20s
      // later. The new command supersedes the old one.
      const priorCommandId = this.pendingConfirm.get(env.sourceUuid);
      if (priorCommandId !== undefined) {
        this.stateMachine.cancelPendingConfirm(priorCommandId);
        this.pendingConfirm.delete(env.sourceUuid);
      }

      const commandId = this.genCommandId();
      this.replyTo.set(commandId, { uuid: env.sourceUuid, number: env.sourceNumber ?? '' });
      // Each cover carries its own preset target (open_to/close_to); covers with no
      // configured target for this direction fall back to full open/close. The HA
      // script guards direction per cover, so the batch needs no live-position read.
      const entities = this.cfg.aliases.coverEntityIds().map((id) => {
        const e = this.cfg.aliases.entities.get(id)!;
        return toRef(e, this.targetFor(e, verb));
      });
      const effects = this.stateMachine.submitAllCovers({
        commandId,
        sourceUuid: env.sourceUuid,
        verb: baseVerb(verb) as CoverVerb,
        entities,
      });
      // Register the pending confirm so handleConfirmReply can resolve it (item 1).
      this.pendingConfirm.set(env.sourceUuid, commandId);
      await this.runEffects(effects);
      this.audit?.log({
        ts: this.now(),
        sourceUuid: env.sourceUuid,
        intent: `${verb} all-covers`,
        entity: undefined,
        result: 'confirm_prompt',
        latencyMs: undefined,
        reasonCode: undefined,
        commandId,
      });
    }
  }

  /** Forward an observed HA state into the state machine; reply on resolution. */
  async onStateChanged(entityId: string, state: string, position?: number): Promise<void> {
    const effects = this.stateMachine.observeState(entityId, state, position);
    await this.runEffects(effects);
  }

  /** Time-driven transitions (timeouts, expiries); reply on resolution. */
  async tick(): Promise<void> {
    this.dedup.sweep();
    const effects = this.stateMachine.tick();
    await this.runEffects(effects);
  }

  private async runEffects(effects: Effect[]): Promise<void> {
    for (const e of effects) {
      switch (e.kind) {
        case 'issue-cover': {
          const r = await this.haRest.callCover(e.entityId, e.verb);
          if (!r.ok) {
            // Fix item 4: use per-entity failure so one failed cover does not
            // drop tracking of the other covers in an all-covers command.
            const failEffects = this.stateMachine.markEntityIssueFailed(e.commandId, e.entityId);
            await this.runEffects(failEffects);
          }
          break;
        }
        case 'issue-cover-position': {
          const script =
            e.scriptDirection === 'open'
              ? this.cfg.aliases.positionScripts?.open
              : this.cfg.aliases.positionScripts?.close;
          // positionScripts is guaranteed present whenever a preset target exists
          // (validated at config load), so an issued position effect always has a script.
          const r = script
            ? await this.haRest.callPositionScript(script, [e.entityId], e.position)
            : ({ ok: false, reason: 'failed' } as const);
          if (!r.ok) {
            const failEffects = this.stateMachine.markEntityIssueFailed(e.commandId, e.entityId);
            await this.runEffects(failEffects);
          }
          break;
        }
        case 'issue-cover-stop':
          await this.haRest.callCover(e.entityId, 'stop');
          break;
        case 'issue-light': {
          const r = await this.haRest.callLight(e.entityId, e.verb);
          if (!r.ok) {
            const failEffects = this.stateMachine.markIssueFailed(e.commandId);
            await this.runEffects(failEffects);
          }
          break;
        }
        case 'reply-progress':
          await this.replyToCommand(e.commandId, REPLY.progress);
          break;
        case 'reply-success':
          await this.replyToCommand(e.commandId, REPLY.success);
          this.audit?.log({
            ts: this.now(),
            sourceUuid: this.replyTo.get(e.commandId)?.uuid ?? '',
            intent: 'completion',
            entity: undefined,
            result: 'observed_target',
            latencyMs: undefined,
            reasonCode: undefined,
            commandId: e.commandId,
          });
          break;
        case 'reply-timeout':
          await this.replyToCommand(e.commandId, `${e.entityId} לא הגיב. בדוק ידנית.`);
          this.audit?.log({
            ts: this.now(),
            sourceUuid: this.replyTo.get(e.commandId)?.uuid ?? '',
            intent: 'completion',
            entity: e.entityId,
            result: 'timeout',
            latencyMs: undefined,
            reasonCode: undefined,
            commandId: e.commandId,
          });
          break;
        case 'reply-failed':
          await this.replyToCommand(e.commandId, REPLY.failed);
          this.audit?.log({
            ts: this.now(),
            sourceUuid: this.replyTo.get(e.commandId)?.uuid ?? '',
            intent: 'completion',
            entity: undefined,
            result: 'failed',
            latencyMs: undefined,
            reasonCode: undefined,
            commandId: e.commandId,
          });
          break;
        case 'reply-entity-failed':
          // Fix item 4: a single cover in an all-covers command failed; report
          // that entity's failure while the others continue to be tracked.
          await this.replyToCommand(e.commandId, `${e.entityId} ${REPLY.failed}`);
          this.audit?.log({
            ts: this.now(),
            sourceUuid: this.replyTo.get(e.commandId)?.uuid ?? '',
            intent: 'completion',
            entity: e.entityId,
            result: 'failed',
            latencyMs: undefined,
            reasonCode: 'entity-issue-failed',
            commandId: e.commandId,
          });
          break;
        case 'reply-preempted':
          await this.replyToCommand(e.commandId, REPLY.preempted);
          this.audit?.log({
            ts: this.now(),
            sourceUuid: this.replyTo.get(e.commandId)?.uuid ?? '',
            intent: 'completion',
            entity: undefined,
            result: 'preempted',
            latencyMs: undefined,
            reasonCode: undefined,
            commandId: e.commandId,
          });
          break;
        case 'reply-confirm-prompt':
          await this.replyToCommand(e.commandId, `לסגור את כל ${e.count} התריסים? כן/לא`);
          break;
      }
    }
  }

  private coversEnabled(): boolean {
    if (!this.wsGate.coversEnabled()) return false;
    return this.clockHealth().coversEnabled;
  }

  /**
   * Evaluate clock health, threading the current envelope's future-timestamp delta
   * when available (item 2 / fix item 8). Called from `coversEnabled()` for the
   * ongoing gate and also for `statusMessage()`.
   *
   * Fix item 8 (LOW): `latchedFutureEnvelopeMs` is threaded in so that a
   * future-timestamp detection (per-envelope path) is reflected consistently in
   * the ongoing coversEnabled() evaluation — matching NTP-skew semantics.
   * A caller can pass an explicit futureEnvelopeMs to override the latch.
   */
  private clockHealth(futureEnvelopeMs?: number) {
    const snap = this.clock.snapshot();
    return evaluateClockHealth({
      now: this.now(),
      skewSampleMs: snap.skewSampleMs,
      lastGoodCheckAt: snap.lastGoodCheckAt,
      allReferencesUnreachable: snap.allReferencesUnreachable,
      futureEnvelopeMs: futureEnvelopeMs ?? this.latchedFutureEnvelopeMs,
      tunables: this.cfg.tunables,
    });
  }

  /**
   * Resolve the preset target for a cover under a verb. Returns undefined for
   * lights, non-preset verbs, or a cover with no configured position for that
   * direction (so the command falls through to full open/close).
   */
  private targetFor(entity: EntityDef, verb: Verb): PositionTarget | undefined {
    if (entity.type !== 'cover') return undefined;
    const position =
      verb === 'open_to'
        ? entity.openPosition
        : verb === 'close_to'
          ? entity.closePosition
          : undefined;
    if (position === undefined) return undefined;
    const tolerancePercent =
      entity.tolerancePercent ??
      this.cfg.aliases.positionScripts?.defaultTolerancePercent ??
      DEFAULT_TOLERANCE_PERCENT;
    return { position, tolerancePercent };
  }

  private coverRefusalMessage(): string {
    if (!this.wsGate.coversEnabled()) return REPLY.coversDisabledWs;
    return REPLY.coversDisabledClock;
  }

  private statusMessage(): string {
    const clock = this.clockHealth();
    let reason: CoversDisabledReason | undefined;
    if (!this.wsGate.coversEnabled()) reason = 'ws-down';
    else if (!clock.coversEnabled) reason = 'clock-skew';
    return formatStatus(
      buildStatus({
        wsHealthy: this.wsGate.coversEnabled(),
        clockHealthy: clock.status === 'healthy',
        killEngaged: this.killSwitch.engaged(),
        coversEnabled: this.coversEnabled() && !this.killSwitch.engaged(),
        coversDisabledReason: this.killSwitch.engaged() ? 'kill-switch' : reason,
      }),
    );
  }

  private async replyToCommand(commandId: string, message: string): Promise<void> {
    const target = this.replyTo.get(commandId);
    if (!target) return;
    await this.signal.send(target.uuid, target.number, message);
  }

  private async reply(env: IncomingEnvelope, message: string): Promise<void> {
    await this.signal.send(env.sourceUuid, env.sourceNumber ?? '', message);
  }
}

function toRef(entity: EntityDef, target?: PositionTarget): EntityRef {
  const base = {
    entityId: entity.entityId,
    type: entity.type,
    completionTimeoutMs: entity.completionTimeoutMs,
  };
  return target ? { ...base, target } : base;
}

/** Map a (possibly preset) verb to its base actuation direction. */
function baseVerb(verb: Verb): CoverVerb | LightVerb {
  if (verb === 'open_to') return 'open';
  if (verb === 'close_to') return 'close';
  return verb;
}

/**
 * Reversal guard (issue #1): a preset move fires only when the target is more than
 * tolerance away in the requested direction. `open` raises the position toward the
 * target; `close` lowers it. Already-there or wrong-direction is a no-op.
 */
function shouldMove(direction: 'open' | 'close', current: number, target: PositionTarget): boolean {
  return direction === 'open'
    ? target.position - current > target.tolerancePercent
    : current - target.position > target.tolerancePercent;
}
