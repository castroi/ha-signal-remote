import { describe, it, expect } from 'vitest';
import { CommandStateMachine, type Effect } from './state-machine.js';

const COVER = { entityId: 'cover.living_room', type: 'cover' as const, completionTimeoutMs: 30_000 };
const LIGHT = { entityId: 'light.garden', type: 'light' as const, completionTimeoutMs: 5_000 };

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
    expect(effectKinds(start)).toContain('issue-light');
    expect(sm.stateOf('c1')).toBe('issued');

    const done = sm.observeState(LIGHT.entityId, 'on');
    expect(sm.stateOf('c1')).toBe('observed_target');
    expect(effectKinds(done)).toContain('reply-success');
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
    const prompt = sm.submitAllCovers({
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
    sm.submitAllCovers({ commandId: 'c7', sourceUuid: 'u1', verb: 'close', entities: [COVER] });
    const wrong = sm.confirm('c7', 'u2');
    expect(wrong.accepted).toBe(false);
    expect(sm.stateOf('c7')).toBe('pending_confirm'); // still waiting
  });

  it('confirm after the 20s expiry window is rejected', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submitAllCovers({ commandId: 'c8', sourceUuid: 'u1', verb: 'close', entities: [COVER] });
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
    const failEffects = sm.markIssueFailed('c9');
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
    sm.submitAllCovers({ commandId: 'p5', sourceUuid: 'u1', verb: 'close', entities: [c1, c2] });
    sm.confirm('p5', 'u1');
    // c1 observed at 20 — that's c2's target, not c1's (30) → no completion
    const mid = sm.observeState(c1.entityId, 'open', 20);
    expect(effectKinds(mid)).not.toContain('reply-success');
    expect(sm.stateOf('p5')).toBe('issued');
    // c1 observed at its own target → success
    const done = sm.observeState(c1.entityId, 'open', 30);
    expect(effectKinds(done)).toContain('reply-success');
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

  it('for a multi-entity command, one failing entity emits reply-entity-failed and the command stays issued', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submitAllCovers({
      commandId: 'e2',
      sourceUuid: 'u1',
      verb: 'close',
      entities: [COVER, COVER2],
    });
    sm.confirm('e2', 'u1');
    expect(sm.stateOf('e2')).toBe('issued');

    // First entity fails.
    const effects = sm.markEntityIssueFailed('e2', COVER.entityId);
    expect(effectKinds(effects)).toContain('reply-entity-failed');
    expect(effectKinds(effects)).not.toContain('reply-failed');
    // Command is still issued (second entity still in flight).
    expect(sm.stateOf('e2')).toBe('issued');
  });

  it('when all entities fail, the command transitions to failed and emits reply-failed', () => {
    const sm = machine();
    sm.submitAllCovers({
      commandId: 'e3',
      sourceUuid: 'u1',
      verb: 'close',
      entities: [COVER, COVER2],
    });
    sm.confirm('e3', 'u1');

    // First entity fails.
    const e1 = sm.markEntityIssueFailed('e3', COVER.entityId);
    expect(effectKinds(e1)).toContain('reply-entity-failed');
    expect(sm.stateOf('e3')).toBe('issued');

    // Second entity also fails.
    const e2 = sm.markEntityIssueFailed('e3', COVER2.entityId);
    expect(effectKinds(e2)).toContain('reply-failed');
    expect(sm.stateOf('e3')).toBe('failed');
  });

  it('the surviving entity is still tracked to timeout after one entity fails', () => {
    const now = { t: 0 };
    const sm = machine(now);
    sm.submitAllCovers({
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
    expect(effectKinds(tickEffects)).toContain('reply-timeout');
    // The timeout reply should be for the surviving entity.
    const timeoutEffect = tickEffects.find((e) => e.kind === 'reply-timeout');
    expect(timeoutEffect).toBeDefined();
    if (timeoutEffect?.kind === 'reply-timeout') {
      expect(timeoutEffect.entityId).toBe(COVER2.entityId);
    }
  });

  it('cancelPendingConfirm silently fails the command without emitting reply-failed', () => {
    const sm = machine();
    sm.submitAllCovers({
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
