import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Bridge } from './bridge.js';
import { loadConfig, type Config } from './config.js';
import { AuditLogger, type AuditEvent } from '../core/audit.js';

const here = dirname(fileURLToPath(import.meta.url));
const aliasPath = resolve(here, '../../config/aliases.example.yaml');

function testConfig(): Config {
  return loadConfig({
    aliasPath,
    env: {
      HA_TOKEN: 'tok',
      HA_BASE_URL: 'http://localhost:8123',
      SIGNAL_API_URL: 'http://localhost:8080',
      BOT_NUMBER: '+1555',
      ALLOWLIST_UUIDS: 'u1',
      AUDIT_SALT: 'salt',
    },
  });
}

function harness(nowRef = { t: 1_000_000 }) {
  const sends: { message: string }[] = [];
  const haCalls: { entityId: string; verb: string }[] = [];
  const notices: string[] = [];

  const bridge = new Bridge({
    config: testConfig(),
    now: () => nowRef.t,
    emitNotice: (text) => notices.push(text),
    haRest: {
      callCover: vi.fn(async (entityId: string, verb: string) => {
        haCalls.push({ entityId, verb });
        return { ok: true } as const;
      }),
      callLight: vi.fn(async (entityId: string, verb: string) => {
        haCalls.push({ entityId, verb });
        return { ok: true } as const;
      }),
    },
    signal: {
      send: vi.fn(async (_uuid: string, _num: string, message: string) => {
        sends.push({ message });
        return true;
      }),
    },
    clock: {
      snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }),
    },
  });

  return { bridge, sends, haCalls, notices, nowRef };
}

function envelope(message: string, nowRef: { t: number }) {
  return { sourceUuid: 'u1', sourceNumber: '+1999', timestamp: nowRef.t, message };
}

