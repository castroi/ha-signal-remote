# Deploying the home-control bridge

A single hardened container on a private bridge network with **no inbound ports**
(design §3, §6 A05). It opens outbound connections only: a JSON-RPC WebSocket to
signal-cli-rest-api, REST + WebSocket to Home Assistant.

## Prerequisites

- A running `bbernhard/signal-cli-rest-api` container in `MODE=json-rpc` holding the
  bot's dedicated number, reachable on the private network.
- Home Assistant reachable on localhost / the private network, with a long-lived
  access token.
- If you use preset-position verbs (`open_to` / `close_to`), the HA scripts named in
  `position_scripts` (e.g. `script.covers_up` / `script.covers_down`) must exist in Home
  Assistant and accept an `entity_id` list plus a `position` variable.
- Docker + Docker Compose v2.

## Configuration

Secrets are **env-only** — never committed, never logged:

| Variable | Purpose |
| --- | --- |
| `HA_TOKEN` | HA long-lived access token (privileged; rotate if the Pi is exposed) |
| `HA_BASE_URL` | e.g. `http://homeassistant:8123` |
| `SIGNAL_API_URL` | e.g. `http://signal-cli-rest-api:8080` |
| `BOT_NUMBER` | the bot's dedicated Signal number |
| `ALLOWLIST_UUIDS` | comma-separated authorized sender ACI UUIDs |
| `AUDIT_SALT` | salt for the audit-log UUID hash |

Copy the alias table and edit for your devices:

```sh
cp config/aliases.example.yaml config/aliases.yaml
```

Provide secrets via a local `.env` (gitignored) or your secrets manager.

## Build & run

```sh
docker compose config        # validate the compose file
docker build -t home-control-bridge .
docker compose up -d
```

## Hardening (verify after deploy)

The compose service applies:

- `read_only: true` rootfs + `tmpfs: /tmp` for scratch
- `security_opt: [no-new-privileges:true]`
- `cap_drop: [ALL]`
- non-root `node` user (set in the Dockerfile)
- base image **pinned by digest** in the Dockerfile
- alias table mounted **read-only**
- **no published ports**

Confirm at runtime:

```sh
docker inspect home-control-bridge \
  --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}'
docker inspect home-control-bridge --format '{{.Config.User}}'   # -> node
docker port home-control-bridge                                   # -> (empty)
```

## Shared-daemon note (design §6)

Anything that can reach the signal-cli container can send as the bot, so keep it off
the LAN. If any other container shares the same signal-cli daemon, **harden it to this
bot's standard** — it is now adjacent to house control.
