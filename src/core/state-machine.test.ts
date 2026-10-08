import { describe, it, expect } from 'vitest';
import { CommandStateMachine, type Effect, type EntityRef } from './state-machine.js';
import type { EntitySnapshot } from './status.js';

const COVER = { entityId: 'cover.living_room', type: 'cover' as const, completionTimeoutMs: 30_000 };
const LIGHT = { entityId: 'light.garden', type: 'light' as const, completionTimeoutMs: 5_000 };
const SWITCH = { entityId: 'switch.fan', type: 'switch' as const, completionTimeoutMs: 5_000 };

function machine(now = { t: 0 }) {
  return new CommandStateMachine({ now: () => now.t, decisionWindowMs: 30_000, confirmExpiryMs: 20_000 });
}

function effectKinds(effects: Effect[]): string[] {
  return effects.map((e) => e.kind);
}

describe('CommandStateMachine (design §5)', () => {
  it('a light command issues immediately, single-stage ack on observed target', () => {
    const sm = machine();
    const start = sm.submit({ commandId: 'c1', sourceUuid: 'u1', verb: 'on', entity: LIGHT });
    expect(start).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'issue-toggle', domain: 'light' })]),
    );
    // Single-stage: no progress ack for a toggle.
    expect(effectKinds(start)).not.toContain('reply-progress');
    expect(sm.stateOf('c1')).toBe('issued');

    const done = sm.observeState(LIGHT.entityId, 'on');
    expect(sm.stateOf('c1')).toBe('observed_target');
    expect(effectKinds(done)).toContain('reply-success');
  });

  it('a switch command rides the toggle path with domain switch (issue #25)', () => {
    const sm = machine();
    const start = sm.submit({ commandId: 'sw1', sourceUuid: 'u1', verb: 'off', entity: SWITCH });
    expect(start).toEqual([
      {
        kind: 'issue-toggle',
        commandId: 'sw1',
        entityId: SWITCH.entityId,
        domain: 'switch',
        verb: 'off',
      },
    ]);
    expect(sm.stateOf('sw1')).toBe('issued');

    // Wrong state does not complete; the verb's target state does.
    expect(sm.observeState(SWITCH.entityId, 'on')).toEqual([]);
    const done = sm.observeState(SWITCH.entityId, 'off');
    expect(sm.stateOf('sw1')).toBe('observed_target');
    expect(effectKinds(done)).toContain('reply-success');
  });

  it('a switch command times out honestly like a light (no false ack)', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submit({ commandId: 'sw2', sourceUuid: 'u1', verb: 'on', entity: SWITCH });
    now.t = SWITCH.completionTimeoutMs + 1;
    const fired = sm.tick();
    expect(sm.stateOf('sw2')).toBe('timeout');
    expect(effectKinds(fired)).toContain('reply-timeout');
  });

  it('a cover command gives two-stage feedback: ack-on-receipt then ack-on-completion', () => {
    const sm = machine();
    const start = sm.submit({ commandId: 'c2', sourceUuid: 'u1', verb: 'close', entity: COVER });
    expect(effectKinds(start)).toEqual(expect.arrayContaining(['issue-cover', 'reply-progress']));
    expect(sm.stateOf('c2')).toBe('issued');

    const done = sm.observeState(COVER.entityId, 'closed');
    expect(sm.stateOf('c2')).toBe('observed_target');
    expect(effectKinds(done)).toContain('reply-success');
  });

  it('per-entity completion timeout -> timeout + manual-check reply, no success', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submit({ commandId: 'c3', sourceUuid: 'u1', verb: 'close', entity: COVER });
    now.t = COVER.completionTimeoutMs + 1;
    const fired = sm.tick();
    expect(sm.stateOf('c3')).toBe('timeout');
    expect(effectKinds(fired)).toContain('reply-timeout');
  });

  it('conflict preemption: new command for an issued entity -> stop then new direction', () => {
    const sm = machine();
    sm.submit({ commandId: 'c4', sourceUuid: 'u1', verb: 'open', entity: COVER });
    const preempt = sm.submit({ commandId: 'c5', sourceUuid: 'u1', verb: 'close', entity: COVER });
    expect(sm.stateOf('c4')).toBe('preempted');
    // stop is issued, then the new direction
    const kinds = effectKinds(preempt);
    expect(kinds).toContain('issue-cover-stop');
    expect(kinds).toContain('issue-cover');
    expect(sm.stateOf('c5')).toBe('issued');
  });

  it('all-covers requires a context-bound confirm before issuing', () => {
    const sm = machine();
    const prompt = sm.submitAll({
      commandId: 'c6',
      sourceUuid: 'u1',
      verb: 'close',
      entities: [COVER],
    });
    expect(sm.stateOf('c6')).toBe('pending_confirm');
    expect(effectKinds(prompt)).toContain('reply-confirm-prompt');

    const confirm = sm.confirm('c6', 'u1');
    expect(confirm.accepted).toBe(true);
    expect(sm.stateOf('c6')).toBe('issued');
    expect(effectKinds(confirm.effects)).toContain('issue-cover');
  });

  it('confirm from a different sender is rejected (cross-sender binding)', () => {
    const sm = machine();
    sm.submitAll({ commandId: 'c7', sourceUuid: 'u1', verb: 'close', entities: [COVER] });
    const wrong = sm.confirm('c7', 'u2');
    expect(wrong.accepted).toBe(false);
    expect(sm.stateOf('c7')).toBe('pending_confirm'); // still waiting
  });

  it('confirm after the 20s expiry window is rejected', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submitAll({ commandId: 'c8', sourceUuid: 'u1', verb: 'close', entities: [COVER] });
    now.t = 20_001;
    sm.tick(); // expire pending confirms
    const late = sm.confirm('c8', 'u1');
    expect(late.accepted).toBe(false);
  });

  it('a no-issue HA failure -> failed immediately (item 6: no false success window)', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submit({ commandId: 'c9', sourceUuid: 'u1', verb: 'close', entity: COVER });
    // mark that the issue never landed (HA unreachable); item 6: fails immediately,
    // not after a decision window, so observeState can't race to a false success.
    const failEffects = sm.markEntityIssueFailed('c9', COVER.entityId);
    expect(sm.stateOf('c9')).toBe('failed');
    expect(effectKinds(failEffects)).toContain('reply-failed');
    expect(effectKinds(failEffects)).not.toContain('reply-success');
    // tick must not re-fire or resurrect
    now.t = 30_001;
    const tickEffects = sm.tick();
    expect(effectKinds(tickEffects)).not.toContain('reply-failed');
    expect(effectKinds(tickEffects)).not.toContain('reply-success');
  });

  it('an issued cover whose stream drops past the decision window -> timeout', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submit({ commandId: 'c10', sourceUuid: 'u1', verb: 'close', entity: COVER });
    // issued, but the state stream is lost before observing target
    now.t = COVER.completionTimeoutMs + 1;
    const fired = sm.tick();
    expect(sm.stateOf('c10')).toBe('timeout');
    expect(effectKinds(fired)).toContain('reply-timeout');
  });

  it('every command carries its correlation id through to effects', () => {
    const sm = machine();
    const start = sm.submit({ commandId: 'cID', sourceUuid: 'u1', verb: 'close', entity: COVER });
    for (const e of start) {
      expect(e.commandId).toBe('cID');
    }
  });
});

