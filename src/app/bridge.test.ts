import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Bridge } from './bridge.js';
import { loadConfig, type Config } from './config.js';
import { AuditLogger, type AuditEvent } from '../core/audit.js';
import type { EntitySnapshot } from '../core/status.js';

const here = dirname(fileURLToPath(import.meta.url));
const aliasPath = resolve(here, '../../config/aliases.example.yaml');

const testConfigEnv = {
  HA_TOKEN: 'tok',
  HA_BASE_URL: 'http://localhost:8123',
  SIGNAL_API_URL: 'http://localhost:8080',
  SIGNAL_TOKEN: 'wrapper-token',
  BOT_NUMBER: '+1555',
  ALLOWLIST_UUIDS: 'u1',
  AUDIT_SALT: 'salt',
};

function testConfig(): Config {
  return loadConfig({ aliasPath, env: testConfigEnv });
}

// Default stubs for the preset-only and status-only port methods; other tests never hit them.
const noPositionPort = {
  getCoverPosition: async (): Promise<number | undefined> => undefined,
  getStates: async (): Promise<ReadonlyMap<string, EntitySnapshot> | undefined> => undefined,
  callPositionScript: async () => ({ ok: true }) as const,
};

// clockRef lets a test pin lastGoodCheckAt (default: tracks now, i.e. a good
// reference check "just happened" — the healthy steady state).
function harness(
  nowRef = { t: 1_000_000 },
  clockRef?: { lastGoodCheckAt: number },
  getStates: (ids: readonly string[]) => Promise<ReadonlyMap<string, EntitySnapshot> | undefined> =
    noPositionPort.getStates,
) {
  const sends: { message: string }[] = [];
  const haCalls: { entityId: string; verb: string; domain?: string }[] = [];
  const notices: string[] = [];

  const bridge = new Bridge({
    config: testConfig(),
    now: () => nowRef.t,
    emitNotice: (text) => notices.push(text),
    haRest: {
      ...noPositionPort,
      getStates,
      callCover: vi.fn(async (entityId: string, verb: string) => {
        haCalls.push({ entityId, verb });
        return { ok: true } as const;
      }),
      callToggle: vi.fn(async (domain: string, entityId: string, verb: string) => {
        haCalls.push({ entityId, verb, domain });
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
      snapshot: () => ({
        skewSampleMs: 0,
        lastGoodCheckAt: clockRef?.lastGoodCheckAt ?? nowRef.t,
        allReferencesUnreachable: false,
      }),
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
    expect(h.haCalls).toContainEqual({ entityId: 'light.garden', verb: 'on', domain: 'light' });

    // Switch works without WS too (issue #25: toggles are never WS-gated).
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('הדלק מאוורר', h.nowRef));
    expect(h.haCalls).toContainEqual({ entityId: 'switch.fan', verb: 'on', domain: 'switch' });
  });

  it('drives a switch command single-stage through the switch domain (issue #25)', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('הדלק מאוורר', h.nowRef));
    expect(h.haCalls).toContainEqual({ entityId: 'switch.fan', verb: 'on', domain: 'switch' });
    // Single-stage: no progress ack for a toggle.
    expect(h.sends.some((s) => s.message === 'מבצע…')).toBe(false);

    await h.bridge.onStateChanged('switch.fan', 'on');
    expect(h.sends.some((s) => s.message === 'בוצע')).toBe(true);

    // The off verb drives the other service.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('כבה שקע', h.nowRef));
    expect(h.haCalls).toContainEqual({
      entityId: 'switch.garden_socket',
      verb: 'off',
      domain: 'switch',
    });
  });

  it('kill switch blocks a switch command like any other', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;
    h.bridge.engageKill();

    await h.bridge.handleEnvelope(envelope('הדלק מאוורר', h.nowRef));
    expect(h.haCalls.filter((c) => c.entityId === 'switch.fan')).toHaveLength(0);
    expect(h.sends.some((s) => s.message === 'המערכת בכיבוי חירום')).toBe(true);
  });

  it('help reply lists the configured switches (issue #25)', async () => {
    const h = harness();
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;
    await h.bridge.handleEnvelope(envelope('עזרה', h.nowRef));
    const help = h.sends.at(-1)?.message ?? '';
    expect(help).toContain('מאוורר');
    expect(help).toContain('שקע');
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

  describe('סטטוס device states', () => {
    const configuredIds = [
      'cover.living_room',
      'cover.kitchen',
      'cover.kids_room',
      'cover.parents_room',
      'light.garden',
      'switch.fan',
      'switch.garden_socket',
    ];
    const allOpen = async (_ids?: readonly string[]) =>
      new Map<string, EntitySnapshot>([
        ['cover.living_room', { state: 'open', position: 20 }],
        ['cover.kitchen', { state: 'closing', position: 45 }],
        ['light.garden', { state: 'on' }],
        ['switch.fan', { state: 'off' }],
      ]);

    it('appends the device section under the health line', async () => {
      const h = harness(undefined, undefined, allOpen);
      await h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
      const [health, devices] = h.sends[0]!.message.split('\n\n🪟');
      expect(health!.startsWith('מצב:')).toBe(true);
      expect(health!.includes('\n')).toBe(false);
      expect(`🪟${devices}`).toBe(
        [
          '🪟 תריסים',
          'סלון 20%',
          'מטבח 45% (נסגר…)',
          'חדר ילדים לא זמין',
          'חדר הורים לא זמין',
          '',
          '💡 אורות',
          'גינה דלוק',
          '',
          '🔌 מתגים',
          'מאוורר כבוי',
          'שקע לא זמין',
        ].join('\n'),
      );
    });

    it('reads exactly the configured entity ids', async () => {
      const getStates = vi.fn(allOpen);
      const h = harness(undefined, undefined, getStates);
      await h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
      expect(getStates).toHaveBeenCalledTimes(1);
      expect([...(getStates.mock.calls[0]![0] ?? [])].sort()).toEqual([...configuredIds].sort());
    });

    it('still reports devices while the kill switch is engaged', async () => {
      const h = harness(undefined, undefined, allOpen);
      h.bridge.engageKill();
      await h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
      expect(h.sends[0]!.message).toContain('כיבוי חירום פעיל');
      expect(h.sends[0]!.message).toContain('סלון 20%');
    });

    it('sends the health line plus one unavailable line when HA is unreachable', async () => {
      const h = harness(undefined, undefined, async () => undefined);
      await h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
      expect(h.sends[0]!.message).toMatch(/^מצב: .*\n\nמצב מכשירים לא זמין$/);
    });

    it('still sends the health line when the read rejects, without leaking the error', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const h = harness(undefined, undefined, async () => {
          throw new Error('Bearer tok http://localhost:8123 <html>body</html>');
        });
        await h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
        expect(h.sends[0]!.message).toMatch(/^מצב: .*\n\nמצב מכשירים לא זמין$/);
        const logged = [...errSpy.mock.calls, ...logSpy.mock.calls].flat().join(' ');
        expect(logged).not.toContain('tok');
        expect(logged).not.toContain('8123');
        expect(logged).not.toContain('body');
      } finally {
        errSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it('shares one HA read across concurrent סטטוס messages', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const getStates = vi.fn(async () => {
        await gate;
        return allOpen();
      });
      const h = harness(undefined, undefined, getStates);
      const a = h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
      h.nowRef.t += 1; // distinct timestamp so dedup doesn't drop the second
      const b = h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
      // Both requests are now waiting and no snapshot is cached yet, so only the
      // in-flight share (not the 3s cache) can keep this at one read.
      await new Promise((r) => setImmediate(r));
      expect(getStates).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([a, b]);
      expect(getStates).toHaveBeenCalledTimes(1);
      expect(h.sends).toHaveLength(2);
      expect(h.sends.every((s) => s.message.includes('סלון 20%'))).toBe(true);
    });

    it('sends only the health line when no entities are configured', async () => {
      const getStates = vi.fn(allOpen);
      const sends: string[] = [];
      const nowRef = { t: 1_000_000 };
      const bridge = new Bridge({
        config: loadConfig({
          aliasPath: resolve(here, '__fixtures__/no-entities.yaml'),
          env: testConfigEnv,
        }),
        now: () => nowRef.t,
        haRest: {
          ...noPositionPort,
          getStates,
          callCover: vi.fn(async () => ({ ok: true }) as const),
          callToggle: vi.fn(async () => ({ ok: true }) as const),
        },
        signal: {
          send: vi.fn(async (_u: string, _n: string, message: string) => {
            sends.push(message);
            return true;
          }),
        },
        clock: {
          snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }),
        },
      });
      await bridge.handleEnvelope(envelope('סטטוס', nowRef));
      expect(getStates).not.toHaveBeenCalled();
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatch(/^מצב: [^\n]*$/);
    });

    it('caches the snapshot for 3s, then reads again', async () => {
      const getStates = vi.fn(allOpen);
      const h = harness(undefined, undefined, getStates);
      await h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
      h.nowRef.t += 2_999;
      await h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
      expect(getStates).toHaveBeenCalledTimes(1);
      h.nowRef.t += 1;
      await h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
      expect(getStates).toHaveBeenCalledTimes(2);
    });

    it('keeps device states out of the audit log', async () => {
      const auditLines: string[] = [];
      const nowRef = { t: 1_000_000 };
      const audit = new AuditLogger({ salt: 'test-salt', sink: (line) => auditLines.push(line) });
      const bridge = new Bridge({
        config: testConfig(),
        now: () => nowRef.t,
        audit,
        haRest: {
          ...noPositionPort,
          getStates: allOpen,
          callCover: vi.fn(async () => ({ ok: true }) as const),
          callToggle: vi.fn(async () => ({ ok: true }) as const),
        },
        signal: { send: vi.fn(async () => true) },
        clock: {
          snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }),
        },
      });
      await bridge.handleEnvelope(envelope('סטטוס', nowRef));
      const events = auditLines.map((l) => JSON.parse(l) as AuditEvent);
      expect(events.filter((e) => e.intent === 'status')).toEqual([
        expect.objectContaining({ intent: 'status', result: 'status' }),
      ]);
      for (const line of auditLines) {
        expect(line).not.toMatch(/סלון|גינה|%|position|cover\.|light\./);
      }
    });
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
        ...noPositionPort,
        callCover: vi.fn(async () => { haCalls.push(1); return { ok: true } as const; }),
        callToggle: vi.fn(async () => { haCalls.push(1); return { ok: true } as const; }),
      },
      signal: { send: vi.fn(async (_u: string, _n: string, message: string) => { sends.push({ message }); return true; }) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.engageKill();

    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'עזרה' });
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t + 1, message: 'תפריט' });

    // Both reply with the configured help menu — and never the kill reply or an HA action.
    const expectedHelp = testConfig().aliases.helpText();
    expect(sends.filter((s) => s.message === expectedHelp)).toHaveLength(2);
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
        SIGNAL_TOKEN: 'wrapper-token',
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
        ...noPositionPort,
        callCover: vi.fn(async (entityId, verb) => { haCalls.push({ entityId, verb }); return { ok: true } as const; }),
        callToggle: vi.fn(async () => ({ ok: true } as const)),
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
    expect(h.haCalls).toContainEqual({ entityId: 'light.garden', verb: 'on', domain: 'light' });
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
        ...noPositionPort,
        callCover: vi.fn(async (id, verb) => { haCalls.push({ entityId: id, verb }); return { ok: true } as const; }),
        callToggle: vi.fn(async () => ({ ok: true } as const)),
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
        ...noPositionPort,
        callCover: vi.fn(async () => ({ ok: true } as const)),
        callToggle: vi.fn(async () => ({ ok: true } as const)),
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
        ...noPositionPort,
        callCover: vi.fn(async () => ({ ok: true } as const)),
        callToggle: vi.fn(async () => ({ ok: true } as const)),
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
      haRest: { ...noPositionPort, callCover: vi.fn(async () => ({ ok: true } as const)), callToggle: vi.fn(async () => ({ ok: true } as const)) },
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
        ...noPositionPort,
        callCover: vi.fn(async (id, verb) => { haCalls.push({ entityId: id, verb }); return { ok: true } as const; }),
        callToggle: vi.fn(async (_domain, id, verb) => { haCalls.push({ entityId: id, verb }); return { ok: true } as const; }),
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

    // Switch command must still work too (issue #25: clock only gates covers).
    nowRef.t += 1;
    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'הדלק מאוורר' });
    expect(haCalls).toContainEqual({ entityId: 'switch.fan', verb: 'on' });
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
        ...noPositionPort,
        callCover: vi.fn(async () => ({ ok: false, reason: 'failed' } as const)),
        callToggle: vi.fn(async () => ({ ok: true } as const)),
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

  it('a failed switch call yields an honest failure reply, never a late success (issue #25)', async () => {
    const nowRef = { t: 1_000_000 };
    const sends: string[] = [];
    const bridge = new Bridge({
      config: testConfig(),
      now: () => nowRef.t,
      emitNotice: () => {},
      haRest: {
        ...noPositionPort,
        callCover: vi.fn(async () => ({ ok: true } as const)),
        callToggle: vi.fn(async () => ({ ok: false, reason: 'failed' } as const)),
      },
      signal: { send: vi.fn(async (_u, _n, msg) => { sends.push(msg); return true; }) },
      clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;

    await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'הדלק מאוורר' });
    expect(sends.some((m) => m === 'הפעולה נכשלה')).toBe(true);

    const sendsBefore = sends.length;
    await bridge.onStateChanged('switch.fan', 'on');
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
        ...noPositionPort,
        callCover: vi.fn(async () => ({ ok: true } as const)),
        callToggle: vi.fn(async () => ({ ok: true } as const)),
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

    // One summary names every timed-out cover (none dropped).
    const timeoutReplies = sends.filter((m) => m.includes('לא הגיב'));
    expect(timeoutReplies).toEqual([
      'הפעולה נכשלה: סלון (לא הגיב), מטבח (לא הגיב), חדר ילדים (לא הגיב), חדר הורים (לא הגיב)',
    ]);
    expect(cfg.aliases.coverEntityIds()).toHaveLength(4);
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
        SIGNAL_TOKEN: 'wrapper-token',
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
        ...noPositionPort,
        callCover: vi.fn(async (entityId: string) => {
          coverCallCount++;
          if (entityId === firstCoverId) return { ok: false, reason: 'failed' } as const;
          return { ok: true } as const;
        }),
        callToggle: vi.fn(async () => ({ ok: true } as const)),
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

    // Nothing is reported yet: the other covers are still in flight.
    expect(sends.some((m) => m.includes('נכשל'))).toBe(false);

    // The remaining covers are still tracked (not dropped) and time out; one
    // summary reports the failed cover and the timed-out ones.
    expect(firstCoverId).toBe('cover.living_room');
    nowRef.t += 40_000;
    await bridge.tick();
    expect(sends.at(-1)).toBe(
      'הפעולה נכשלה: סלון (נכשל), מטבח (לא הגיב), חדר ילדים (לא הגיב), חדר הורים (לא הגיב)',
    );
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
        SIGNAL_TOKEN: 'wrapper-token',
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
        ...noPositionPort,
        callCover: vi.fn(async (entityId: string, verb: string) => {
          haCalls.push({ entityId, verb });
          return { ok: true } as const;
        }),
        callToggle: vi.fn(async () => ({ ok: true } as const)),
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
    // Pin the last good reference check before the latch: the reference has not
    // yet vouched for the local clock, so the latch must hold.
    const clockRef = { lastGoodCheckAt: 1_000_000 };
    const h = harness({ t: 1_000_000 }, clockRef);
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

  it('releases the latch once a good reference check lands after it was set', async () => {
    const clockRef = { lastGoodCheckAt: 1_000_000 };
    const h = harness({ t: 1_000_000 }, clockRef);
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    // Latch via a future-dated envelope (a fast sender clock).
    await h.bridge.handleEnvelope({
      sourceUuid: 'u1',
      sourceNumber: '+1999',
      timestamp: h.nowRef.t + 20_000,
      message: 'סגור את הסלון',
    });

    // Still latched: no good check since the latch.
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('סגור את הסלון', h.nowRef));
    expect(h.haCalls).toHaveLength(0);

    // The 60s reference check succeeds with zero skew: the reference vouches
    // for the local clock, so covers must re-enable without a restart.
    h.nowRef.t += 60_000;
    clockRef.lastGoodCheckAt = h.nowRef.t;
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('סגור את הסלון', h.nowRef));
    expect(h.haCalls).toContainEqual({ entityId: 'cover.living_room', verb: 'close' });
  });

  it('סטטוס reports clock-future while latched, not clock-skew', async () => {
    const clockRef = { lastGoodCheckAt: 1_000_000 };
    const h = harness({ t: 1_000_000 }, clockRef);
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope({
      sourceUuid: 'u1',
      sourceNumber: '+1999',
      timestamp: h.nowRef.t + 20_000,
      message: 'סגור את הסלון',
    });

    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('סטטוס', h.nowRef));
    const status = h.sends.at(-1)!.message;
    expect(status).toContain('clock-future');
    expect(status).not.toContain('clock-skew');
  });
});

