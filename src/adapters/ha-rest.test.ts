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

  it('maps toggle verbs to turn_on / turn_off in the given domain (issue #25)', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = mockFetch((url, init) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response('[]', { status: 200 });
    });
    const client = new HaRestClient({ ...baseOpts, fetchImpl });
    await client.callToggle('light', 'light.garden', 'on');
    await client.callToggle('light', 'light.garden', 'off');
    await client.callToggle('switch', 'switch.fan', 'on');
    await client.callToggle('switch', 'switch.fan', 'off');
    expect(calls.map((c) => c.url)).toEqual([
      'http://localhost:8123/api/services/light/turn_on',
      'http://localhost:8123/api/services/light/turn_off',
      'http://localhost:8123/api/services/switch/turn_on',
      'http://localhost:8123/api/services/switch/turn_off',
    ]);
    expect(calls[2]?.body).toEqual({ entity_id: 'switch.fan' });
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

  describe('getStates', () => {
    const stateBody = (state: unknown, attributes: Record<string, unknown> = {}) =>
      new Response(JSON.stringify({ state, attributes }), { status: 200 });

    it('GETs each id from the state endpoint with the bearer token', async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      const fetchImpl = mockFetch((url, init) => {
        calls.push({ url, init });
        return stateBody('on');
      });
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      await client.getStates(['light.a', 'switch.b']);
      expect(calls.map((c) => c.url).sort()).toEqual([
        'http://localhost:8123/api/states/light.a',
        'http://localhost:8123/api/states/switch.b',
      ]);
      for (const c of calls) {
        expect(c.init.method ?? 'GET').toBe('GET');
        expect((c.init.headers as Record<string, string>).authorization).toBe(
          'Bearer secret-llat',
        );
      }
    });

    it('returns state and an integer 0–100 position keyed by id', async () => {
      const fetchImpl = mockFetch((url) =>
        url.endsWith('cover.g') ? stateBody('open', { current_position: 20 }) : stateBody('off'),
      );
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      const states = await client.getStates(['cover.g', 'switch.fan']);
      expect(states?.get('cover.g')).toEqual({ state: 'open', position: 20 });
      expect(states?.get('switch.fan')).toEqual({ state: 'off' });
    });

    it.each([150, -1, 20.5, Number.NaN, '20', null])(
      'omits an invalid position (%s)',
      async (pos) => {
        const fetchImpl = mockFetch(() => stateBody('open', { current_position: pos }));
        const client = new HaRestClient({ ...baseOpts, fetchImpl });
        const states = await client.getStates(['cover.g']);
        expect(states?.get('cover.g')).toEqual({ state: 'open' });
      },
    );

    it('drops an entry whose state is not a string', async () => {
      const fetchImpl = mockFetch((url) => (url.endsWith('a') ? stateBody(1) : stateBody('on')));
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      const states = await client.getStates(['light.a', 'light.b']);
      expect(states?.has('light.a')).toBe(false);
      expect(states?.get('light.b')).toEqual({ state: 'on' });
    });

    it('omits only the ids that fail (non-2xx, throw, non-JSON)', async () => {
      const fetchImpl = mockFetch((url) => {
        if (url.endsWith('bad404')) return new Response('nope', { status: 404 });
        if (url.endsWith('badthrow')) throw new Error('ECONNREFUSED');
        if (url.endsWith('badjson')) return new Response('<html>', { status: 200 });
        return stateBody('on');
      });
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      const states = await client.getStates([
        'light.bad404',
        'light.badthrow',
        'light.badjson',
        'light.ok',
      ]);
      expect([...(states?.keys() ?? [])]).toEqual(['light.ok']);
    });

    it('returns undefined when every read fails', async () => {
      const fetchImpl = mockFetch(() => new Response('nope', { status: 500 }));
      const client = new HaRestClient({ ...baseOpts, fetchImpl });
      expect(await client.getStates(['light.a', 'switch.b'])).toBeUndefined();
    });

    it('aborts a read after 3s even though service calls allow 10s', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = mockFetch(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        );
        const client = new HaRestClient({ ...baseOpts, fetchImpl });
        let settled = false;
        const p = client.getStates(['light.a']).then((r) => {
          settled = true;
          return r;
        });
        await vi.advanceTimersByTimeAsync(2_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await p).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
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