describe('Bridge pipeline (design §5, go-live gate 4)', () => {
  it('drives a close-salon cover command to observed_target with two-stage feedback', async () => {
    const h = harness();
    // WS healthy for the full debounce window so covers are enabled.
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('סגור את הסלון', h.nowRef));

    // Cover issued + progress ack ("מבצע…") sent.
    expect(h.haCalls).toContainEqual({ entityId: 'cover.living_room', verb: 'close' });
    expect(h.sends.some((s) => s.message === 'מבצע…')).toBe(true);

    // HA reports the cover closed -> success ack.
    await h.bridge.onStateChanged('cover.living_room', 'closed');
    expect(h.sends.some((s) => s.message === 'בוצע')).toBe(true);
  });

  it('emits "reinitialized" exactly once across the session', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;
    await h.bridge.handleEnvelope(envelope('הדלק גינה', h.nowRef));
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('כבה גינה', h.nowRef));
    expect(h.notices.filter((n) => n === 'מעקב מצב אותחל מחדש')).toHaveLength(1);
  });

  it('fails closed on covers while WS is down, but lights still work', async () => {
    const h = harness();
    // WS never connected -> covers disabled.
    await h.bridge.handleEnvelope(envelope('סגור את הסלון', h.nowRef));
    expect(h.haCalls.find((c) => c.entityId.startsWith('cover'))).toBeUndefined();
    expect(h.sends.some((s) => s.message.includes('מושבתים'))).toBe(true);

    // Light works without WS.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('הדלק גינה', h.nowRef));
    expect(h.haCalls).toContainEqual({ entityId: 'light.garden', verb: 'on' });
  });

  it('drops a duplicate delivery (same uuid+ts+text): single action, single reply', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;
    const env = envelope('הדלק גינה', h.nowRef);
    await h.bridge.handleEnvelope(env);
    await h.bridge.handleEnvelope(env); // redelivery
    const lightCalls = h.haCalls.filter((c) => c.entityId === 'light.garden');
    expect(lightCalls).toHaveLength(1);
  });

  it('refuses a stale command (older than the freshness window)', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;
    const env = { sourceUuid: 'u1', sourceNumber: '+1999', timestamp: h.nowRef.t - 31_000, message: 'הדלק גינה' };
    await h.bridge.handleEnvelope(env);
    expect(h.sends.some((s) => s.message.includes('ישנה'))).toBe(true);
    expect(h.haCalls).toHaveLength(0);
  });

  it('answers סטטוס even when covers are disabled and kill is engaged', async () => {
    const h = harness();
    h.bridge.engageKill();
    await h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
    expect(h.sends.some((s) => s.message.startsWith('מצב:'))).toBe(true);
  });

  it('answers עזרה/תפריט with the help menu (audited), even in kill-switch safe mode', async () => {
    const auditEvents: AuditEvent[] = [];
    const nowRef = { t: 1_000_000 };
    const audit = new AuditLogger({
      salt: 'test-salt',
      sink: (line) => auditEvents.push(JSON.parse(line) as AuditEvent),
    });
    const sends: { message: string }[] = [];
    const haCalls: unknown[] = [];
    const bridge = new Bridge({
      config: testConfig(),
      now: () => nowRef.t,
      emitNotice: () => {},
      audit,
      haRest: {
        callCover: vi.fn(async () => { haCalls.push(1); return { ok: true } as const; }),
        callLight: vi.fn(async () => { haCalls.push(1); return { ok: true } as const; }),
      },
      signal: { send: vi.fn(async (_u: string, _n: string, message: string) => { sends.push({ message }); return true; }) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.engageKill();

    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'עזרה' });
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t + 1, message: 'תפריט' });

    // Both reply with the help menu — and never the kill reply or an HA action.
    expect(sends.filter((s) => s.message.startsWith('פקודות:'))).toHaveLength(2);
    expect(sends.some((s) => s.message === 'המערכת בכיבוי חירום')).toBe(false);
    expect(haCalls).toHaveLength(0);
    // The audit.ts 'help' result is emitted, with no raw UUID in the line.
    expect(auditEvents.filter((e) => e.result === 'help')).toHaveLength(2);
    for (const ev of auditEvents) expect(JSON.stringify(ev)).not.toContain('u1');
  });

  it('restart (startup) clears RAM state: a previously-seen dedup key is accepted again', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;
    const env = envelope('הדלק גינה', h.nowRef);
    await h.bridge.handleEnvelope(env);
    expect(h.haCalls.filter((c) => c.entityId === 'light.garden')).toHaveLength(1);

    // Simulate a restart: clear all pending/dedup state.
    h.bridge.startup();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(env); // same key, but state was cleared
    expect(h.haCalls.filter((c) => c.entityId === 'light.garden')).toHaveLength(2);
    // reinitialized re-emitted after restart
    expect(h.notices.filter((n) => n === 'מעקב מצב אותחל מחדש')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Integration tests for bugs fixed in items 1-11
// ---------------------------------------------------------------------------

describe('Item 1: confirm flow wired end-to-end through handleEnvelope', () => {
  it('כן after all-covers prompt issues all covers (confirm lane, not normal caps)', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // Submit all-covers command -> prompt.
    await h.bridge.handleEnvelope(envelope('סגור תריסים', h.nowRef));
    expect(h.sends.some((s) => s.message.includes('כן/לא'))).toBe(true);
    expect(h.haCalls.filter((c) => c.verb === 'close')).toHaveLength(0); // not issued yet

    // Reply כן -> all covers issued.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('כן', h.nowRef));
    const closeCalls = h.haCalls.filter((c) => c.verb === 'close');
    expect(closeCalls.length).toBeGreaterThanOrEqual(1); // all cover entities issued
  });

  it('לא cancels the pending confirm without issuing', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('סגור תריסים', h.nowRef));
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('לא', h.nowRef));

    expect(h.haCalls.filter((c) => c.verb === 'close')).toHaveLength(0);
    // cancelled reply sent
    expect(h.sends.some((s) => s.message === 'בוטל')).toBe(true);
  });

  it('כן without any pending confirm -> unrecognized control reply (menu fallback)', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;
    // No all-covers issued beforehand.
    await h.bridge.handleEnvelope(envelope('כן', h.nowRef));
    // Gets menu fallback, no HA calls.
    expect(h.haCalls).toHaveLength(0);
    expect(h.sends.length).toBeGreaterThan(0); // some reply
  });

  it('confirm lane bypasses normal rate cap (go-live gate 7)', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // Submit all-covers to enter pending_confirm.
    await h.bridge.handleEnvelope(envelope('סגור תריסים', h.nowRef));

    // Exhaust the per-sender rate cap (5/30s) with light commands.
    for (let i = 0; i < 5; i++) {
      h.nowRef.t += 1;
      await h.bridge.handleEnvelope(envelope('כבה גינה', h.nowRef));
    }

    // Next normal command is rate-limited.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('הדלק גינה', h.nowRef));
    expect(h.sends.some((s) => s.message.includes('יותר מדי'))).toBe(true);

    // But a valid כן must still succeed via the confirm lane.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('כן', h.nowRef));
    const closeCalls = h.haCalls.filter((c) => c.verb === 'close');
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('confirm from a different sender cannot resolve the pending_confirm', async () => {
    // Build a bridge that allows two senders.
    const cfg = loadConfig({
      aliasPath,
      env: {
        HA_TOKEN: 'tok',
        HA_BASE_URL: 'http://localhost:8123',
        SIGNAL_API_URL: 'http://localhost:8080',
        BOT_NUMBER: '+1555',
        ALLOWLIST_UUIDS: 'u1,u2',
        AUDIT_SALT: 'salt',
      },
    });
    const nowRef = { t: 1_000_000 };
    const haCalls: { entityId: string; verb: string }[] = [];
    const sends: string[] = [];
    const bridge = new Bridge({
      config: cfg,
      now: () => nowRef.t,
      emitNotice: () => {},
      haRest: {
        callCover: vi.fn(async (entityId, verb) => { haCalls.push({ entityId, verb }); return { ok: true } as const; }),
        callLight: vi.fn(async () => ({ ok: true } as const)),
      },
      signal: { send: vi.fn(async (_u, _n, msg) => { sends.push(msg); return true; }) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    // u1 submits all-covers.
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'סגור תריסים' });
    nowRef.t += 1;
    // u2 tries to confirm — should get unrecognized reply, not issue.
    await bridge.handleEnvelope({ sourceUuid: 'u2', sourceNumber: '+2', timestamp: nowRef.t, message: 'כן' });
    expect(haCalls.filter((c) => c.verb === 'close')).toHaveLength(0);
  });

  it('startup() clears pending_confirm state (go-live gate 4 — RAM cleared on restart)', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('סגור תריסים', h.nowRef));
    // Restart.
    h.bridge.startup();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // כן now has no matching pending context.
    await h.bridge.handleEnvelope(envelope('כן', h.nowRef));
    expect(h.haCalls.filter((c) => c.verb === 'close')).toHaveLength(0);
  });
});

