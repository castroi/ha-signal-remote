import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SignalAdapter, type IncomingEnvelope, type SignalSocket } from './signal.js';

/** A fake JSON-RPC socket the adapter listens to. */
class FakeSocket extends EventEmitter implements SignalSocket {
  sent: unknown[] = [];
  emitMessage(raw: string): void {
    this.emit('message', raw);
  }
  onMessage(handler: (raw: string) => void): void {
    this.on('message', handler);
  }
}

const allowlist = new Set(['uuid-allowed']);

function makeAdapter(sendImpl?: typeof fetch) {
  const socket = new FakeSocket();
  const received: IncomingEnvelope[] = [];
  const adapter = new SignalAdapter({
    socket,
    botNumber: '+15550001111',
    apiUrl: 'http://localhost:8080',
    allowlist,
    fetchImpl: sendImpl ?? (vi.fn(async () => new Response('{}', { status: 201 })) as unknown as typeof fetch),
    onEnvelope: (e) => received.push(e),
  });
  return { socket, adapter, received };
}

// A bbernhard signal-cli JSON-RPC receive notification.
function notification(sourceUuid: string, ts: number, message: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      envelope: {
        sourceUuid,
        sourceNumber: '+15559998888',
        timestamp: ts,
        dataMessage: { timestamp: ts, message },
      },
    },
  });
}

describe('SignalAdapter (design §2, §6 A01)', () => {
  it('extracts sourceUuid + envelope timestamp for an allowed sender', () => {
    const { socket, received } = makeAdapter();
    socket.emitMessage(notification('uuid-allowed', 1700, 'סגור סלון'));
    expect(received).toHaveLength(1);
    expect(received[0]!.sourceUuid).toBe('uuid-allowed');
    expect(received[0]!.timestamp).toBe(1700);
    expect(received[0]!.message).toBe('סגור סלון');
  });

  it('drops messages from an unknown UUID silently (no envelope, no send)', () => {
    const sendSpy = vi.fn(async () => new Response('{}', { status: 201 })) as unknown as typeof fetch;
    const { socket, received } = makeAdapter(sendSpy);
    socket.emitMessage(notification('uuid-stranger', 1700, 'סגור סלון'));
    expect(received).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('pins identity on sourceUuid, not phone number (number may be empty)', () => {
    const { socket, received } = makeAdapter();
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: { sourceUuid: 'uuid-allowed', sourceNumber: null, timestamp: 99, dataMessage: { message: 'x' } },
      },
    });
    socket.emitMessage(raw);
    expect(received).toHaveLength(1);
    expect(received[0]!.sourceUuid).toBe('uuid-allowed');
  });

  it('ignores non-receive notifications and malformed frames', () => {
    const { socket, received } = makeAdapter();
    socket.emitMessage('not json');
    socket.emitMessage(JSON.stringify({ jsonrpc: '2.0', method: 'sync' }));
    socket.emitMessage(JSON.stringify({ jsonrpc: '2.0', method: 'receive', params: {} }));
    expect(received).toHaveLength(0);
  });

  it('sends a reply over the REST endpoint to an allowed recipient', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const sendImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    const { adapter } = makeAdapter(sendImpl);
    await adapter.send('uuid-allowed', '+15559998888', 'מבצע…');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://localhost:8080/v2/send');
    expect((calls[0]!.body as { message: string }).message).toBe('מבצע…');
  });

  it('a failed send is swallowed (logged + dropped), never throws', async () => {
    const sendImpl = vi.fn(async () => {
      throw new Error('signal down');
    }) as unknown as typeof fetch;
    const { adapter } = makeAdapter(sendImpl);
    await expect(adapter.send('uuid-allowed', '+1', 'x')).resolves.toBe(false);
  });
});
