#!/usr/bin/env node
/**
 * Mock signal-cli-rest-api for DEV testing of the home-control bridge.
 *
 * Speaks the subset of the bbernhard JSON-RPC API the bridge actually uses
 * (see src/adapters/signal.ts and src/app/compose.ts):
 *
 *   WS  GET  /v1/receive/:number   → pushes {"method":"receive","params":{envelope}}
 *   POST     /v2/send              → bot replies land here (200), kept for inspection
 *   GET      /v1/health            → 204 (mirrors bbernhard)
 *
 * Plus DEV-only control endpoints so you can drive test scenarios by hand:
 *
 *   POST /inject   body: { sourceUuid, message, timestamp?, sourceNumber?, count? }
 *                  Pushes a `receive` frame to all connected WS clients.
 *                  - timestamp: absolute epoch ms (default: now). Use an old value
 *                    to test the freshness gate, a future value for the
 *                    future-timestamp guard, a repeated value for dedup.
 *                  - count: send the SAME frame N times (duplicate delivery, gate 6).
 *   GET  /sent     → JSON array of every reply the bridge has sent (newest last).
 *   POST /reset    → clears the /sent buffer.
 *
 * This is NOT real Signal: there is no encryption, no server, no account. It
 * exists only to exercise the bridge's logic for the 8 go-live gates that don't
 * require the real bbernhard transport. Gate 1 (replay-timestamp behaviour) must
 * still be run against real signal-cli on the deployment network.
 *
 * No dependency beyond `ws` (already a bridge dependency).
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);

/** Connected receive sockets, keyed by the number in the path. */
const clients = new Set();
/** Every reply the bridge POSTed to /v2/send, for inspection. */
const sent = [];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const payload = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function broadcastReceive({ sourceUuid, message, timestamp, sourceNumber }) {
  const frame = JSON.stringify({
    method: 'receive',
    params: {
      envelope: {
        sourceUuid,
        sourceNumber: sourceNumber ?? null,
        timestamp,
        dataMessage: { timestamp, message },
      },
    },
  });
  let delivered = 0;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(frame);
      delivered++;
    }
  }
  return delivered;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/v1/health') {
    return send(res, 204);
  }

  // DEV clock reference: returns THIS container's clock as {unixtime} (seconds),
  // matching the worldtimeapi shape the bridge's clock-health check expects.
  // Point CLOCK_REFERENCES at this so dev skew is ~0 instead of comparing the
  // environment's (possibly fake) system date against real-world time servers.
  if (req.method === 'GET' && url.pathname === '/time') {
    return send(res, 200, { unixtime: Math.floor(Date.now() / 1000) });
  }

  // Bot replies land here.
  if (req.method === 'POST' && url.pathname === '/v2/send') {
    try {
      const body = await readJson(req);
      const entry = { at: new Date().toISOString(), ...body };
      sent.push(entry);
      log('REPLY →', JSON.stringify(body.recipients), JSON.stringify(body.message));
      return send(res, 201, { timestamp: String(Date.now()) });
    } catch {
      return send(res, 400, { error: 'bad json' });
    }
  }

  // DEV: inject an inbound message.
  if (req.method === 'POST' && url.pathname === '/inject') {
    try {
      const body = await readJson(req);
      if (!body.sourceUuid || typeof body.message !== 'string') {
        return send(res, 400, { error: 'sourceUuid and message are required' });
      }
      const timestamp = Number(body.timestamp ?? Date.now());
      const count = Math.max(1, Number(body.count ?? 1));
      let delivered = 0;
      for (let i = 0; i < count; i++) {
        delivered += broadcastReceive({
          sourceUuid: body.sourceUuid,
          message: body.message,
          timestamp,
          sourceNumber: body.sourceNumber,
        });
      }
      log('INJECT ←', body.sourceUuid, JSON.stringify(body.message), `ts=${timestamp} x${count} → ${delivered} client(s)`);
      return send(res, 200, { delivered, timestamp, count });
    } catch {
      return send(res, 400, { error: 'bad json' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/sent') {
    return send(res, 200, sent);
  }

  if (req.method === 'POST' && url.pathname === '/reset') {
    sent.length = 0;
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
});

// WebSocket receive stream: the bridge connects to /v1/receive/<number>.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  if (!pathname.startsWith('/v1/receive/')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    log('WS connected:', pathname, `(${clients.size} client(s))`);
    ws.on('close', () => {
      clients.delete(ws);
      log('WS disconnected', `(${clients.size} client(s))`);
    });
    ws.on('error', () => clients.delete(ws));
  });
});

server.listen(PORT, () => {
  log(`mock-signal-cli listening on :${PORT}`);
  log('  WS receive : /v1/receive/<number>');
  log('  send sink  : POST /v2/send   (inspect: GET /sent)');
  log('  inject     : POST /inject {sourceUuid,message,timestamp?,count?}');
});