describe('Item 2: future-timestamp guard routed to clock-unhealthy path', () => {
  it('a future-dated envelope (past 10s tolerance) disables covers via the clock-unhealthy path', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // Envelope timestamp 15s in the future of "now".
    const futureEnv = {
      sourceUuid: 'u1',
      sourceNumber: '+1999',
      timestamp: h.nowRef.t + 15_000, // 15s future > 10s tolerance
      message: 'סגור את הסלון',
    };
    await h.bridge.handleEnvelope(futureEnv);

    // Should get the clock-unhealthy reply, not a normal stale or success.
    expect(h.haCalls).toHaveLength(0);
    expect(h.sends.some((s) => s.message.includes('שעון'))).toBe(true);
  });

  it('a future envelope within tolerance (< 10s) still executes the command', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    const slightlyFutureEnv = {
      sourceUuid: 'u1',
      sourceNumber: '+1999',
      timestamp: h.nowRef.t + 5_000, // 5s future — within tolerance
      message: 'הדלק גינה',
    };
    await h.bridge.handleEnvelope(slightlyFutureEnv);

    // Light command goes through (within tolerance).
    expect(h.haCalls).toContainEqual({ entityId: 'light.garden', verb: 'on' });
  });

  it('clockHealth() threads futureEnvelopeMs into evaluateClockHealth (integration smoke)', () => {
    // The bridge.clockHealth() private method is called from coversEnabled().
    // We verify the end-to-end path: clock skew over threshold disables covers.
    const nowRef = { t: 1_000_000 };
    const sends: string[] = [];
    const haCalls: { entityId: string; verb: string }[] = [];
    const bridge = new Bridge({
      config: testConfig(),
      now: () => nowRef.t,
      emitNotice: () => {},
      haRest: {
        callCover: vi.fn(async (id, verb) => { haCalls.push({ entityId: id, verb }); return { ok: true } as const; }),
        callLight: vi.fn(async () => ({ ok: true } as const)),
      },
      signal: { send: vi.fn(async (_u, _n, msg) => { sends.push(msg); return true; }) },
      // Inject a clock reporting excessive skew (> 30s threshold).
      clock: { snapshot: () => ({ skewSampleMs: 60_000, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    return bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'סגור את הסלון' })
      .then(() => {
        // Clock skew > 30s -> covers disabled -> no HA call, clock reply.
        expect(haCalls).toHaveLength(0);
        expect(sends.some((m) => m.includes('שעון'))).toBe(true);
      });
  });
});

describe('Item 3: AuditLogger wired into Bridge', () => {
  it('emits an audit event for each decision point without logging raw UUID', async () => {
    const auditEvents: AuditEvent[] = [];
    const nowRef = { t: 1_000_000 };
    const audit = new AuditLogger({
      salt: 'test-salt',
      sink: (line) => auditEvents.push(JSON.parse(line) as AuditEvent),
    });
    const bridge = new Bridge({
      config: testConfig(),
      now: () => nowRef.t,
      emitNotice: () => {},
      audit,
      haRest: {
        callCover: vi.fn(async () => ({ ok: true } as const)),
        callLight: vi.fn(async () => ({ ok: true } as const)),
      },
      signal: { send: vi.fn(async () => true) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'הדלק גינה' });

    // At least one event emitted (reinitialized + issued).
    expect(auditEvents.length).toBeGreaterThanOrEqual(1);
    // Raw UUID must never appear in audit output.
    for (const ev of auditEvents) {
      expect(JSON.stringify(ev)).not.toContain('u1');
    }
  });

  it('emits a rejected/rate-limited audit event when rate cap trips', async () => {
    const auditEvents: AuditEvent[] = [];
    const nowRef = { t: 1_000_000 };
    const audit = new AuditLogger({
      salt: 'test-salt',
      sink: (line) => auditEvents.push(JSON.parse(line) as AuditEvent),
    });
    const bridge = new Bridge({
      config: testConfig(),
      now: () => nowRef.t,
      emitNotice: () => {},
      audit,
      haRest: {
        callCover: vi.fn(async () => ({ ok: true } as const)),
        callLight: vi.fn(async () => ({ ok: true } as const)),
      },
      signal: { send: vi.fn(async () => true) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    // Exhaust rate limit.
    for (let i = 0; i < 5; i++) {
      nowRef.t += 1;
      await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'הדלק גינה' });
    }
    nowRef.t += 1;
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'הדלק גינה' });

    const rateLimitedEvents = auditEvents.filter((e) => e.reasonCode === 'rate-limited');
    expect(rateLimitedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('emits a stale audit event with reasonCode stale', async () => {
    const auditEvents: AuditEvent[] = [];
    const nowRef = { t: 1_000_000 };
    const audit = new AuditLogger({
      salt: 'test-salt',
      sink: (line) => auditEvents.push(JSON.parse(line) as AuditEvent),
    });
    const bridge = new Bridge({
      config: testConfig(),
      now: () => nowRef.t,
      emitNotice: () => {},
      audit,
      haRest: { callCover: vi.fn(async () => ({ ok: true } as const)), callLight: vi.fn(async () => ({ ok: true } as const)) },
      signal: { send: vi.fn(async () => true) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t - 40_000, message: 'הדלק גינה' });
    expect(auditEvents.some((e) => e.reasonCode === 'stale')).toBe(true);
  });
});

describe('Item 4: ClockSource integration — skew over threshold disables covers end-to-end', () => {
  it('covers are disabled end-to-end when clockPort.snapshot() reports excessive skew', async () => {
    const nowRef = { t: 1_000_000 };
    const haCalls: { entityId: string; verb: string }[] = [];
    const sends: string[] = [];
    // Simulate a ClockSource reporting 60s skew (> 30s threshold).
    const clockPort = {
      snapshot: () => ({
        skewSampleMs: 60_000,
        lastGoodCheckAt: nowRef.t,
        allReferencesUnreachable: false,
      }),
    };
    const bridge = new Bridge({
      config: testConfig(),
      now: () => nowRef.t,
      emitNotice: () => {},
      haRest: {
        callCover: vi.fn(async (id, verb) => { haCalls.push({ entityId: id, verb }); return { ok: true } as const; }),
        callLight: vi.fn(async (id, verb) => { haCalls.push({ entityId: id, verb }); return { ok: true } as const; }),
      },
      signal: { send: vi.fn(async (_u, _n, msg) => { sends.push(msg); return true; }) },
      clock: clockPort,
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    // Cover command should be blocked by clock health.
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'סגור את הסלון' });
    expect(haCalls.filter((c) => c.entityId.startsWith('cover'))).toHaveLength(0);
    expect(sends.some((m) => m.includes('שעון'))).toBe(true);

    // Light command must still work (clock only gates covers).
    nowRef.t += 1;
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'הדלק גינה' });
    expect(haCalls).toContainEqual({ entityId: 'light.garden', verb: 'on' });
  });
});

describe('Item 5: stop command only acks on actual stopped state', () => {
  it('stop command does not ack on open or closed — only on stopped', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('עצור את הסלון', h.nowRef));
    expect(h.haCalls).toContainEqual({ entityId: 'cover.living_room', verb: 'stop' });

    // open and closed must NOT trigger success.
    const sendsBefore = h.sends.length;
    await h.bridge.onStateChanged('cover.living_room', 'open');
    await h.bridge.onStateChanged('cover.living_room', 'closed');
    expect(h.sends.filter((s) => s.message === 'בוצע').length).toBe(h.sends.slice(0, sendsBefore).filter((s) => s.message === 'בוצע').length);

    // stopped triggers success.
    await h.bridge.onStateChanged('cover.living_room', 'stopped');
    expect(h.sends.some((s) => s.message === 'בוצע')).toBe(true);
  });
});

describe('Item 6: markIssueFailed prevents false success ack', () => {
  it('HA call failure -> reply-failed immediately, observeState cannot then ack success', async () => {
    const nowRef = { t: 1_000_000 };
    const sends: string[] = [];
    const bridge = new Bridge({
      config: testConfig(),
      now: () => nowRef.t,
      emitNotice: () => {},
      haRest: {
        callCover: vi.fn(async () => ({ ok: false, reason: 'failed' } as const)),
        callLight: vi.fn(async () => ({ ok: true } as const)),
      },
      signal: { send: vi.fn(async (_u, _n, msg) => { sends.push(msg); return true; }) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    // Issue a cover command that will fail.
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'סגור את הסלון' });

    // reply-failed should have been sent (immediate, not deferred).
    expect(sends.some((m) => m === 'הפעולה נכשלה')).toBe(true);

    // A subsequent state-changed event must NOT produce a false success.
    const sendsBefore = sends.length;
    await bridge.onStateChanged('cover.living_room', 'closed');
    expect(sends.slice(sendsBefore).some((m) => m === 'בוצע')).toBe(false);
  });
});

describe('Item 7: preempted command gets a terminal reply', () => {
  it('preemption sends a preempted reply to the original sender', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // Issue first command (open).
    await h.bridge.handleEnvelope(envelope('פתח את הסלון', h.nowRef));
    expect(h.sends.some((s) => s.message === 'מבצע…')).toBe(true);
    const sendsAfterFirst = h.sends.length;

    // Issue conflicting command (close) on the same entity -> preempts first.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('סגור את הסלון', h.nowRef));

    // Original command must have received a preempted reply.
    expect(h.sends.slice(sendsAfterFirst).some((s) => s.message.includes('בוטלה'))).toBe(true);
  });
});

describe('Item 8: per-entity completion deadlines for all-covers', () => {
  it('tick emits reply-timeout for each timed-out cover entity in an all-covers command', async () => {
    const nowRef = { t: 1_000_000 };
    const sends: string[] = [];
    const cfg = testConfig();
    const bridge = new Bridge({
      config: cfg,
      now: () => nowRef.t,
      emitNotice: () => {},
      haRest: {
        callCover: vi.fn(async () => ({ ok: true } as const)),
        callLight: vi.fn(async () => ({ ok: true } as const)),
      },
      signal: { send: vi.fn(async (_u, _n, msg) => { sends.push(msg); return true; }) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    // Submit all-covers.
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'סגור תריסים' });
    nowRef.t += 1;
    // Confirm.
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'כן' });

    // Advance past the longest per-entity timeout (35s for some entities).
    nowRef.t += 40_000;
    await bridge.tick();

    // Each timed-out entity should produce its own timeout reply.
    const timeoutReplies = sends.filter((m) => m.includes('לא הגיב'));
    const coverCount = cfg.aliases.coverEntityIds().length;
    expect(timeoutReplies.length).toBe(coverCount);
  });
});

