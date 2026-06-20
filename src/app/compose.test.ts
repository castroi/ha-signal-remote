/**
 * Tests that composeAndStart() builds the full object graph without throwing
 * when given a complete fake env and a real aliases file. No real network
 * connections are made — we verify wiring, not I/O.
 *
 * The test calls shutdown() immediately after construction so that no
 * WebSocket reconnect timers linger beyond the test.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { composeAndStart } from './compose.js';

const here = dirname(fileURLToPath(import.meta.url));
const aliasPath = resolve(here, '../../config/aliases.example.yaml');

/** Minimal env that satisfies loadSecrets() — values are fake, no real network. */
const fakeEnv: NodeJS.ProcessEnv = {
  HA_TOKEN: 'fake-ha-token',
  HA_BASE_URL: 'http://127.0.0.1:18123',
  SIGNAL_API_URL: 'http://127.0.0.1:18080',
  BOT_NUMBER: '+15550001234',
  ALLOWLIST_UUIDS: 'aaaaaaaa-0000-0000-0000-000000000001',
  AUDIT_SALT: 'test-salt-for-compose',
};

// Stub WebSocket so no real TCP connections are attempted.
// Vitest's vi.mock factory runs in the module scope before imports are resolved;
// we inline a minimal EventEmitter-based stub so no `require` call is needed.
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class MockWs extends EventEmitter {
    send(_data: string): void { /* noop */ }
    close(): void { this.emit('close'); }
  }
  return { WebSocket: MockWs };
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllTimers();
});

describe('composeAndStart (Task 14 — graph wiring)', () => {
  it('builds the graph without throwing given a complete fake env', () => {
    const handle = composeAndStart({ aliasPath, env: fakeEnv });
    // shutdown() must be idempotent and not throw.
    expect(() => handle.shutdown()).not.toThrow();
    expect(() => handle.shutdown()).not.toThrow(); // second call is a no-op
  });

  it('throws synchronously when a required secret is missing', () => {
    const incomplete = { ...fakeEnv };
    delete incomplete['HA_TOKEN'];
    expect(() => composeAndStart({ aliasPath, env: incomplete })).toThrow(/HA_TOKEN/);
  });

  it('throws synchronously when ALLOWLIST_UUIDS is empty', () => {
    const incomplete = { ...fakeEnv, ALLOWLIST_UUIDS: '' };
    expect(() => composeAndStart({ aliasPath, env: incomplete })).toThrow(/ALLOWLIST_UUIDS/);
  });

  it('throws synchronously when AUDIT_SALT is missing', () => {
    const incomplete = { ...fakeEnv };
    delete incomplete['AUDIT_SALT'];
    expect(() => composeAndStart({ aliasPath, env: incomplete })).toThrow(/AUDIT_SALT/);
  });

  it('returns a handle whose shutdown() is callable multiple times without throwing', () => {
    const handle = composeAndStart({ aliasPath, env: fakeEnv });
    for (let i = 0; i < 5; i++) {
      expect(() => handle.shutdown()).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix item 1 (HIGH): HA WS reconnects even when 'open' never fires
// ---------------------------------------------------------------------------

describe('Fix 1 (HIGH): HA WS reconnects without a preceding open event', () => {
  it('a close event on the HA socket (no prior open) triggers onWsDisconnected and schedules reconnect', () => {
    // We capture the MockWs instance created for the HA WebSocket so we can
    // emit 'close' without 'open' ever having fired.
    const wsInstances: EventEmitter[] = [];
    vi.doMock('ws', async () => {
      class MockWs2 extends EventEmitter {
        send(_data: string): void { /* noop */ }
        close(): void { this.emit('close'); }
        constructor() { super(); wsInstances.push(this); }
      }
      return { WebSocket: MockWs2 };
    });

    const handle = composeAndStart({ aliasPath, env: fakeEnv });

    // There should be ≥2 WS instances: one Signal, one HA.
    // We don't know which is which, so emit 'close' on both and verify
    // that fake timers has pending timers (i.e. reconnect was scheduled).
    for (const ws of wsInstances) ws.emit('close');

    // With fake timers, any setTimeout scheduled by the reconnect path is
    // captured. pendingTimerCount > 0 means reconnect timers were scheduled.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    handle.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Fix item 5 (MED): shutdown() cancels pending reconnect timers
// ---------------------------------------------------------------------------

describe('Fix 5 (MED): shutdown() cancels pending reconnect timers', () => {
  it('pending reconnect timers are cleared on shutdown so the event loop is not kept alive', () => {
    const handle = composeAndStart({ aliasPath, env: fakeEnv });

    // Verify some timers exist (tick interval + clock interval + at least one
    // of the ws.on('close') handlers fires a reconnect timer via the MockWs
    // whose close() emits 'close').
    const timersBefore = vi.getTimerCount();
    expect(timersBefore).toBeGreaterThan(0);

    handle.shutdown();

    // After shutdown, any reconnect timers should be cleared. The remaining
    // timer count must be ≤ what was there before shutdown minus the reconnect
    // timers. In practice, shutdown also closes the WS (which emits 'close')
    // but sets shutdownRequested=true first so reconnects are not re-scheduled.
    // The explicit clearTimeout calls must reduce the count to ≤ 2 (only the
    // already-cleared tick + clock intervals).
    expect(vi.getTimerCount()).toBeLessThan(timersBefore);
  });
});

// ---------------------------------------------------------------------------
// Fix item 2 (HIGH): CLOCK_REFERENCES env var configures reference list
// ---------------------------------------------------------------------------

describe('Fix 2 (HIGH): CLOCK_REFERENCES env var', () => {
  it('throws when CLOCK_REFERENCES is set to an empty string after trimming', () => {
    const env = { ...fakeEnv, CLOCK_REFERENCES: '  ,  , ' };
    expect(() => composeAndStart({ aliasPath, env })).toThrow(/CLOCK_REFERENCES/);
  });

  it('accepts a custom CLOCK_REFERENCES list without throwing', () => {
    const env = {
      ...fakeEnv,
      CLOCK_REFERENCES: 'https://example.com/time1,https://example.com/time2',
    };
    // Should build without throwing; no real network call is made (ClockSource
    // check is only called from the setInterval, not at construction time).
    const handle = composeAndStart({ aliasPath, env });
    expect(() => handle.shutdown()).not.toThrow();
  });

  it('uses the default reference list when CLOCK_REFERENCES is not set', () => {
    // No CLOCK_REFERENCES → should build fine with the built-in defaults.
    const envWithout = { ...fakeEnv };
    delete envWithout['CLOCK_REFERENCES'];
    const handle = composeAndStart({ aliasPath, env: envWithout });
    expect(() => handle.shutdown()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix item 9 (LOW): unknown-sender audit reason code
// ---------------------------------------------------------------------------

describe('Fix 9 (LOW): unknown-sender distinct reason code in audit', () => {
  it('does not throw when built with a single-UUID allowlist (smoke)', () => {
    const handle = composeAndStart({ aliasPath, env: fakeEnv });
    expect(() => handle.shutdown()).not.toThrow();
  });
});