// ---------------------------------------------------------------------------
// Per-cover target positions (issue #1): position-aware completion
// ---------------------------------------------------------------------------

const COVER_TO_30 = {
  ...COVER,
  target: { position: 30, tolerancePercent: 3 },
};

describe('CommandStateMachine — preset position completion (issue #1)', () => {
  it('a preset cover command issues issue-cover-position and acks when observed within tolerance', () => {
    const sm = machine();
    const start = sm.submit({ commandId: 'p1', sourceUuid: 'u1', verb: 'close', entity: COVER_TO_30 });
    expect(effectKinds(start)).toEqual(
      expect.arrayContaining(['issue-cover-position', 'reply-progress']),
    );
    const issue = start.find((e) => e.kind === 'issue-cover-position');
    expect(issue).toMatchObject({
      entityId: COVER.entityId,
      scriptDirection: 'close',
      position: 30,
    });
    // 31 is within ±3 of 30 → success
    const done = sm.observeState(COVER.entityId, 'open', 31);
    expect(sm.stateOf('p1')).toBe('observed_target');
    expect(effectKinds(done)).toContain('reply-success');
  });

  it('a preset move outside tolerance never acks and eventually times out', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submit({
      commandId: 'p2',
      sourceUuid: 'u1',
      verb: 'open',
      entity: { ...COVER, target: { position: 80, tolerancePercent: 3 } },
    });
    const mid = sm.observeState(COVER.entityId, 'open', 60); // 20 off target
    expect(effectKinds(mid)).not.toContain('reply-success');
    expect(sm.stateOf('p2')).toBe('issued');
    now.t = COVER.completionTimeoutMs + 1;
    const fired = sm.tick();
    expect(sm.stateOf('p2')).toBe('timeout');
    expect(effectKinds(fired)).toContain('reply-timeout');
  });

  it('the tolerance band is inclusive at both edges', () => {
    const high = machine();
    high.submit({ commandId: 'p3a', sourceUuid: 'u1', verb: 'close', entity: COVER_TO_30 });
    high.observeState(COVER.entityId, 'open', 33); // +3, the upper edge
    expect(high.stateOf('p3a')).toBe('observed_target');

    const low = machine();
    low.submit({ commandId: 'p3b', sourceUuid: 'u1', verb: 'close', entity: COVER_TO_30 });
    low.observeState(COVER.entityId, 'open', 27); // -3, the lower edge
    expect(low.stateOf('p3b')).toBe('observed_target');
  });

  it('a position just outside the band does not complete', () => {
    const sm = machine();
    sm.submit({ commandId: 'p3c', sourceUuid: 'u1', verb: 'close', entity: COVER_TO_30 });
    const out = sm.observeState(COVER.entityId, 'open', 34); // 4 away, just outside ±3
    expect(effectKinds(out)).not.toContain('reply-success');
    expect(sm.stateOf('p3c')).toBe('issued');
  });

  it('a missing observed position cannot complete a preset command', () => {
    const sm = machine();
    sm.submit({ commandId: 'p4', sourceUuid: 'u1', verb: 'close', entity: COVER_TO_30 });
    const none = sm.observeState(COVER.entityId, 'open'); // no position attribute
    expect(effectKinds(none)).not.toContain('reply-success');
    expect(sm.stateOf('p4')).toBe('issued');
  });

  it('each cover in a preset all-covers command is judged against its own target', () => {
    const sm = machine();
    const c1 = { ...COVER, target: { position: 30, tolerancePercent: 3 } };
    const c2 = { ...COVER2, target: { position: 20, tolerancePercent: 3 } };
    sm.submitAll({ commandId: 'p5', sourceUuid: 'u1', verb: 'close', entities: [c1, c2] });
    sm.confirm('p5', 'u1');
    // c1 observed at 20 — that's c2's target, not c1's (30) → no completion
    const mid = sm.observeState(c1.entityId, 'open', 20);
    expect(effectKinds(mid)).not.toContain('reply-success');
    expect(sm.stateOf('p5')).toBe('issued');
    // c1 observed at its own target → settled, but c2 is still pending
    const half = sm.observeState(c1.entityId, 'open', 30);
    expect(half).toEqual([]);
    expect(sm.stateOf('p5')).toBe('issued');
    // c2 at its own target → one summary for the batch
    const done = sm.observeState(c2.entityId, 'open', 20);
    expect(done).toEqual([
      { kind: 'reply-summary', commandId: 'p5', done: [c1.entityId, c2.entityId], failed: [], timedOut: [] },
    ]);
    expect(sm.stateOf('p5')).toBe('observed_target');
  });
});

