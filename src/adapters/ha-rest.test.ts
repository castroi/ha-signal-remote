import { describe, it, expect, vi } from 'vitest';
import { HaRestClient } from './ha-rest.js';

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

const baseOpts = {
  baseUrl: 'http://localhost:8123',
  token: 'secret-llat',
};

describe('HaRestClient (design §7, §6 A02/A03)', () => {
  it('calls cover.close_cover with the correct path and payload', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = mockFetch((url, init) => {
      captured = { url, init };
      return new Response('[]', { status: 200 });
    });
    const client = new HaRestClient({ ...baseOpts, fetchImpl });

    const r = await client.callCover('cover.living_room', 'close');
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe('http://localhost:8123/api/services/cover/close_cover');
    expect(JSON.parse(captured?.init.body as string)).toEqual({
      entity_id: 'cover.living_room',
    });
  });

  it('maps each cover verb to the right service', async () => {
    const calls: string[] = [];
    const fetchImpl = mockFetch((url) => {
      calls.push(url);
      return new Response('[]', { status: 200 });
    });
    const client = new HaRestClient({ ...baseOpts, fetchImpl });
    await client.callCover('cover.x', 'open');
    await client.callCover('cover.x', 'close');
    await client.callCover('cover.x', 'stop');
    expect(calls).toEqual([
      'http://localhost:8123/api/services/cover/open_cover',
      'http://localhost:8123/api/services/cover/close_cover',
      'http://localhost:8123/api/services/cover/stop_cover',
    ]);
  });

  it('maps light verbs to turn_on / turn_off', async () => {
    const calls: string[] = [];
    const fetchImpl = mockFetch((url) => {
      calls.push(url);
      return new Response('[]', { status: 200 });
    });
    const client = new HaRestClient({ ...baseOpts, fetchImpl });
    await client.callLight('light.garden', 'on');
    await client.callLight('light.garden', 'off');
    expect(calls).toEqual([
      'http://localhost:8123/api/services/light/turn_on',
      'http://localhost:8123/api/services/light/turn_off',
    ]);
  });

  it('sends the bearer token in the Authorization header', async () => {
    let auth: string | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      auth = new Headers(init.headers).get('authorization') ?? undefined;
      return new Response('[]', { status: 200 });
    });
    const client = new HaRestClient({ ...baseOpts, fetchImpl });
    await client.callCover('cover.x', 'open');
    expect(auth).toBe('Bearer secret-llat');
  });

  it('maps a non-2xx response to failed (no false ack)', async () => {
    const fetchImpl = mockFetch(() => new Response('nope', { status: 500 }));
    const client = new HaRestClient({ ...baseOpts, fetchImpl });
    const r = await client.callCover('cover.x', 'open');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('failed');
  });

  it('maps a network error to failed', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const client = new HaRestClient({ ...baseOpts, fetchImpl });
    const r = await client.callCover('cover.x', 'open');
    expect(r.ok).toBe(false);
  });

  it('never includes the token in a thrown/returned error message', async () => {
    const fetchImpl = mockFetch(() => new Response('boom', { status: 503 }));
    const client = new HaRestClient({ ...baseOpts, fetchImpl });
    const r = await client.callCover('cover.x', 'open');
    expect(JSON.stringify(r)).not.toContain('secret-llat');
  });

  describe('getCoverPosition', () => {
    it('reads attributes.current_position from the state endpoint', async () => {
      let captured: { url: string; init: RequestInit } | undefined;
      const fetchImpl = mockFetch((url, init) => {
        captured = { url, init };
        return new Response(
          JSON.stringify({ state: 'open', attributes: { current_position: 42 } }),
          { status: 200 },
        );
      });
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      const pos = await client.getCoverPosition('cover.living_room');
      expect(pos).toBe(42);
      expect(captured?.url).toBe('http://localhost:8123/api/states/cover.living_room');
      expect((captured?.init.method ?? 'GET')).toBe('GET');
    });

    it('returns undefined when the cover reports no current_position', async () => {
      const fetchImpl = mockFetch(
        () => new Response(JSON.stringify({ state: 'open', attributes: {} }), { status: 200 }),
      );
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      expect(await client.getCoverPosition('cover.x')).toBeUndefined();
    });

    it('returns undefined on a non-2xx response', async () => {
      const fetchImpl = mockFetch(() => new Response('nope', { status: 404 }));
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      expect(await client.getCoverPosition('cover.x')).toBeUndefined();
    });
  });

  describe('callPositionScript', () => {
    it('posts script.turn_on with the entity list + position nested under variables', async () => {
      let captured: { url: string; init: RequestInit } | undefined;
      const fetchImpl = mockFetch((url, init) => {
        captured = { url, init };
        return new Response('[]', { status: 200 });
      });
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      const r = await client.callPositionScript(
        'script.covers_down',
        ['cover.living_room', 'cover.kitchen'],
        30,
      );
      expect(r.ok).toBe(true);
      expect(captured?.url).toBe('http://localhost:8123/api/services/script/turn_on');
      expect(JSON.parse(captured?.init.body as string)).toEqual({
        entity_id: 'script.covers_down',
        variables: { entity_id: ['cover.living_room', 'cover.kitchen'], position: 30 },
      });
    });

    it('maps a non-2xx response to failed', async () => {
      const fetchImpl = mockFetch(() => new Response('nope', { status: 500 }));
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      const r = await client.callPositionScript('script.covers_up', ['cover.x'], 90);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('failed');
    });

    it('never leaks the token in the returned error', async () => {
      const fetchImpl = mockFetch(() => new Response('boom', { status: 503 }));
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      const r = await client.callPositionScript('script.covers_up', ['cover.x'], 90);
      expect(JSON.stringify(r)).not.toContain('secret-llat');
    });
  });
});
