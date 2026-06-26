/**
 * Composition root for the home-control bridge (design §3, §5, §6; Task 14).
 *
 * Builds the real runtime object graph from config + secrets and starts all
 * I/O loops. Returns a shutdown handle so the process signal handler can
 * stop everything cleanly.
 *
 * Design constraints observed here:
 * - All secrets come from env; nothing hardcoded.
 * - logDrop logs presence only — never UUID, never message body (§6 A01).
 * - ClockSource result is folded into a mutable snapshot that the ClockStatePort
 *   reads; the snapshot starts at { skewSampleMs: 0, lastGoodCheckAt: now,
 *   allReferencesUnreachable: false } so the first real check updates it within
 *   60 s and the bridge operates normally in the interim (§5 offline grace).
 * - HA WS reconnect uses computeBackoff (1 s → 30 s + jitter) and re-enables
 *   the bridge gate via bridge.onWsConnected() / onWsDisconnected().
 * - Signal WS reconnect mirrors the same pattern.
 * - tick() is called every second so per-entity completion timeouts and dedup
 *   sweeps fire at normal resolution.
 * - init: true in the compose file ensures SIGTERM is delivered quickly.
 */

import { WebSocket } from 'ws';
import { loadConfig, loadSecrets, type Config } from './config.js';
import { Bridge, type ClockStatePort } from './bridge.js';
import { AuditLogger } from '../core/audit.js';
import { ClockSource } from '../adapters/clock-source.js';
import { HaRestClient } from '../adapters/ha-rest.js';
import { HaWsClient, computeBackoff, type HaWsSocket } from '../adapters/ha-ws.js';
import { SignalAdapter, type SignalSocket } from '../adapters/signal.js';

/** What composeAndStart returns — call shutdown() on SIGTERM/SIGINT. */
export interface RuntimeHandle {
  shutdown(): void;
}

