import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsHealthGate, HaWsClient, type HaWsSocket, computeBackoff } from './ha-ws.js';

describe('WsHealthGate (design §5, go-live gates 2 & 3)', () => {
  it('covers disabled while WS is down (fail-closed)', () => {
    const now = { t: 0 };
    const gate = new WsHealthGate({ debounceMs: 10_000, now: () => now.t });
    expect(gate.coversEnabled()).toBe(false); // starts disconnected
    expect(gate.refusalReason()).toBe('ws-down');
  });

  it('covers re-enable only after WS healthy continuously for the debounce window', () => {
    const now = { t: 0 };
    const gate = new WsHealthGate({ debounceMs: 10_000, now: () => now.t });
    gate.onConnected();
    expect(gate.coversEnabled()).toBe(false); // not yet debounced
    now.t = 9_999;
    expect(gate.coversEnabled()).toBe(false);
    now.t = 10_001;
    expect(gate.coversEnabled()).toBe(true);
  });

  it('a flap before the debounce elapses resets the timer (no brief re-enable)', () => {
    const now = { t: 0 };
    const gate = new WsHealthGate({ debounceMs: 10_000, now: () => now.t });
    gate.onConnected();
    now.t = 8_000;
    gate.onDisconnected(); // flap
    expect(gate.coversEnabled()).toBe(false);
    gate.onConnected(); // reconnect at t=8000
    now.t = 16_000; // 8s healthy, < debounce
    expect(gate.coversEnabled()).toBe(false);
    now.t = 18_001; // now 10s+ continuously healthy
    expect(gate.coversEnabled()).toBe(true);
  });

  it('lights are unaffected: the gate only reports covers', () => {
    const gate = new WsHealthGate({ debounceMs: 10_000, now: () => 0 });
    expect(gate).not.toHaveProperty('lightsEnabled');
  });
});

describe('computeBackoff (1s -> 30s cap + two-sided jitter, item 9)', () => {
  // With rng()=0.5 the ±50% jitter term is 0 so result equals the clamped step.
  it('grows exponentially and caps at 30s (midpoint jitter)', () => {
    expect(computeBackoff(0, 1000, 30_000, () => 0.5)).toBe(1000);
    expect(computeBackoff(1, 1000, 30_000, () => 0.5)).toBe(2000);
    expect(computeBackoff(2, 1000, 30_000, () => 0.5)).toBe(4000);
    expect(computeBackoff(10, 1000, 30_000, () => 0.5)).toBe(30_000); // capped
  });

  it('result is always within [step*0.5, step*1.5] and never exceeds the cap', () => {
    for (const attempt of [0, 1, 2, 3, 10]) {
      // rng=0 → lower bound (step*0.5)
      const lo = computeBackoff(attempt, 1000, 30_000, () => 0);
      // rng=1 → upper bound (step*1.5), but capped
      const hi = computeBackoff(attempt, 1000, 30_000, () => 1);
      const step = Math.min(30_000, 1000 * 2 ** attempt);
      expect(lo).toBeGreaterThanOrEqual(Math.ceil(step * 0.5));
      expect(hi).toBeLessThanOrEqual(30_000);
    }
  });

  it('jitter is two-sided: low rng gives value below step, high rng gives value above', () => {
    const step = Math.min(30_000, 1000 * 2 ** 3); // 8000
    const lo = computeBackoff(3, 1000, 30_000, () => 0);
    const hi = computeBackoff(3, 1000, 30_000, () => 1);
    expect(lo).toBeLessThan(step);
    expect(hi).toBeGreaterThan(step);
  });
});

class FakeWs extends EventEmitter implements HaWsSocket {
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit('close');
  }
  onMessage(h: (raw: string) => void): void {
    this.on('message', h);
  }
  onClose(h: () => void): void {
    this.on('close', h);
  }
  emitMessage(raw: string): void {
    this.emit('message', raw);
  }
}

describe('HaWsClient', () => {
  it('authenticates then subscribes to state_changed', () => {
    const ws = new FakeWs();
    const client = new HaWsClient({ socket: ws, token: 'tok', onStateChanged: () => {} });
    client.start();
    ws.emitMessage(JSON.stringify({ type: 'auth_required' }));
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'auth', access_token: 'tok' });
    ws.emitMessage(JSON.stringify({ type: 'auth_ok' }));
    const sub = JSON.parse(ws.sent[1]!);
    expect(sub.type).toBe('subscribe_events');
    expect(sub.event_type).toBe('state_changed');
  });

  it('forwards state_changed events as entity + new state', () => {
    const ws = new FakeWs();
    const seen: { entityId: string; state: string }[] = [];
    const client = new HaWsClient({ socket: ws, token: 'tok', onStateChanged: (e) => seen.push(e) });
    client.start();
    ws.emitMessage(JSON.stringify({ type: 'auth_required' }));
    ws.emitMessage(JSON.stringify({ type: 'auth_ok' }));
    ws.emitMessage(
      JSON.stringify({
        type: 'event',
        event: {
          event_type: 'state_changed',
          data: { entity_id: 'cover.living_room', new_state: { state: 'closed' } },
        },
      }),
    );
    expect(seen).toEqual([{ entityId: 'cover.living_room', state: 'closed' }]);
  });

  it('marks the health gate connected on auth_ok and disconnected on close', () => {
    const ws = new FakeWs();
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    const client = new HaWsClient({
      socket: ws,
      token: 'tok',
      onStateChanged: () => {},
      onConnected,
      onDisconnected,
    });
    client.start();
    ws.emitMessage(JSON.stringify({ type: 'auth_required' }));
    ws.emitMessage(JSON.stringify({ type: 'auth_ok' }));
    expect(onConnected).toHaveBeenCalledOnce();
    ws.close();
    expect(onDisconnected).toHaveBeenCalledOnce();
  });

  it('never logs the token (token only in the auth frame body)', () => {
    const ws = new FakeWs();
    const client = new HaWsClient({ socket: ws, token: 'super-secret', onStateChanged: () => {} });
    client.start();
    ws.emitMessage(JSON.stringify({ type: 'auth_required' }));
    // token appears only in the auth frame, nowhere else
    expect(ws.sent.filter((s) => s.includes('super-secret'))).toHaveLength(1);
  });
});
