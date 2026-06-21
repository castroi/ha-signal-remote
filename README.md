# ha-signal-remote

A small, hardened bridge that turns **Hebrew Signal messages into Home Assistant cover/light commands**.

Send `סגור סלון` ("close salon") to a dedicated Signal number and the living-room shutter closes — with a layer of safety controls (freshness, dedup, clock-health, WebSocket fail-closed, rate limiting, kill switch) so a stale, replayed, or spoofed message can never move a cover unexpectedly.

> Package name: `home-control-bridge`. A single long-running Node.js + TypeScript service designed to run as one container on a Raspberry Pi alongside Home Assistant and signal-cli.

---

## How it works

```
Signal user ──(Hebrew text)──► signal-cli-rest-api ──WS──► bridge ──REST──► Home Assistant
                                                       ◄──WS── (state_changed)
```

- **Receives** messages over an outbound JSON-RPC WebSocket to a [`bbernhard/signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api) container (`MODE=json-rpc`).
- **Commands** Home Assistant over its REST API (`cover.open_cover` / `close_cover` / `stop_cover`, `light.turn_on` / `turn_off`).
- **Tracks** completion by subscribing to HA `state_changed` over a second WebSocket.
- **Replies** to the user over the signal-cli REST endpoint.

All runtime state (dedup cache, pending commands, rate-limit counters, kill-switch flag) is **RAM-only** — no database, no persistent cache. The container has **no inbound ports**; it only makes outbound connections.

### Architecture (hexagonal)

| Layer | Path | Responsibility |
| --- | --- | --- |
| `core/` | `src/core/` | Pure decision logic, no I/O — normalizer, parser, gates, state machine, rate limiter, clock-health, dedup, audit |
| `adapters/` | `src/adapters/` | Thin I/O — `signal`, `ha-rest`, `ha-ws`, `clock-source` |
| `app/` | `src/app/` | Wiring, config, the composition root (`compose.ts`) and `Bridge` pipeline |

The pure core means most behavior is unit-testable without Signal or Home Assistant.

---

## Safety controls

| Control | Behavior |
| --- | --- |
| **Freshness gate** | A command older than 30s is refused with an ask-to-resend (stateless). |
| **Future-timestamp guard** | A timestamp more than 10s in the future routes to the clock-unhealthy path, not a normal refusal. |
| **Dedup cache** | Keyed on `(sourceUuid, timestamp, normalized command)`, 90s TTL — a redelivered Signal message acts once. |
| **Clock health** | External time references checked every 60s; skew > 30s disables covers. If all references are unreachable, covers stay enabled within a 1h last-good grace, then fail safe. **Lights are never affected by clock state.** |
| **WS fail-closed (covers)** | If the HA state WebSocket is down, cover commands are refused — no state tracking means no false acks. Covers re-enable only after the WS is continuously healthy for 10s (anti-flap debounce). **Lights stay operable.** |
| **Rate limiting** | 5/30s per sender + 15/30s global. A valid `כן`/`לא` confirm bypasses the caps via a reserved lane (itself capped at 6/sender/min). |
| **Kill switch** | Blocks all new commands (guaranteed) and best-effort issues `stop_cover` to every in-flight cover. Status/help still reply in safe mode. |
| **Allowlist** | Identity is pinned on Signal `sourceUuid` (ACI), not phone number. Unknown senders are silently dropped (rate-limited log, no message body). |
| **Privacy-safe audit log** | Logs salted UUID hash, normalized intent, entity, result, latency, reason code — **never the raw message body, token, or PII.** |
| **Safe startup** | On restart, all pending operations are cleared and in-flight commands abandoned (not resumed); refuses action until a fresh command arrives. |

---

## Requirements

- **Node.js 20** (`>=20.19 <21`) and **pnpm** (`pnpm@9.15.9`) for development.
- For deployment: **Docker + Docker Compose v2**.
- A running `bbernhard/signal-cli-rest-api` container in `MODE=json-rpc` holding the bot's dedicated number.
- **Home Assistant** reachable on the private network, with a long-lived access token.

---

## Configuration

Secrets are **env-only** — never committed, never logged. Copy the template and fill it in:

```sh
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `HA_BASE_URL` | ✓ | Home Assistant base URL, e.g. `http://homeassistant:8123` |
| `HA_TOKEN` | ✓ | HA long-lived access token (privileged — rotate if the Pi is exposed) |
| `SIGNAL_API_URL` | ✓ | signal-cli-rest-api base URL, e.g. `http://signal-cli-rest-api:8080` |
| `BOT_NUMBER` | ✓ | The bot's dedicated Signal number (E.164) |
| `ALLOWLIST_UUIDS` | ✓ | Comma-separated authorized sender ACI UUIDs (at least one) |
| `AUDIT_SALT` | ✓ | Salt for the audit-log UUID hash — generate with `openssl rand -hex 32` |
| `CLOCK_REFERENCES` | | Comma-separated time-reference URLs (defaults to worldtimeapi.org + timeapi.io) |
| `ALIAS_PATH` | | Path to the alias table (default `/app/config/aliases.yaml`) |

The bridge **fails fast on startup** if any required variable is missing, naming the missing key.

### Alias table

Map household Hebrew speech to HA `entity_id`s. Adding a device is one row here plus HA config — no code change.

```sh
cp config/aliases.example.yaml config/aliases.yaml
```

```yaml
verbs:
  open:  ["פתח", "תפתח", "להרים", "הרם"]
  close: ["סגור", "תסגור", "להוריד", "הורד"]
  stop:  ["עצור", "תעצור", "הפסק"]
  on:    ["הדלק", "תדליק", "להדליק"]
  off:   ["כבה", "תכבה", "לכבות"]

entities:
  salon:
    type: cover
    entity_id: cover.living_room
    completion_timeout_ms: 30000
    aliases: ["סלון"]

scopes:
  all_covers:
    word: "תריסים"
    expands_to_type: cover
```

---

## Usage (Hebrew commands)

A message is `verb + entity`, e.g. `סגור סלון` (close salon) or `פתח מטבח` (open kitchen). Matching is exact + prefix only — **no fuzzy matching for covers.**

| Word | Meaning |
| --- | --- |
| `תריסים` | All-covers scope — prompts a context-bound `כן`/`לא` confirmation (20s expiry) before acting |
| `כן` / `לא` | Yes / No — confirm or cancel a pending all-covers action |
| `סטטוס` | Status — always answered for authorized senders: WS / clock / kill-switch / covers-enabled state |
| `עזרה`, `תפריט` | Help / menu |

Cover feedback is two-stage (`מבצע…` then completion); lights are single-stage. A command that exceeds its per-entity `completion_timeout_ms` returns a timeout + manual-check reply — never a false success. Sending a new command for a cover already in motion preempts it (stop, then the new direction).

---

## Development

```sh
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm test          # vitest run
pnpm test:watch    # vitest (watch)
pnpm build         # tsc -p tsconfig.build.json -> dist/
pnpm start         # node dist/index.js
```

Development follows TDD — write the failing test first. The full release gate is:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm audit
```

---

## Deployment

A single hardened container on a private bridge network with no published ports.

```sh
docker compose config        # validate the compose file
docker build -t home-control-bridge .
docker compose up -d
```

The compose service applies: read-only rootfs + `tmpfs:/tmp`, `no-new-privileges`, `cap_drop: ALL`, non-root `node` user, base image pinned by digest, and the alias table mounted read-only.

See [docs/deploy.md](docs/deploy.md) for the full deployment guide and runtime verification commands.

> **Shared-daemon note:** anything that can reach the signal-cli container can send as the bot. Keep it off the LAN, and harden any other container sharing the same signal-cli daemon to the same standard.

---

## Documentation

- [docs/deploy.md](docs/deploy.md) — deployment & hardening
- [docs/dev-testing.md](docs/dev-testing.md) — testing notes