/** Options for composeAndStart; separated so tests can supply a fake alias path. */
export interface ComposeOptions {
  readonly aliasPath: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the real object graph and start all I/O loops.
 *
 * Throws synchronously if any required secret is missing (loadSecrets throws a
 * clear `Error` naming the missing key); the caller should catch, log, and
 * exit non-zero.
 */
export function composeAndStart(opts: ComposeOptions): RuntimeHandle {
  const cfg: Config = loadConfig({ aliasPath: opts.aliasPath, env: opts.env ?? process.env });

  // ── Audit logger (§6) ──────────────────────────────────────────────────────
  const audit = new AuditLogger({ salt: cfg.secrets.auditSalt });

  // ── Clock source + mutable snapshot (§5 clock-health precondition) ─────────
  //
  // §5 requires an ordered list of clock references (primary + fallbacks) in
  // config, not hard-coded. CLOCK_REFERENCES is a comma-separated list of URLs
  // (env-driven). Each URL must serve a JSON body with a numeric `unixtime`
  // field (seconds since epoch). The default list uses worldtimeapi.org as the
  // primary with a fallback to timeapi.io.
  //
  // "Unreachable" means ALL configured references failed within the check
  // timeout. If ANY reference answers, its skew sample is used.
  //
  // Samples where the reference year is below 2024 are rejected as malformed
  // (a numeric-but-wrong body cannot silently set skew).
  //
  // The snapshot starts "healthy" so the bridge operates during the first 60-s
  // check cycle; if the clock is actually bad the first real check (within 60 s)
  // will set allReferencesUnreachable or a high skew and covers will be blocked.
  const clockSnapshot: {
    skewSampleMs: number;
    lastGoodCheckAt: number;
    allReferencesUnreachable: boolean;
  } = {
    skewSampleMs: 0,
    lastGoodCheckAt: Date.now(),
    allReferencesUnreachable: false,
  };

  // Default list documented here; operators override via CLOCK_REFERENCES env var.
  const DEFAULT_CLOCK_REFERENCES = [
    'https://worldtimeapi.org/api/ip',
    'https://timeapi.io/api/time/current/zone?timeZone=UTC',
  ].join(',');

  const MIN_VALID_YEAR_EPOCH_MS = new Date('2024-01-01T00:00:00Z').getTime();

  const clockReferenceUrls = (
    (opts.env ?? process.env)['CLOCK_REFERENCES'] ?? DEFAULT_CLOCK_REFERENCES
  )
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (clockReferenceUrls.length === 0) {
    throw new Error('CLOCK_REFERENCES must contain at least one URL');
  }

  const clockSource = new ClockSource({
    references: clockReferenceUrls.map((url) => async (signal: AbortSignal) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`clock ref HTTP ${res.status}`);
      const body = (await res.json()) as { unixtime?: number; [k: string]: unknown };
      if (typeof body.unixtime !== 'number') throw new Error('clock ref bad body: missing unixtime');
      const epochMs = body.unixtime * 1000;
      // Reject obviously-bad samples (year < 2024) so a malformed-but-numeric
      // body cannot silently set skew to an arbitrary value (fix item 2).
      if (epochMs < MIN_VALID_YEAR_EPOCH_MS) {
        throw new Error(`clock ref bad sample: year before 2024 (${new Date(epochMs).getUTCFullYear()})`);
      }
      return epochMs;
    }),
    checkTimeoutMs: 5_000,
  });

  const clockPort: ClockStatePort = { snapshot: () => ({ ...clockSnapshot }) };

  // ── HA REST client ─────────────────────────────────────────────────────────
  const haRest = new HaRestClient({
    baseUrl: cfg.secrets.haBaseUrl,
    token: cfg.secrets.haToken,
  });

  // ── Bridge (composition root for all pure logic) ───────────────────────────
  const bridge = new Bridge({
    config: cfg,
    haRest,
    signal: {
      // SignalAdapter.send is wired below after the adapter is constructed.
      // We use a late-binding wrapper so bridge and adapter can each hold a
      // reference to the other without a circular constructor dependency.
      send: async (sourceUuid, recipient, message) =>
        signalAdapter.send(sourceUuid, recipient, message),
    },
    clock: clockPort,
    audit,
    emitNotice: (text) => {
      console.log(`[bridge] ${text}`);
    },
  });

  // ── Signal adapter + WS with reconnect ────────────────────────────────────
  let signalWs: WebSocket | null = null;
  let signalAttempt = 0;
  let shutdownRequested = false;
  // Track pending reconnect timers so shutdown() can cancel them (fix item 5).
  let signalReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let haReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // The SignalSocket wrapper is rebuilt each time we reconnect; we keep a
  // stable reference to the adapter (which calls logDrop) but replace the
  // socket on each reconnect.
  let signalAdapter!: SignalAdapter;

  function connectSignal(): void {
    if (shutdownRequested) return;

    const wsUrl = `${cfg.secrets.signalApiUrl.replace(/^http/, 'ws')}/v1/receive/${encodeURIComponent(cfg.secrets.botNumber)}`;
    const ws = new WebSocket(wsUrl);
    signalWs = ws;

    const socket: SignalSocket = {
      onMessage: (handler) => {
        ws.on('message', (data) => handler(data.toString()));
      },
    };

    signalAdapter = new SignalAdapter({
      socket,
      botNumber: cfg.secrets.botNumber,
      apiUrl: cfg.secrets.signalApiUrl,
      allowlist: cfg.secrets.allowlistUuids,
      onEnvelope: (envelope) => {
        // Fire-and-forget; errors in handleEnvelope are swallowed by the bridge.
        bridge.handleEnvelope(envelope).catch((err: unknown) => {
          console.error('[bridge] handleEnvelope error:', err);
        });
      },
      // logDrop: logs that a message was dropped from an unknown sender — no UUID,
      // no body (§6 A01). uuidPresent indicates the frame had a sourceUuid field
      // (i.e. a real Signal user); false means the frame was structurally invalid.
      logDrop: (uuidPresent) => {
        audit.log({
          ts: Date.now(),
          sourceUuid: '',
          intent: 'unknown-sender',
          entity: undefined,
          result: 'rejected',
          latencyMs: undefined,
          // Fix item 9: distinct reason codes so audit lines are unambiguous.
          reasonCode: uuidPresent ? 'unknown-sender' : 'no-verb',
        });
      },
    });

    ws.on('open', () => {
      console.log('[signal] connected');
      signalAttempt = 0;
    });

    ws.on('error', (err) => {
      console.error('[signal] ws error:', (err as Error).message);
    });

    ws.on('close', () => {
      if (shutdownRequested) return;
      const delay = computeBackoff(
        signalAttempt++,
        cfg.tunables.reconnectBackoffMinMs,
        cfg.tunables.reconnectBackoffMaxMs,
      );
      console.log(`[signal] disconnected; reconnecting in ${delay} ms`);
      // Fix item 5: track the timer handle so shutdown() can cancel it.
      signalReconnectTimer = setTimeout(connectSignal, delay);
    });
  }

  // ── HA WebSocket adapter + reconnect ──────────────────────────────────────
  let haWs: WebSocket | null = null;
  let haWsAttempt = 0;

  function connectHaWs(): void {
    if (shutdownRequested) return;

    const wsUrl = `${cfg.secrets.haBaseUrl.replace(/^http/, 'ws')}/api/websocket`;
    const ws = new WebSocket(wsUrl);
    haWs = ws;

    const socket: HaWsSocket = {
      // Fix item 7: wrap send in try/catch so a synchronous throw from the ws
      // message listener cannot crash the process.
      send: (data) => {
        try {
          ws.send(data);
        } catch (err) {
          console.error('[ha-ws] socket send error:', (err as Error).message);
        }
      },
      onMessage: (handler) => {
        ws.on('message', (data) => handler(data.toString()));
      },
      onClose: (handler) => {
        ws.on('close', handler);
      },
    };

    // Fix item 1 (HIGH): schedule reconnect on 'close' unconditionally, BEFORE
    // client.start() is called inside 'open'. This ensures that if the initial
    // TCP connection fails (error → close fires with no 'open'), the reconnect
    // backoff is still scheduled and covers are never permanently disabled.
    ws.on('close', () => {
      bridge.onWsDisconnected();
      if (shutdownRequested) return;
      const delay = computeBackoff(
        haWsAttempt++,
        cfg.tunables.reconnectBackoffMinMs,
        cfg.tunables.reconnectBackoffMaxMs,
      );
      console.log(`[ha-ws] disconnected; reconnecting in ${delay} ms`);
      // Fix item 5: track the timer handle so shutdown() can cancel it.
      haReconnectTimer = setTimeout(connectHaWs, delay);
    });

    const client = new HaWsClient({
      socket,
      token: cfg.secrets.haToken,
      onStateChanged: (change) => {
        bridge.onStateChanged(change.entityId, change.state, change.position).catch((err: unknown) => {
          console.error('[bridge] onStateChanged error:', err);
        });
      },
      onConnected: () => {
        console.log('[ha-ws] connected and subscribed');
        haWsAttempt = 0;
        bridge.onWsConnected();
      },
      // onDisconnected is now handled by the unconditional ws.on('close') above,
      // so we omit it here to avoid calling bridge.onWsDisconnected() twice.
    });

    ws.on('open', () => {
      client.start();
    });

    ws.on('error', (err) => {
      console.error('[ha-ws] ws error:', (err as Error).message);
      // 'close' will fire after 'error', triggering reconnect via ws.on('close').
    });
  }

  // ── Periodic tick (timeouts, dedup sweeps) ────────────────────────────────
  const tickInterval = setInterval(() => {
    bridge.tick().catch((err: unknown) => {
      console.error('[bridge] tick error:', err);
    });
  }, 1_000);

  // ── Periodic clock check (every 60 s) ─────────────────────────────────────
  const clockInterval = setInterval(() => {
    clockSource.check().then((result) => {
      if (!result.allReferencesUnreachable) {
        clockSnapshot.skewSampleMs = result.skewSampleMs ?? clockSnapshot.skewSampleMs;
        clockSnapshot.lastGoodCheckAt = result.checkedAt;
        clockSnapshot.allReferencesUnreachable = false;
      } else {
        clockSnapshot.allReferencesUnreachable = true;
        console.warn('[clock] all references unreachable; last good:', new Date(clockSnapshot.lastGoodCheckAt).toISOString());
      }
    }).catch((err: unknown) => {
      console.error('[clock] check error:', err);
    });
  }, 60_000);

  // ── Start I/O ─────────────────────────────────────────────────────────────
  connectSignal();
  connectHaWs();

  // ── Shutdown handle ────────────────────────────────────────────────────────
  return {
    shutdown(): void {
      if (shutdownRequested) return;
      shutdownRequested = true;
      console.log('[bridge] shutting down…');

      clearInterval(tickInterval);
      clearInterval(clockInterval);

      // Fix item 5: cancel any pending reconnect timers so they cannot outlive
      // shutdown or keep the event loop alive.
      if (signalReconnectTimer !== null) clearTimeout(signalReconnectTimer);
      if (haReconnectTimer !== null) clearTimeout(haReconnectTimer);

      // Engage kill switch to block new commands and attempt stop on in-flight covers.
      bridge.engageKill();

      // Close WS connections gracefully.
      if (signalWs) {
        try { signalWs.close(); } catch { /* ignore */ }
      }
      if (haWs) {
        try { haWs.close(); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * Load secrets from env only (no alias file required).
 * Exported so callers can validate the secret shape before calling composeAndStart.
 */
export { loadSecrets };