// ---------------------------------------------------------------------------
// Issue #1: per-cover preset target positions (open_to / close_to)
// ---------------------------------------------------------------------------

function presetHarness(currentPosition: number | undefined, nowRef = { t: 1_000_000 }) {
  const sends: { message: string }[] = [];
  const haCalls: { entityId: string; verb: string }[] = [];
  const scriptCalls: { script: string; entityIds: readonly string[]; position: number }[] = [];

  const bridge = new Bridge({
    config: testConfig(),
    now: () => nowRef.t,
    emitNotice: () => {},
    haRest: {
      ...noPositionPort,
      callCover: vi.fn(async (entityId: string, verb: string) => {
        haCalls.push({ entityId, verb });
        return { ok: true } as const;
      }),
      callToggle: vi.fn(async (_domain: string, entityId: string, verb: string) => {
        haCalls.push({ entityId, verb });
        return { ok: true } as const;
      }),
      getCoverPosition: vi.fn(async () => currentPosition),
      callPositionScript: vi.fn(
        async (script: string, entityIds: readonly string[], position: number) => {
          scriptCalls.push({ script, entityIds, position });
          return { ok: true } as const;
        },
      ),
    },
    signal: {
      send: vi.fn(async (_u: string, _n: string, message: string) => {
        sends.push({ message });
        return true;
      }),
    },
    clock: {
      snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }),
    },
  });

  return { bridge, sends, haCalls, scriptCalls, nowRef };
}

