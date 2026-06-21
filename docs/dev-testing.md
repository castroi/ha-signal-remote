# Dev testing — without a Raspberry Pi, Shelly hardware, or real Signal

This runs the bridge against a **mock signal-cli** and a **real Home Assistant**
with **simulated covers + a garden light**. It exercises the full bridge logic
and 8 of the 9 go-live gates. Gate 1 (bbernhard replay-timestamp) still needs
real signal-cli on the deployment network and is out of scope here.

Stack (`docker-compose.dev.yml`):

| Service | Role | Host port |
|---|---|---|
| `mock-signal` | stands in for signal-cli-rest-api (`dev/mock-signal-cli.mjs`) | `127.0.0.1:8099` |
| `homeassistant` | real HA + simulated entities (`dev/homeassistant/`) | `127.0.0.1:8123` |
| `bridge` | the bridge under test (built from `Dockerfile`) | — (no inbound) |

Simulated entities: `cover.living_room`, `cover.kitchen`, `cover.kids_room`,
`cover.parents_room` (6–8s travel, real `opening`/`closing` → `open`/`closed`
transitions) and `light.garden`. Covers never report `stopped` (HA never does),
so `stop` completion is the one behaviour that still needs real hardware (§7).

## One-time setup

```bash
cp dev/.env.dev.example .env.dev

# 1. start HA + mock
docker compose -f docker-compose.dev.yml up -d homeassistant mock-signal

# 2. onboard HA (http://127.0.0.1:8123) and create a long-lived token:
#    profile → Security → Long-lived access tokens → create → paste into .env.dev
#    (or script onboarding via /api/onboarding/users + /auth/token + the
#     auth/long_lived_access_token WS command)

# 3. start the bridge
docker compose -f docker-compose.dev.yml --profile bridge up -d --build bridge
```

Confirm it's live (covers enable only after the 10s WS-healthy debounce):

```bash
curl -s -XPOST 127.0.0.1:8099/inject -H 'content-type: application/json' \
  -d '{"sourceUuid":"dev-uuid-1","message":"סטטוס"}'
curl -s 127.0.0.1:8099/sent | jq -r '.[].message'
# → מצב: WS תקין | שעון תקין | כיבוי חירום כבוי | תריסים פעילים
```

## Driving the bridge

The mock exposes control endpoints:

- `POST /inject {sourceUuid, message, timestamp?, count?}` — push an inbound message.
  `sourceUuid` must be in `ALLOWLIST_UUIDS` (`dev-uuid-1` by default).
- `GET /sent` — every reply the bridge sent. `POST /reset` clears it.

```bash
# open the living room and watch the two-stage ack
curl -s -XPOST 127.0.0.1:8099/reset
curl -s -XPOST 127.0.0.1:8099/inject -d '{"sourceUuid":"dev-uuid-1","message":"פתח סלון"}'
sleep 8 && curl -s 127.0.0.1:8099/sent | jq -r '.[].message'
# → מבצע…   then   בוצע
```

Watch a cover's state directly:

```bash
docker compose -f docker-compose.dev.yml exec homeassistant python -c \
"import sqlite3;d=sqlite3.connect('/config/home-assistant_v2.db');print([r[1] for r in d.execute(\"select s.state from states s join states_meta sm on s.metadata_id=sm.metadata_id where sm.entity_id='cover.living_room' order by s.last_updated_ts desc limit 1\")])"
```

## Go-live gates — how to reproduce here

| Gate | Steps |
|---|---|
| 2. WS disconnect mid-travel | inject `סגור סלון`; within 6s `docker compose -f docker-compose.dev.yml stop homeassistant` → expect fail-closed, no false ack; status shows `ws-down` |
| 3. HA restart during pending | inject a cover command; mid-travel `docker compose -f docker-compose.dev.yml restart homeassistant` → command → `failed`/`timeout` after the decision window, no success ack |
| 4. Bridge restart during pending | inject a cover command; mid-travel `docker compose -f docker-compose.dev.yml restart bridge` → "reinitialized", in-flight abandoned |
| 5. Kill switch mid-travel | implement the kill toggle path, then inject mid-travel → new commands blocked, best-effort stop; status/help still reply |
| 6. Duplicate delivery | `inject` with `count: 2` and a fixed `timestamp` → dedup drops the replay; one action, one reply |
| 7. Rate-limit vs confirm | inject `תריסים` then >5 commands to trip the limiter, then `כן` → the confirm still resolves via the reserved lane |
| 8. Clock skew → safe mode | point `CLOCK_REFERENCES` at a deliberately-wrong source, or skew the bridge container clock → status `שעון תקלה`, covers disabled; restore → re-enable |
| 9. Hebrew variants | inject phrasings (`תפתח סלון`, `להוריד תריס במטבח`, gibberish) → correct action or disambiguation/menu fallback |
| 1. Replay timestamp (BLOCKING) | **not here** — needs real bbernhard signal-cli on the deployment network |

## Notes

- `CLOCK_REFERENCES` points at the mock's `/time` (the container's own clock) so
  dev skew is ~0. Real deployments use real time references (see `.env.example`).
- All host ports bind `127.0.0.1` only. The bridge publishes no ports.
- `.env.dev` and HA runtime state under `dev/homeassistant/` are gitignored.