// ---------------------------------------------------------------------------
// Fix item 4 (MED): markEntityIssueFailed — per-entity failure for all-covers
// ---------------------------------------------------------------------------

const COVER2 = { entityId: 'cover.kitchen', type: 'cover' as const, completionTimeoutMs: 30_000 };

describe('CommandStateMachine.markEntityIssueFailed (fix item 4)', () => {
  it('for a single-entity command, behaves identically to markIssueFailed', () => {
    const sm = machine();
    sm.submit({ commandId: 'e1', sourceUuid: 'u1', verb: 'close', entity: COVER });
    const effects = sm.markEntityIssueFailed('e1', COVER.entityId);
    expect(sm.stateOf('e1')).toBe('failed');
    expect(effectKinds(effects)).toContain('reply-failed');
    expect(effectKinds(effects)).not.toContain('reply-entity-failed');
  });

  it('for a multi-entity command, one failing entity emits nothing yet and the command stays issued', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submitAll({
      commandId: 'e2',
      sourceUuid: 'u1',
      verb: 'close',
      entities: [COVER, COVER2],
    });
    sm.confirm('e2', 'u1');
    expect(sm.stateOf('e2')).toBe('issued');

    // First entity fails: reported in the final summary, not individually.
    const effects = sm.markEntityIssueFailed('e2', COVER.entityId);
    expect(effects).toEqual([]);
    // Command is still issued (second entity still in flight).
    expect(sm.stateOf('e2')).toBe('issued');
  });

  it('when all entities fail, the command transitions to failed and emits one summary', () => {
    const sm = machine();
    sm.submitAll({
      commandId: 'e3',
      sourceUuid: 'u1',
      verb: 'close',
      entities: [COVER, COVER2],
    });
    sm.confirm('e3', 'u1');

    // First entity fails.
    const e1 = sm.markEntityIssueFailed('e3', COVER.entityId);
    expect(e1).toEqual([]);
    expect(sm.stateOf('e3')).toBe('issued');

    // Second entity also fails.
    const e2 = sm.markEntityIssueFailed('e3', COVER2.entityId);
    expect(e2).toEqual([
      { kind: 'reply-summary', commandId: 'e3', done: [], failed: [COVER.entityId, COVER2.entityId], timedOut: [] },
    ]);
    expect(sm.stateOf('e3')).toBe('failed');
  });

  it('the surviving entity is still tracked to timeout after one entity fails', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submitAll({
      commandId: 'e4',
      sourceUuid: 'u1',
      verb: 'close',
      entities: [COVER, COVER2],
    });
    sm.confirm('e4', 'u1');

    // First entity fails.
    sm.markEntityIssueFailed('e4', COVER.entityId);

    // Advance past timeout.
    now.t = COVER2.completionTimeoutMs + 1;
    const tickEffects = sm.tick();
    expect(sm.stateOf('e4')).toBe('timeout');
    expect(tickEffects).toEqual([
      { kind: 'reply-summary', commandId: 'e4', done: [], failed: [COVER.entityId], timedOut: [COVER2.entityId] },
    ]);
  });

  it('cancelPendingConfirm silently fails the command without emitting reply-failed', () => {
    const sm = machine();
    sm.submitAll({
      commandId: 'e5',
      sourceUuid: 'u1',
      verb: 'close',
      entities: [COVER],
    });
    expect(sm.stateOf('e5')).toBe('pending_confirm');

    sm.cancelPendingConfirm('e5');
    expect(sm.stateOf('e5')).toBe('failed');

    // tick() must not resurrect or re-fire effects for the cancelled command.
    const tickEffects = sm.tick();
    expect(effectKinds(tickEffects)).not.toContain('reply-failed');
  });
});