describe('Issue #1: preset position commands (open_to/close_to)', () => {
  it('open_to drives the cover via the position script and acks on observed position', async () => {
    const h = presetHarness(50); // salon open target = 80
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('העלה סלון', h.nowRef));

    // Actuated via the household script, not a native cover call.
    expect(h.scriptCalls).toContainEqual({
      script: 'script.covers_up',
      entityIds: ['cover.living_room'],
      position: 80,
    });
    expect(h.haCalls.filter((c) => c.entityId === 'cover.living_room')).toHaveLength(0);
    expect(h.sends.some((s) => s.message === 'מבצע…')).toBe(true);

    // Observed position within tolerance of 80 -> success.
    await h.bridge.onStateChanged('cover.living_room', 'open', 80);
    expect(h.sends.some((s) => s.message === 'בוצע')).toBe(true);
  });

  it('a preset move whose target is already reached replies "already there" and does not fire', async () => {
    const h = presetHarness(30); // salon close target = 30, already at 30
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('הנמך סלון', h.nowRef));

    expect(h.scriptCalls).toHaveLength(0);
    expect(h.sends.some((s) => s.message.includes('כבר'))).toBe(true);
  });

  it('a close_to that would reverse direction (cover more closed than target) is a no-op', async () => {
    const h = presetHarness(20); // current 20, close target 30 -> closing would have to open
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('הנמך סלון', h.nowRef));

    expect(h.scriptCalls).toHaveLength(0);
    expect(h.sends.some((s) => s.message.includes('כבר'))).toBe(true);
  });

  it('a cover that reports no position fails closed with a position-unknown reply', async () => {
    const h = presetHarness(undefined);
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('העלה סלון', h.nowRef));

    expect(h.scriptCalls).toHaveLength(0);
    expect(h.sends.some((s) => s.message.includes('לא ניתן לקרוא'))).toBe(true);
  });

  it('the full open verb still uses the native cover service, not the script', async () => {
    const h = presetHarness(50);
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('פתח סלון', h.nowRef));

    expect(h.haCalls).toContainEqual({ entityId: 'cover.living_room', verb: 'open' });
    expect(h.scriptCalls).toHaveLength(0);
  });

  it('a preset all-covers command fires the script for targeted covers and native for the rest', async () => {
    const h = presetHarness(50);
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('העלה תריסים', h.nowRef));
    expect(h.sends.some((s) => s.message.includes('כן/לא'))).toBe(true);

    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('כן', h.nowRef));

    // Covers with a configured open target go through the script.
    expect(
      h.scriptCalls.some((c) => c.entityIds[0] === 'cover.living_room' && c.position === 80),
    ).toBe(true);
    expect(h.scriptCalls.some((c) => c.entityIds[0] === 'cover.kitchen' && c.position === 90)).toBe(
      true,
    );
    // Covers with no preset for this direction fall back to the native open service.
    expect(h.haCalls.some((c) => c.entityId === 'cover.kids_room' && c.verb === 'open')).toBe(true);
  });

  it('a preset open exactly tolerance away is a no-op (strict band boundary)', async () => {
    const h = presetHarness(75); // salon open target 80, tol 5 -> gap is exactly 5, not > 5
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('העלה סלון', h.nowRef));

    expect(h.scriptCalls).toHaveLength(0);
    expect(h.sends.some((s) => s.message.includes('כבר'))).toBe(true);
  });

  it('a preset open one point past tolerance does move', async () => {
    const h = presetHarness(74); // gap is 6 > 5 -> fires
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('העלה סלון', h.nowRef));

    expect(h.scriptCalls).toContainEqual({
      script: 'script.covers_up',
      entityIds: ['cover.living_room'],
      position: 80,
    });
  });

  it('all-covers preset skips the per-cover reversal guard (fires even when a single cover would no-op)', async () => {
    const h = presetHarness(80); // 80 == salon open target: a single "העלה סלון" would be a no-op
    h.bridge.onWsConnected();
    h.nowRef.t += 11_000;

    await h.bridge.handleEnvelope(envelope('העלה תריסים', h.nowRef));
    h.nowRef.t += 1;
    await h.bridge.handleEnvelope(envelope('כן', h.nowRef));

    // Despite current == target, the batch still issues the script for every targeted cover
    // (direction safety is delegated to the HA script, not the bridge, for the batch path).
    expect(
      h.scriptCalls.some((c) => c.entityIds[0] === 'cover.living_room' && c.position === 80),
    ).toBe(true);
    expect(h.scriptCalls.some((c) => c.entityIds[0] === 'cover.kitchen' && c.position === 90)).toBe(
      true,
    );
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

// ---------------------------------------------------------------------------
// Per-device completion: snapshot, one progress, one summary, cancel, kill
// ---------------------------------------------------------------------------

describe('per-device completion through the bridge', () => {
  const COVERS = ['cover.living_room', 'cover.kitchen', 'cover.kids_room', 'cover.parents_room'];

  function batchHarness(opts: {
    failCover?: string;
    states?: ReadonlyMap<string, EntitySnapshot>;
    audit?: AuditLogger;
    skewMs?: number;
  } = {}) {
    const nowRef = { t: 1_000_000 };
    const sends: string[] = [];
    const coverCalls: { entityId: string; verb: string }[] = [];
    const toggleCalls: { entityId: string; verb: string }[] = [];
    const bridge = new Bridge({
      config: testConfig(),
      now: () => nowRef.t,
      emitNotice: () => {},
      ...(opts.audit ? { audit: opts.audit } : {}),
      haRest: {
        ...noPositionPort,
        getStates: async () => opts.states,
        callCover: vi.fn(async (entityId: string, verb: string) => {
          coverCalls.push({ entityId, verb });
          return entityId === opts.failCover ? ({ ok: false, reason: 'failed' } as const) : ({ ok: true } as const);
        }),
        callToggle: vi.fn(async (_domain: string, entityId: string, verb: string) => {
          toggleCalls.push({ entityId, verb });
          return { ok: true } as const;
        }),
      },
      signal: { send: vi.fn(async (_u: string, _n: string, m: string) => { sends.push(m); return true; }) },
      clock: {
        snapshot: () => ({ skewSampleMs: opts.skewMs ?? 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }),
      },
    });
    bridge.onWsConnected();
    nowRef.t += 11_000;
    const say = async (message: string, sourceUuid = 'u1', timestamp?: number) => {
      nowRef.t += 1;
      await bridge.handleEnvelope({ sourceUuid, sourceNumber: '+1', timestamp: timestamp ?? nowRef.t, message });
    };
    return { bridge, sends, coverCalls, toggleCalls, nowRef, say };
  }

  it('G: a light already in the target state acks immediately', async () => {
    const h = batchHarness({ states: new Map([['light.garden', { state: 'off' }]]) });
    await h.say('כבה גינה');
    expect(h.sends).toContain('בוצע');
    h.nowRef.t += 10_000;
    await h.bridge.tick();
    expect(h.sends.some((m) => m.includes('לא הגיב'))).toBe(false);
  });

  it('G: covers already closed count as done in the batch', async () => {
    const h = batchHarness({
      states: new Map([
        ['cover.living_room', { state: 'closed', position: 0 }],
        ['cover.kitchen', { state: 'closed', position: 0 }],
      ]),
    });
    await h.say('סגור תריסים');
    await h.say('כן');
    await h.bridge.onStateChanged('cover.kids_room', 'closed');
    await h.bridge.onStateChanged('cover.parents_room', 'closed');
    expect(h.sends.at(-1)).toBe('בוצע');
  });

  it('C: a confirmed batch sends exactly one progress reply and one בוצע at the end', async () => {
    const h = batchHarness();
    await h.say('סגור תריסים');
    await h.say('כן');
    expect(h.sends.filter((m) => m === 'מבצע…')).toHaveLength(1);
    for (const id of COVERS.slice(0, 3)) await h.bridge.onStateChanged(id, 'closed');
    expect(h.sends).not.toContain('בוצע');
    await h.bridge.onStateChanged(COVERS[3]!, 'closed');
    expect(h.sends.filter((m) => m === 'בוצע')).toHaveLength(1);
  });

  it('summary names the device that did not respond', async () => {
    const h = batchHarness();
    await h.say('סגור תריסים');
    await h.say('כן');
    for (const id of COVERS.slice(0, 3)) await h.bridge.onStateChanged(id, 'closed');
    h.nowRef.t += 40_000;
    await h.bridge.tick();
    expect(h.sends.at(-1)).toBe('בוצע, חוץ מ: חדר הורים (לא הגיב)');
  });

  it('summary names the device whose HA call failed', async () => {
    const h = batchHarness({ failCover: 'cover.kitchen' });
    await h.say('סגור תריסים');
    await h.say('כן');
    expect(h.sends.some((m) => m.includes('cover.kitchen'))).toBe(false);
    for (const id of ['cover.living_room', 'cover.kids_room', 'cover.parents_room']) {
      await h.bridge.onStateChanged(id, 'closed');
    }
    expect(h.sends.at(-1)).toBe('בוצע, חוץ מ: מטבח (נכשל)');
  });

  it('nothing done → הפעולה נכשלה with the reasons', async () => {
    const h = batchHarness({ failCover: 'cover.kitchen' });
    await h.say('סגור תריסים');
    await h.say('כן');
    h.nowRef.t += 40_000;
    await h.bridge.tick();
    expect(h.sends.at(-1)).toBe(
      'הפעולה נכשלה: סלון (לא הגיב), מטבח (נכשל), חדר ילדים (לא הגיב), חדר הורים (לא הגיב)',
    );
  });

  it.each([
    ['פתח תריסים', 'לפתוח את כל 4 התריסים? כן/לא'],
    ['סגור תריסים', 'לסגור את כל 4 התריסים? כן/לא'],
    ['העלה תריסים', 'להרים את כל 4 התריסים? כן/לא'],
    ['הנמך תריסים', 'להוריד את כל 4 התריסים? כן/לא'],
  ])('B: %s prompts "%s"', async (command, prompt) => {
    const h = batchHarness();
    await h.say(command);
    expect(h.sends.at(-1)).toBe(prompt);
  });

  it('E: לא cancels for real — no late הפעולה נכשלה', async () => {
    const h = batchHarness();
    await h.say('סגור תריסים');
    await h.say('לא');
    expect(h.sends.at(-1)).toBe('בוטל');
    h.nowRef.t += 30_000;
    await h.bridge.tick();
    expect(h.sends.at(-1)).toBe('בוטל');
  });

  it('K: the kill switch stops only covers still moving and silences the batch', async () => {
    const h = batchHarness();
    await h.say('סגור תריסים');
    await h.say('כן');
    await h.bridge.onStateChanged('cover.living_room', 'closed');
    const before = h.coverCalls.length;
    h.bridge.engageKill();
    const stops = h.coverCalls.slice(before).filter((c) => c.verb === 'stop').map((c) => c.entityId);
    expect(stops.sort()).toEqual(['cover.kids_room', 'cover.kitchen', 'cover.parents_room']);
    const sent = h.sends.length;
    h.nowRef.t += 60_000;
    await h.bridge.tick();
    await h.bridge.onStateChanged('cover.kitchen', 'closed');
    expect(h.sends).toHaveLength(sent);
  });

  it('#1: a kill switch engaged while the snapshot is read stops a single command', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = batchHarness();
    const getStates = vi.fn(async () => {
      await gate;
      return undefined;
    });
    (h.bridge as unknown as { haRest: { getStates: typeof getStates } }).haRest.getStates = getStates;
    const pending = h.say('סגור סלון');
    await new Promise((r) => setImmediate(r));
    h.bridge.engageKill();
    release();
    await pending;
    expect(h.coverCalls.filter((c) => c.verb === 'close')).toHaveLength(0);
    expect(h.sends.at(-1)).toBe('המערכת בכיבוי חירום');
  });

  it('#2: a newer batch arriving while כן reads the snapshot keeps its own pending confirm', async () => {
    const h = batchHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    (h.bridge as unknown as { haRest: { getStates: () => Promise<undefined> } }).haRest.getStates = async () => {
      if (first) {
        first = false;
        await gate;
      }
      return undefined;
    };
    await h.say('סגור תריסים');
    const yes = h.say('כן'); // reads the snapshot (blocked)
    await new Promise((r) => setImmediate(r));
    await h.say('פתח תריסים'); // supersedes while the first כן waits
    release();
    await yes;
    expect(h.coverCalls.filter((c) => c.verb === 'close')).toHaveLength(0);
    await h.say('כן'); // confirms the newer batch
    expect(h.coverCalls.filter((c) => c.verb === 'open')).toHaveLength(4);
  });

  it('#4: the kill switch engaged mid-batch issues no further covers', async () => {
    const h = batchHarness();
    const callCover = (h.bridge as unknown as { haRest: { callCover: ReturnType<typeof vi.fn> } }).haRest.callCover;
    callCover.mockImplementationOnce(async (entityId: string, verb: string) => {
      h.coverCalls.push({ entityId, verb });
      h.bridge.engageKill();
      return { ok: true } as const;
    });
    await h.say('סגור תריסים');
    await h.say('כן');
    expect(h.coverCalls.filter((c) => c.verb === 'close')).toHaveLength(1);
  });

  it('a single command arriving mid-batch is not overridden by the batch', async () => {
    const h = batchHarness();
    const callCover = (h.bridge as unknown as { haRest: { callCover: ReturnType<typeof vi.fn> } }).haRest.callCover;
    let single: Promise<void> | undefined;
    callCover.mockImplementationOnce(async (entityId: string, verb: string) => {
      h.coverCalls.push({ entityId, verb });
      // While the batch is on its first cover, the kitchen gets its own command.
      single = h.say('פתח מטבח');
      await single;
      return { ok: true } as const;
    });
    await h.say('סגור תריסים');
    await h.say('כן');
    await single;
    const kitchen = h.coverCalls.filter((c) => c.entityId === 'cover.kitchen').map((c) => c.verb);
    expect(kitchen).toEqual(['stop', 'open']); // the batch's older 'close' never follows
    expect(h.coverCalls.filter((c) => c.verb === 'close').map((c) => c.entityId)).toEqual([
      'cover.living_room',
      'cover.kids_room',
      'cover.parents_room',
    ]);
  });

  it('a device already at its target gets no HA call', async () => {
    const h = batchHarness({ states: new Map([['cover.living_room', { state: 'closed', position: 0 }]]) });
    await h.say('סגור תריסים');
    await h.say('כן');
    expect(h.coverCalls.some((c) => c.entityId === 'cover.living_room')).toBe(false);
  });

  it('K: a כן sent after the kill switch dropped the pending confirm says why', async () => {
    const h = batchHarness();
    await h.say('סגור תריסים');
    h.bridge.engageKill();
    await h.say('כן');
    expect(h.sends.at(-1)).toBe('המערכת בכיבוי חירום');
    expect(h.coverCalls.filter((c) => c.verb === 'close')).toHaveLength(0);
  });

  it('F: a pruned command is forgotten by the bridge as well', async () => {
    const h = batchHarness();
    await h.say('כבה גינה');
    await h.bridge.onStateChanged('light.garden', 'off');
    const replyTo = (h.bridge as unknown as { replyTo: Map<string, unknown> }).replyTo;
    expect(replyTo.size).toBe(1);
    h.nowRef.t += 10 * 60_000 + 1;
    await h.bridge.tick();
    expect(replyTo.size).toBe(0);
  });

  describe('הכל scope (all lights + switches)', () => {
    const OFF_SET = ['light.garden', 'switch.fan', 'switch.garden_socket'];

    it.each([
      ['כבה הכל', 'לכבות את כל 3 האורות והמתגים? כן/לא'],
      ['הדלק הכל', 'להדליק את כל 2 האורות והמתגים? כן/לא'],
    ])('%s prompts "%s"', async (command, prompt) => {
      const h = batchHarness();
      await h.say(command);
      expect(h.sends.at(-1)).toBe(prompt);
      expect(h.toggleCalls).toHaveLength(0);
    });

    it('כבה הכל + כן turns off every light and switch, never a cover, with one summary', async () => {
      const h = batchHarness();
      await h.say('כבה הכל');
      await h.say('כן');
      expect(h.toggleCalls).toEqual(OFF_SET.map((entityId) => ({ entityId, verb: 'off' })));
      expect(h.coverCalls).toHaveLength(0);
      expect(h.sends.filter((m) => m === 'מבצע…')).toHaveLength(1);
      for (const id of OFF_SET) await h.bridge.onStateChanged(id, 'off');
      expect(h.sends.at(-1)).toBe('בוצע');
    });

    it('devices already off are done without an HA call', async () => {
      const h = batchHarness({ states: new Map([['light.garden', { state: 'off' }]]) });
      await h.say('כבה הכל');
      await h.say('כן');
      expect(h.toggleCalls.map((c) => c.entityId)).toEqual(['switch.fan', 'switch.garden_socket']);
      await h.bridge.onStateChanged('switch.fan', 'off');
      await h.bridge.onStateChanged('switch.garden_socket', 'off');
      expect(h.sends.at(-1)).toBe('בוצע');
    });

    it('הדלק הכל + כן turns on lights and only all_on switches', async () => {
      const h = batchHarness();
      await h.say('הדלק הכל');
      await h.say('כן');
      expect(h.toggleCalls).toEqual([
        { entityId: 'light.garden', verb: 'on' },
        { entityId: 'switch.fan', verb: 'on' },
      ]);
    });

    it('works while the clock is unhealthy (covers would be refused)', async () => {
      const h = batchHarness({ skewMs: 120_000 });
      await h.say('כבה הכל');
      await h.say('כן');
      expect(h.toggleCalls).toHaveLength(3);
    });

    it('is refused while the HA WebSocket is down, at submit and at כן', async () => {
      const h = batchHarness();
      h.bridge.onWsDisconnected();
      await h.say('כבה הכל');
      expect(h.sends.at(-1)).toBe('אין כרגע מעקב מצב, נסה שוב בעוד רגע');

      const h2 = batchHarness();
      await h2.say('כבה הכל');
      h2.bridge.onWsDisconnected();
      await h2.say('כן');
      expect(h2.sends.at(-1)).toBe('אין כרגע מעקב מצב, נסה שוב בעוד רגע');
      expect(h2.toggleCalls).toHaveLength(0);
    });

    it('the kill switch refuses it, also between prompt and כן', async () => {
      const h = batchHarness();
      await h.say('כבה הכל');
      h.bridge.engageKill();
      await h.say('כן');
      expect(h.sends.at(-1)).toBe('המערכת בכיבוי חירום');
      expect(h.toggleCalls).toHaveLength(0);
    });

    it.each(['פתח הכל', 'עצור הכל', 'העלה הכל'])('%s is rejected: only הדלק / כבה', async (command) => {
      const lines: string[] = [];
      const h = batchHarness({ audit: new AuditLogger({ salt: 's', sink: (l) => lines.push(l) }) });
      await h.say(command);
      expect(h.sends.at(-1)).toBe('"הכל" עובד רק עם הדלק / כבה');
      expect(h.toggleCalls).toHaveLength(0);
      expect(h.coverCalls).toHaveLength(0);
      expect(lines.map((l) => JSON.parse(l) as AuditEvent)).toContainEqual(
        expect.objectContaining({ result: 'rejected', reasonCode: 'unsupported-verb' }),
      );
    });

    it('a second הכל within 60s is refused — per sender and globally', async () => {
      const h = batchHarness();
      await h.say('כבה הכל');
      await h.say('לא');
      await h.say('כבה הכל');
      expect(h.sends.at(-1)).toBe('יותר מדי פקודות, נסה עוד רגע');
      await h.say('הדלק הכל', 'u2');
      expect(h.sends.at(-1)).toBe('יותר מדי פקודות, נסה עוד רגע');
      h.nowRef.t += 60_001;
      await h.say('כבה הכל');
      expect(h.sends.at(-1)).toContain('כן/לא');
    });

    it('a הכל prompt and a תריסים prompt supersede each other (audited)', async () => {
      const lines: string[] = [];
      const h = batchHarness({ audit: new AuditLogger({ salt: 's', sink: (l) => lines.push(l) }) });
      await h.say('סגור תריסים');
      await h.say('כבה הכל');
      await h.say('כן');
      expect(h.toggleCalls).toHaveLength(3);
      expect(h.coverCalls).toHaveLength(0);
      expect(lines.map((l) => JSON.parse(l) as AuditEvent)).toContainEqual(
        expect.objectContaining({ result: 'rejected', reasonCode: 'superseded' }),
      );

      const h2 = batchHarness();
      await h2.say('כבה הכל');
      await h2.say('סגור תריסים');
      await h2.say('כן');
      expect(h2.coverCalls.filter((c) => c.verb === 'close')).toHaveLength(4);
      expect(h2.toggleCalls).toHaveLength(0);
    });

    it('after a supersede, a כן sent before the new prompt is refused; a later one confirms', async () => {
      const h = batchHarness();
      await h.say('סגור תריסים');
      const yesForCovers = h.nowRef.t + 1; // typed for the covers prompt…
      await h.say('הדלק הכל'); // …but הדלק הכל (later timestamp) arrived first
      await h.say('כן', 'u1', yesForCovers);
      expect(h.sends.at(-1)).toBe('הבקשה השתנתה, שלח כן שוב');
      expect(h.toggleCalls).toHaveLength(0);
      expect(h.coverCalls).toHaveLength(0);
      await h.say('כן');
      expect(h.toggleCalls).toHaveLength(2);
    });

    it('a כן stamped strictly before the superseding command is refused too', async () => {
      const h = batchHarness();
      await h.say('סגור תריסים');
      const early = h.nowRef.t; // the covers prompt's own timestamp
      await h.say('כבה הכל');
      await h.say('כן', 'u1', early + 0.5);
      expect(h.sends.at(-1)).toBe('הבקשה השתנתה, שלח כן שוב');
    });

    it('an expired earlier prompt is not counted as superseded', async () => {
      const lines: string[] = [];
      const h = batchHarness({ audit: new AuditLogger({ salt: 's', sink: (l) => lines.push(l) }) });
      await h.say('סגור תריסים');
      h.nowRef.t += 21_000;
      await h.bridge.tick(); // the covers prompt expires
      const late = h.nowRef.t + 1;
      await h.say('כבה הכל');
      expect(lines.map((l) => JSON.parse(l) as AuditEvent).some((e) => e.reasonCode === 'superseded')).toBe(false);
      await h.say('כן', 'u1', late); // equal timestamp, but no supersede → confirms
      expect(h.toggleCalls).toHaveLength(3);
    });

    it('a prompt past its deadline but not yet ticked is not counted as superseded', async () => {
      const lines: string[] = [];
      const h = batchHarness({ audit: new AuditLogger({ salt: 's', sink: (l) => lines.push(l) }) });
      await h.say('סגור תריסים');
      h.nowRef.t += 20_001; // expired, but tick() has not run
      const late = h.nowRef.t + 1;
      await h.say('כבה הכל');
      expect(lines.map((l) => JSON.parse(l) as AuditEvent).some((e) => e.reasonCode === 'superseded')).toBe(false);
      await h.say('כן', 'u1', late); // no supersede → the timestamp guard does not apply
      expect(h.toggleCalls).toHaveLength(3);
    });

    it('הדלק הכל with nothing to turn on is refused without using the 60s window', async () => {
      const cfg = loadConfig({
        aliasPath: resolve(here, '__fixtures__/switches-only.yaml'),
        env: testConfigEnv,
      });
      const nowRef = { t: 1_000_000 };
      const sends: string[] = [];
      const bridge = new Bridge({
        config: cfg,
        now: () => nowRef.t,
        haRest: {
          ...noPositionPort,
          callCover: vi.fn(async () => ({ ok: true }) as const),
          callToggle: vi.fn(async () => ({ ok: true }) as const),
        },
        signal: { send: vi.fn(async (_u: string, _n: string, m: string) => { sends.push(m); return true; }) },
        clock: { snapshot: () => ({ skewSampleMs: 0, lastGoodCheckAt: nowRef.t, allReferencesUnreachable: false }) },
      });
      bridge.onWsConnected();
      nowRef.t += 11_000;
      await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'הדלק הכל' });
      expect(sends.at(-1)).toBe('אין אורות או מתגים להדלקה');
      nowRef.t += 1;
      await bridge.handleEnvelope({ sourceUuid: 'u1', sourceNumber: '+1', timestamp: nowRef.t, message: 'כבה הכל' });
      expect(sends.at(-1)).toBe('לכבות את כל 1 האורות והמתגים? כן/לא');
    });

    it('a sender refused by the global window is free again once it passes', async () => {
      const h = batchHarness();
      await h.say('כבה הכל'); // u1 at t
      h.nowRef.t += 59_000;
      await h.say('כבה הכל', 'u2'); // refused globally
      expect(h.sends.at(-1)).toBe('יותר מדי פקודות, נסה עוד רגע');
      h.nowRef.t += 1_001; // 60s after u1's
      await h.say('כבה הכל', 'u2');
      expect(h.sends.at(-1)).toContain('כן/לא');
    });

    it('without a supersede, the timestamp check does not apply', async () => {
      const h = batchHarness();
      await h.say('כבה הכל');
      await h.say('כן');
      expect(h.toggleCalls).toHaveLength(3);
    });
  });

  it('audit: one summary event plus one per failed/timed-out device, no names', async () => {
    const lines: string[] = [];
    const audit = new AuditLogger({ salt: 's', sink: (l) => lines.push(l) });
    const h = batchHarness({ failCover: 'cover.kitchen', audit });
    await h.say('סגור תריסים');
    await h.say('כן');
    for (const id of ['cover.living_room', 'cover.kids_room']) await h.bridge.onStateChanged(id, 'closed');
    h.nowRef.t += 40_000;
    await h.bridge.tick();
    const events = lines.map((l) => JSON.parse(l) as AuditEvent).filter((e) => e.intent === 'completion');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'cover.kitchen', result: 'failed', reasonCode: 'entity-issue-failed' }),
        expect.objectContaining({ entity: 'cover.parents_room', result: 'timeout' }),
        expect.objectContaining({ result: 'timeout', reasonCode: 'summary' }),
      ]),
    );
    expect(events.filter((e) => e.reasonCode === 'summary')).toHaveLength(1);
    expect(events).toHaveLength(3);
    for (const l of lines) expect(l).not.toMatch(/מטבח|חדר הורים/);
  });
});