// ---------------------------------------------------------------------------
// Fix item 3 (MED): confirm handler re-checks kill switch + coversEnabled()
// ---------------------------------------------------------------------------

describe('Fix 3 (MED): confirm handler enforces kill-switch and covers-enabled gates', () => {
  it('כן after kill switch is engaged is blocked and does not actuate covers', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // Submit all-covers to get a pending confirm.
    await h.bridge.handleEnvelope(envelope('סגור תריסים', h.nowRef));
    expect(h.sends.some((s) => s.message.includes('כן/לא'))).toBe(true);

    // Engage kill switch while confirm is pending.
    h.bridge.engageKill();

    // כן must be blocked.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('כן', h.nowRef));

    // No covers actuated, killed reply sent.
    expect(h.haCalls.filter((c) => c.verb === 'close')).toHaveLength(0);
    expect(h.sends.some((s) => s.message === 'המערכת בכיבוי חירום')).toBe(true);
  });

  it('כן after WS goes down is blocked and does not actuate covers', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // Submit all-covers to get a pending confirm.
    await h.bridge.handleEnvelope(envelope('סגור תריסים', h.nowRef));
    expect(h.sends.some((s) => s.message.includes('כן/לא'))).toBe(true);

    // WS goes down while confirm is pending.
    h.bridge.onWsDisconnected();

    // כן must be blocked by the WS-down gate.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('כן', h.nowRef));

    expect(h.haCalls.filter((c) => c.verb === 'close')).toHaveLength(0);
    expect(h.sends.some((s) => s.message.includes('מושבתים'))).toBe(true);
  });

  it('כן before safety gates close still actuates covers (gate is not overly broad)', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('סגור תריסים', h.nowRef));
    h.nowRef.t += 1;
    // No kill switch, WS still healthy.
    await h.bridge.handleEnvelope(envelope('כן', h.nowRef));
    expect(h.haCalls.filter((c) => c.verb === 'close').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Fix item 4 (MED): one failed cover does not fail all-covers command
// ---------------------------------------------------------------------------

describe('Fix 4 (MED): per-entity failure in all-covers command', () => {
  it('when one cover HA call fails, others are still tracked to completion', async () => {
    const cfg = loadConfig({
      aliasPath,
      env: {
        HA_TOKEN: 'tok',
        HA_BASE_URL: 'http://localhost:8123',
        SIGNAL_API_URL: 'http://localhost:8080',
        BOT_NUMBER: '+1555',
        ALLOWLIST_UUIDS: 'u1',
        AUDIT_SALT: 'salt',
      },
    });
    const nowRef = { t: 1_000_000 };
    const sends: string[] = [];
    let coverCallCount = 0;

    const coverIds = cfg.aliases.coverEntityIds();
    // First cover entity fails; the rest succeed.
    const firstCoverId = coverIds[0]!;

    const bridge = new Bridge({
      config: cfg,
      now: () => nowRef.t,
      emitNotice: () => {},
      haRest: {
        callCover: vi.fn(async (entityId: string) => {
          coverCallCount++;
          if (entityId === firstCoverId) return { ok: false, reason: 'failed' } as const;
          return { ok: true } as const;
        }),
        callLight: vi.fn(async () => ({ ok: true } as const)),
      },
      signal: { send: vi.fn(async (_u, _n, msg) => { sends.push(msg); return true; }) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    // Submit all-covers then confirm.
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'סגור תריסים' });
    nowRef.t += 1;
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'כן' });

    // All cover entities were called (issue attempts for all).
    expect(coverCallCount).toBe(coverIds.length);

    // The failing entity should produce an entity-level failure reply.
    // The command as a whole should NOT have immediately emitted reply-failed if
    // other entities are still in flight.
    const failedReplies = sends.filter((m) => m === 'הפעולה נכשלה');
    const entityFailedReplies = sends.filter((m) => m.includes(firstCoverId) && m.includes('הפעולה נכשלה'));

    // If there is only one cover, the whole command fails (same as before).
    if (coverIds.length === 1) {
      expect(failedReplies.length).toBeGreaterThanOrEqual(1);
    } else {
      // Multiple covers: only the failing entity's failure is reported immediately.
      // The overall command should NOT be in a terminal failed state yet.
      expect(entityFailedReplies.length).toBeGreaterThanOrEqual(1);

      // Advance past the completion timeout to confirm remaining covers time out
      // (proves they are still being tracked, not silently dropped).
      nowRef.t += 40_000;
      await bridge.tick();

      const timeoutReplies = sends.filter((m) => m.includes('לא הגיב'));
      // The remaining (non-failed) covers should time out.
      expect(timeoutReplies.length).toBe(coverIds.length - 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix item 6 (MED): new all-covers command supersedes prior pending confirm
// ---------------------------------------------------------------------------

describe('Fix 6 (MED): new all-covers supersedes prior pending confirm without spurious failure', () => {
  it('a second all-covers while first is pending replaces the binding cleanly', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // First all-covers.
    await h.bridge.handleEnvelope(envelope('סגור תריסים', h.nowRef));
    expect(h.sends.some((s) => s.message.includes('כן/לא'))).toBe(true);
    const sendsAfterFirst = h.sends.length;

    // Second all-covers before confirming the first.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('פתח תריסים', h.nowRef));
    // A new prompt should appear.
    expect(h.sends.slice(sendsAfterFirst).some((s) => s.message.includes('כן/לא'))).toBe(true);

    // Confirm the second (latest) prompt.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('כן', h.nowRef));
    expect(h.haCalls.filter((c) => c.verb === 'open').length).toBeGreaterThanOrEqual(1);
    // No close calls — the first command was superseded, not issued.
    expect(h.haCalls.filter((c) => c.verb === 'close')).toHaveLength(0);
  });

  it('after supersede, advancing past expiry of the FIRST command does NOT emit a spurious failure reply for it', async () => {
    // Use a custom genCommandId so we can distinguish the two commands in replies.
    let seq = 0;
    const nowRef = { t: 1_000_000 };
    const sends: { message: string }[] = [];
    const haCalls: { entityId: string; verb: string }[] = [];
    const cfg = loadConfig({
      aliasPath,
      env: {
        HA_TOKEN: 'tok',
        HA_BASE_URL: 'http://localhost:8123',
        SIGNAL_API_URL: 'http://localhost:8080',
        BOT_NUMBER: '+1555',
        ALLOWLIST_UUIDS: 'u1',
        AUDIT_SALT: 'salt',
      },
    });
    const bridge = new Bridge({
      config: cfg,
      now: () => nowRef.t,
      emitNotice: () => {},
      genCommandId: () => `cmd-${++seq}`,
      haRest: {
        callCover: vi.fn(async (entityId: string, verb: string) => {
          haCalls.push({ entityId, verb });
          return { ok: true } as const;
        }),
        callLight: vi.fn(async () => ({ ok: true } as const)),
      },
      signal: { send: vi.fn(async (_u, _n, message) => { sends.push({ message }); return true; }) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    // First all-covers (cmd-1) — will be superseded.
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'סגור תריסים' });
    // cmd-1 is now pending_confirm.

    // Second all-covers (cmd-2) — supersedes cmd-1.
    nowRef.t += 1;
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'פתח תריסים' });
    // cmd-2 is now pending_confirm; cmd-1 was cancelled (state = failed silently).

    const sendsBeforeTick = sends.length;

    // Advance past the confirm expiry of cmd-1 (the cancelled command).
    // cmd-2 also expires here, which legitimately emits reply-failed for cmd-2.
    // cmd-1's cancelPendingConfirm already set it to failed so tick() should NOT
    // re-fire a reply-failed for cmd-1.
    nowRef.t += 21_000;
    await bridge.tick();

    const newReplies = sends.slice(sendsBeforeTick);
    // At most one reply-failed (for cmd-2 which is the live pending confirm).
    // There must NOT be two reply-failed messages (one for cmd-1, one for cmd-2).
    const failedReplies = newReplies.filter((s) => s.message === 'הפעולה נכשלה');
    expect(failedReplies.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Fix item 8 (LOW): future-timestamp latch reflected in ongoing coversEnabled()
// ---------------------------------------------------------------------------

describe('Fix 8 (LOW): future-timestamp latch gates subsequent cover commands', () => {
  it('after a future-timestamp envelope is detected, coversEnabled() stays false for subsequent commands', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // Send a future-timestamp envelope to trigger the clock-unhealthy path.
    await h.bridge.handleEnvelope({
      sourceUuid: 'u1',
      sourceNumber: '+1999',
      timestamp: h.nowRef.t + 20_000, // 20s future > 10s tolerance
      message: 'סגור את הסלון',
    });
    expect(h.sends.some((s) => s.message.includes('שעון'))).toBe(true);

    // A subsequent fresh cover command must also be blocked by the latched signal.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('סגור את הסלון', h.nowRef));
    expect(h.haCalls.filter((c) => c.entityId === 'cover.living_room')).toHaveLength(0);
    expect(h.sends.some((s) => s.message.includes('שעון'))).toBe(true);
  });
});

describe('Item 10: allAliases() returns canonical display names', () => {
  it('entity-unknown reply shows human-readable Hebrew names, not normalized stems', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('פתח בריכה', h.nowRef));
    const reply = h.sends.find((s) => s.message.includes('יעדים:'));
    expect(reply).toBeDefined();
    // The reply must contain at least one canonical Hebrew alias, not a normalized stem.
    // "סלון" is a canonical alias; its normalized form is the same, but multi-word
    // aliases like "חדר ילדים" would be mangled by normalize() as "חדר ילדימ".
    expect(reply!.message).toContain('חדר ילדים');
    expect(reply!.message).not.toContain('חדר ילדימ'); // normalized (mangled) form
  });

  it('ambiguous reply shows canonical names', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // Verb with no target -> ambiguous.
    await h.bridge.handleEnvelope(envelope('פתח', h.nowRef));
    const reply = h.sends.find((s) => s.message.includes('איזה?'));
    expect(reply).toBeDefined();
    expect(reply!.message).toContain('חדר ילדים'); // canonical multi-word alias
  });
});