// ---------------------------------------------------------------------------
// Per-device completion tracking: one settle() path for every command
// ---------------------------------------------------------------------------

const LIGHT2 = { entityId: 'light.wall', type: 'light' as const, completionTimeoutMs: 5_000 };
const SLOW_COVER = { entityId: 'cover.parents', type: 'cover' as const, completionTimeoutMs: 60_000 };

function batch(sm: CommandStateMachine, commandId: string, verb: 'open' | 'close', entities: EntityRef[], snapshot?: ReadonlyMap<string, EntitySnapshot>) {
  sm.submitAll({ commandId, sourceUuid: 'u1', verb, entities });
  return sm.confirm(commandId, 'u1', snapshot);
}

describe('CommandStateMachine — per-device completion', () => {
  it('A1: a batch resolves only when every device reached its target, with one summary', () => {
    const sm = machine();
    batch(sm, 'b1', 'close', [COVER, COVER2]);
    expect(sm.observeState(COVER.entityId, 'closed')).toEqual([]);
    expect(sm.stateOf('b1')).toBe('issued');
    expect(sm.observeState(COVER2.entityId, 'closed')).toEqual([
      { kind: 'reply-summary', commandId: 'b1', done: [COVER.entityId, COVER2.entityId], failed: [], timedOut: [] },
    ]);
    expect(sm.stateOf('b1')).toBe('observed_target');
  });

  it('A2: a device timing out does not drop a later-deadline device still moving', () => {
    const now = { t: 0 };
    const sm = machine(now);
    batch(sm, 'b2', 'close', [COVER, SLOW_COVER]);
    now.t = COVER.completionTimeoutMs + 1;
    expect(sm.tick()).toEqual([]); // COVER timed out, SLOW_COVER still pending
    expect(sm.stateOf('b2')).toBe('issued');
    expect(sm.observeState(SLOW_COVER.entityId, 'closed')).toEqual([
      { kind: 'reply-summary', commandId: 'b2', done: [SLOW_COVER.entityId], failed: [], timedOut: [COVER.entityId] },
    ]);
    expect(sm.stateOf('b2')).toBe('timeout');
  });

  it('A3: a new command on one cover preempts only that cover in the batch', () => {
    const sm = machine();
    batch(sm, 'b3', 'close', [COVER, COVER2]);
    const pre = sm.submit({ commandId: 'single', sourceUuid: 'u1', verb: 'stop', entity: COVER });
    expect(effectKinds(pre)).toContain('issue-cover-stop');
    expect(effectKinds(pre)).not.toContain('reply-preempted'); // batch is not cancelled
    expect(sm.stateOf('b3')).toBe('issued');
    // The other cover still completes the batch; the preempted one is not a failure.
    expect(sm.observeState(COVER2.entityId, 'closed')).toEqual([
      { kind: 'reply-summary', commandId: 'b3', done: [COVER2.entityId], failed: [], timedOut: [] },
    ]);
    expect(sm.stateOf('b3')).toBe('observed_target');
  });

  it('a batch whose every device was preempted ends preempted with no reply', () => {
    const sm = machine();
    batch(sm, 'b4', 'close', [COVER, COVER2]);
    sm.submit({ commandId: 's1', sourceUuid: 'u1', verb: 'open', entity: COVER });
    const last = sm.submit({ commandId: 's2', sourceUuid: 'u1', verb: 'open', entity: COVER2 });
    expect(effectKinds(last)).not.toContain('reply-summary');
    expect(effectKinds(last)).not.toContain('reply-preempted');
    expect(sm.stateOf('b4')).toBe('preempted');
  });

  it('A4: a new command on a light preempts the older light command (no stop effect)', () => {
    const sm = machine();
    sm.submit({ commandId: 'l1', sourceUuid: 'u1', verb: 'on', entity: LIGHT });
    const second = sm.submit({ commandId: 'l2', sourceUuid: 'u1', verb: 'off', entity: LIGHT });
    expect(effectKinds(second)).not.toContain('issue-cover-stop');
    expect(second).toContainEqual({ kind: 'reply-preempted', commandId: 'l1' });
    expect(sm.stateOf('l1')).toBe('preempted');
    expect(sm.observeState(LIGHT.entityId, 'off')).toEqual([{ kind: 'reply-success', commandId: 'l2' }]);
  });

  it('A4: a single light command after a batch preempts it in the batch; the next event resolves the single command', () => {
    // A batch of toggles (shape used by the all-toggles scope) issued with verb 'off'.
    const sm2 = machine();
    sm2.submitAll({ commandId: 'b6', sourceUuid: 'u1', verb: 'off', entities: [LIGHT, LIGHT2] });
    sm2.confirm('b6', 'u1');
    sm2.submit({ commandId: 'l3', sourceUuid: 'u1', verb: 'on', entity: LIGHT });
    expect(sm2.observeState(LIGHT.entityId, 'on')).toEqual([{ kind: 'reply-success', commandId: 'l3' }]);
    expect(sm2.observeState(LIGHT2.entityId, 'off')).toEqual([
      { kind: 'reply-summary', commandId: 'b6', done: [LIGHT2.entityId], failed: [], timedOut: [] },
    ]);
  });

  it('A5: duplicate events and events after a device settled have no effect', () => {
    const now = { t: 0 };
    const sm = machine(now);
    batch(sm, 'b7', 'close', [COVER, SLOW_COVER]);
    expect(sm.observeState(COVER.entityId, 'closed')).toEqual([]);
    expect(sm.observeState(COVER.entityId, 'closed')).toEqual([]); // duplicate
    now.t = SLOW_COVER.completionTimeoutMs + 1;
    expect(sm.tick()).toEqual([
      { kind: 'reply-summary', commandId: 'b7', done: [COVER.entityId], failed: [], timedOut: [SLOW_COVER.entityId] },
    ]);
    expect(sm.observeState(SLOW_COVER.entityId, 'closed')).toEqual([]); // after it timed out
  });

  it('G: a device already at its target per the snapshot counts as done immediately', () => {
    const sm = machine();
    const r = batch(
      sm,
      'b8',
      'close',
      [COVER, COVER2],
      new Map([[COVER.entityId, { state: 'closed', position: 0 }]]),
    );
    expect(effectKinds(r.effects)).not.toContain('reply-summary');
    expect(sm.observeState(COVER2.entityId, 'closed')).toEqual([
      { kind: 'reply-summary', commandId: 'b8', done: [COVER.entityId, COVER2.entityId], failed: [], timedOut: [] },
    ]);
  });

  it('G: every device already at target resolves at issue time without progress', () => {
    const sm = machine();
    const single = sm.submit({
      commandId: 'g1',
      sourceUuid: 'u1',
      verb: 'off',
      entity: LIGHT,
      snapshot: new Map([[LIGHT.entityId, { state: 'off' }]]),
    });
    expect(effectKinds(single)).toEqual(['issue-toggle', 'reply-success']);
    expect(sm.stateOf('g1')).toBe('observed_target');

    const cover = sm.submit({
      commandId: 'g2',
      sourceUuid: 'u1',
      verb: 'close',
      entity: COVER2,
      snapshot: new Map([[COVER2.entityId, { state: 'closed' }]]),
    });
    expect(effectKinds(cover)).toEqual(['issue-cover', 'reply-success']);
  });

  it('G: a preset device already within tolerance per the snapshot is done', () => {
    const sm = machine();
    const r = sm.submit({
      commandId: 'g3',
      sourceUuid: 'u1',
      verb: 'close',
      entity: COVER_TO_30,
      snapshot: new Map([[COVER.entityId, { state: 'open', position: 31 }]]),
    });
    expect(effectKinds(r)).toContain('reply-success');
  });

  it('one progress reply per issued batch, none when nothing is left pending', () => {
    const sm = machine();
    const r = batch(sm, 'b9', 'close', [COVER, COVER2]);
    expect(effectKinds(r.effects).filter((k) => k === 'reply-progress')).toHaveLength(1);
  });

  it('a batch of toggles gets one progress reply; a single toggle stays single-stage', () => {
    const sm = machine();
    sm.submitAll({ commandId: 'b10', sourceUuid: 'u1', verb: 'off', entities: [LIGHT, LIGHT2] });
    const r = sm.confirm('b10', 'u1');
    expect(effectKinds(r.effects).filter((k) => k === 'reply-progress')).toHaveLength(1);
    const single = sm.submit({ commandId: 's3', sourceUuid: 'u1', verb: 'on', entity: SWITCH });
    expect(effectKinds(single)).not.toContain('reply-progress');
  });

  it('cancelPendingConfirm leaves nothing for tick to report later', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submitAll({ commandId: 'b11', sourceUuid: 'u1', verb: 'close', entities: [COVER] });
    sm.cancelPendingConfirm('b11');
    now.t = 60_000;
    expect(sm.tick()).toEqual([]);
  });

  it('the confirm prompt carries the verb', () => {
    const sm = machine();
    const p = sm.submitAll({ commandId: 'b12', sourceUuid: 'u1', verb: 'open', entities: [COVER, COVER2] });
    expect(p).toEqual([{ kind: 'reply-confirm-prompt', commandId: 'b12', count: 2, verb: 'open', preset: false }]);
    const q = sm.submitAll({ commandId: 'b12p', sourceUuid: 'u1', verb: 'close', entities: [COVER_TO_30, COVER2] });
    expect(q).toEqual([{ kind: 'reply-confirm-prompt', commandId: 'b12p', count: 2, verb: 'close', preset: true }]);
  });

  it('F: finished records are pruned 10 minutes after they resolve; live ones never', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submit({ commandId: 'f1', sourceUuid: 'u1', verb: 'on', entity: LIGHT });
    sm.observeState(LIGHT.entityId, 'on'); // resolved at t=0
    sm.submit({ commandId: 'f2', sourceUuid: 'u1', verb: 'close', entity: { ...COVER, completionTimeoutMs: 3_600_000 } });
    sm.submitAll({ commandId: 'f3', sourceUuid: 'u1', verb: 'close', entities: [COVER2] });
    now.t = 10 * 60_000;
    expect(sm.prune()).toEqual([]); // not older than 10 min yet
    now.t = 10 * 60_000 + 1;
    expect(sm.prune()).toEqual(['f1']);
    expect(sm.stateOf('f1')).toBeUndefined();
    expect(sm.stateOf('f2')).toBe('issued');
    expect(sm.stateOf('f3')).toBe('pending_confirm');
  });

  it('clearAll during an issued batch: nothing is ever emitted for it', () => {
    const now = { t: 0 };
    const sm = machine(now);
    batch(sm, 'b13', 'close', [COVER, COVER2]);
    sm.clearAll();
    expect(sm.observeState(COVER.entityId, 'closed')).toEqual([]);
    now.t = 60_000;
    expect(sm.tick()).toEqual([]);
  });

  it('isPending is true only while the command still waits on that device', () => {
    const sm = machine();
    batch(sm, 'b15', 'close', [COVER, COVER2]);
    expect(sm.isPending('b15', COVER.entityId)).toBe(true);
    sm.observeState(COVER.entityId, 'closed');
    expect(sm.isPending('b15', COVER.entityId)).toBe(false);
    sm.submit({ commandId: 's4', sourceUuid: 'u1', verb: 'open', entity: COVER2 });
    expect(sm.isPending('b15', COVER2.entityId)).toBe(false); // preempted
    expect(sm.isPending('s4', COVER2.entityId)).toBe(true);
    sm.clearAll();
    expect(sm.isPending('s4', COVER2.entityId)).toBe(false);
  });

  it('issuedCoverEntityIds lists only covers still pending', () => {
    const sm = machine();
    batch(sm, 'b14', 'close', [COVER, COVER2]);
    sm.observeState(COVER.entityId, 'closed');
    expect(sm.issuedCoverEntityIds()).toEqual([COVER2.entityId]);
  });
});
