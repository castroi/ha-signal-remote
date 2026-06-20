# Signal → Home Assistant Cover/Light Control — High-Level Plan

Status: v2.1 (build-ready candidate). Nothing is built yet. A self-hosted Signal bot on a
Raspberry Pi 3B+ that controls Shelly roller covers and lights via Home Assistant.
Security spine borrowed from the `train-notifier` plan, but every "acceptable risk"
is re-evaluated because **this system actuates physical hardware**, not read-only
timetables. v2 folded in the review rounds (fail-closed covers, always-on dedup,
rate limiting, command state machine with a `failed` terminal state, hard kill switch,
conflict preemption, context-bound confirmation, safe startup, split restart gates).
v2.1 adds initial defaults for all tunables, a clock-health precondition (incl. offline
grace), §8 mirroring of HA-restart semantics, a confirm-lane cap, and a `סטטוס` health
command. **Totals: 26 locked decisions in §2 (of which 11 are the safety controls
added/changed during the v2 review rounds), and 9 must-pass go-live gates in §10.**

---

## 1. Goal & scope

- Control Shelly IoT devices (roller covers + lights) by texting a Signal bot in Hebrew.
- Covers: open / close / stop, per-room, plus an all-covers action.
- Lights: on / off (garden to start).
- Go **through Home Assistant**, never directly to Shelly devices (single trust
  boundary, HA holds device credentials, HA gives state feedback).
- OWASP-resistant by design; the system can open the house, so safety and
  authorization are first-class.

## 2. Decisions locked

| Area | Decision | Rationale |
| --- | --- | --- |
| Control path | Signal → bridge → HA REST (commands) + HA WebSocket (state) → Shelly | One auth boundary; HA abstracts devices; WS needed for truthful completion feedback |
| Direct-to-Shelly | Rejected | More secrets, weaker local auth, larger attack surface |
| UX primary | **Free text** (verb + entity + scope), normalized | Matches natural Hebrew; scales via alias table |
| UX fallback | Name-based disambiguation + menu card on miss | Discoverable; no stale-number hazard |
| Numbers in menus | **None** | Name-based replies; removes bidi-digit + stale-number risk |
| "All covers" keyword | bare `תריסים` = all covers | Natural; no separate "all" word |
| All-covers action | **Confirm-gated** (`כן`/`לא`) + 20s expiry + consequence stated | Worst misfire; gate is a safety control |
| Cover feedback | **Two-stage**: ack-on-receipt (`מבצע…`) then ack-on-completion | Truthful; enables timeout failure detection |
| Light feedback | Single-stage | Instant toggle; staged ack is noise |
| Matching | Exact + prefix on a small alias table; **no fuzzy for covers** | Deterministic; no typo-misfires moving wrong roller |
| Stale commands | **Freshness gate** on Signal envelope timestamp; reject if too old | Prevents queued command actuating on network return |
| Clock health | Bad NTP/skew → **covers safe-mode** (lights fine), warn in status/logs | Freshness + dedup depend on a correct clock; wrong clock silently defeats them |
| Persistent cache | **None** | Freshness gate is stateless; all state RAM-only |
| Dedup | **Always on**, RAM-only, TTL **90s** | Protects against reconnect/duplicate delivery |
| WS down (covers) | **Fail closed** — reject cover commands; lights stay operable | Cover safety depends on completion verification |
| Rate limiting | Per-sender + global burst caps; "rate-limited" reason code logged | Guards against loops / compromised authorized account |
| Command state machine | `received → pending_confirm? → issued → observed_target \| timeout \| preempted \| failed`; correlation ID in acks + logs | Distinct terminal states for correct replies + incident review |
| Conflict handling | **Preempt** in-flight command (stop + new direction), not queue | Reaches user-intended safe state fastest |
| Kill switch | **Hard kill**: local bridge flag authoritative; blocks new commands AND issues `cover.stop_cover` to entities in `issued` (block guaranteed, stop best-effort) | Off-switch must not depend on the system it disables; halting in-flight covers matches the safety posture |
| Confirmation binding | `כן`/`לא` bound to (same UUID + same pending action + same live expiry) | Prevents cross-chat / cross-sender accidental confirms |
| Startup | Clear pending ops; require fresh commands; emit "reinitialized" once | RAM state must not resurrect across restart |
| signal-cli | Shared instance, JSON-RPC mode, dedicated number | Pi 3B+ cannot run two Java/Signal containers |
| Identity | Pin on **sourceUuid (ACI)**, not phone number | Number may be empty; UUID is reliable |
| Unknown UUID | **Silent**; onboarding via allowlist, not replies | Avoids leaking bot existence |
| Status command | `סטטוס` → WS / clock / kill-switch / covers-enabled; allowlist-checked first (silent to unknown), then always answered for authorized | Fast field debugging; explains *why* covers are blocked, without leaking bot existence |
| LLM / fuzzy AI | Rejected | Tiny closed domain; injection surface; Pi can't host |

## 3. Architecture / topology

One Pi, private bridge network, no host ports published to the LAN.

- **signal-cli-rest-api** (existing bbernhard container, `MODE=json-rpc`): holds existing
  number(s) and this bot's dedicated number. No built-in auth — network reach equals full
  access, so keep it off the LAN.
- **home-control bridge** (new, lightweight, long-running): receives Signal notifications,
  validates, runs the command state machine, maps to HA service calls, sends replies.
  Holds the HA token and the authoritative kill-switch flag. No inbound ports.
- **Home Assistant** (existing): reached over localhost / private bridge. REST for
  commands, WebSocket for state.
- **Shelly devices**: on the LAN (ideally segregated VLAN/SSID), reached only by HA.

Key property: **no inbound port.** Signal is the encrypted transport; signal-cli holds an
outbound connection. No webhook, no router port.

## 4. Command model (UX)

Every message parses to **verb + entity + scope**, each matched against whitelists.
Normalize first: strip niqqud, normalize final letters, strip the `ה` article / leading
prefixes, collapse whitespace.

- **Verbs**: open / close / stop (covers), on / off (lights), with Hebrew variants.
- **Entities**: room aliases (סלון, מטבח, חדר ילדים, חדר הורים) and light aliases (גינה),
  mapping household speech → HA entity_ids (e.g. סלון → `cover.living_room`).
- **Scope**: bare `תריסים` = all covers.

Failure taxonomy (three distinct replies, never one generic error):
1. **No verb / gibberish** → menu fallback card.
2. **Verb known, entity unknown** → echo the rejected word + list valid targets.
3. **Ambiguous** → ask by name (סלון / מטבח / …); user replies with the name.

Reserved control words (`כן`, `לא`, `תפריט`, `עזרה`, `סטטוס`, `תריסים`) are never parsed as
device names. `כן`/`לא` are valid **only** while a matching context-bound confirm is pending
(§5); used outside that context they are logged as an **"unrecognized control reply"**
(not generic gibberish) and fall to the menu fallback. The same precision applies to
`תפריט`/`עזרה` used mid-flow — logged as a control reply with no matching context — so the
audit vocabulary distinguishes stray reserved words from genuine unknown input.

**Status command** (`סטטוס`): a compact health reply for field debugging. The allowlist
check runs **first** — an unknown UUID gets the same **silence** as any other message
(the status command is not a probe that leaks the bot's existence). For an **authorized**
UUID it is then **always answered**, never blocked by safe-mode or the kill switch (its
purpose is to explain *why* things are blocked). Returns, in one short message: **WS**
healthy/unhealthy, **clock** healthy/unhealthy, **kill switch** on/off, and **covers**
enabled/disabled (with the reason if disabled — e.g. "covers off: WS down" or "covers off:
clock skew"). This is the fastest way to answer "why won't my blind move?" without reading
logs.

## 5. Feedback, state machine & safety model

**Command state machine** (per command, with a correlation/command ID):
`received → pending_confirm? → issued → observed_target | timeout | preempted | failed`
where `pending_confirm` is entered only for all-covers (and any confirm-gated action).
Terminal states are distinct on purpose: `observed_target` (reached target), `timeout`
(issued but never reached target in time), `preempted` (cancelled by a newer command),
`failed` (HA rejected/errored or the call never issued). Each maps to a different reply
and audit code. The command ID appears in **both ack messages and the logs**, so
concurrent operations are unambiguous.

- **Two-stage cover feedback** needs HA actual end state → **WebSocket subscription** to
  HA state changes (not REST polling; polling is wasteful on the Pi and races on
  `opening`/`closing`).
- **WS fail-closed (covers only)**: if the WS state stream is unavailable, **reject cover
  commands** — reply `אין כרגע מעקב מצב, התריסים מושבתים זמנית`. Lights remain operable
  (single-stage, no WS dependency).
- **Per-entity completion timeout**, configured in the alias table (covers differ in
  travel time and reporting). On timeout: honest failure reply
  (`תריס סלון לא הגיב. בדוק ידנית.`), state → `timeout`.
- **Clock health (precondition for the two gates above)**: freshness and dedup both rely
  on `now` and on timestamps, so a wrong system clock silently defeats them — a stale
  command can compute as fresh with no visible error. At startup and periodically, check
  NTP sync / skew against an external reference; if skew exceeds a threshold (**initial:
  30s**), **disable covers** (lights remain operable) and surface it in status + logs.
  Covers re-enable only once the clock is healthy again. **External reference policy** (so
  behavior is deterministic): an ordered list — a primary source plus fallbacks (hosts in
  config, not hard-coded here); each check tries them in order; "unreachable" means **all**
  sources failed within the check's own timeout. **Offline / all references unreachable**:
  keep covers enabled on a **last-known-good grace window** (initial: 1h, assuming the
  clock won't drift past threshold within it — a tunable, not a constant, since a failing
  RTC can drift faster); past the grace with no successful check, **fail safe and disable
  covers**.
- **Freshness gate**: `now − envelope.timestamp > window` → refuse + ask to resend.
  Server-assigned timestamp reveals a queued/replayed command's true age. Zero stored
  state. **Window: initial 30s (tune on hardware).**
- **Future-timestamp guard**: the gate above is one-sided (catches only *old*), so a
  future timestamp would pass trivially (negative age) — and a far-future one can mask a
  genuinely stale command. If `envelope.timestamp − now > tolerance` (**initial: 10s**,
  tighter than the freshness window since synced clocks should agree sub-second), route to
  the **clock-unhealthy path** (covers safe-mode), not a normal refusal — a future
  timestamp means a clock disagreement, which is a safety event, not a stale message.
- **Always-on dedup**: key `(sourceUuid, envelope_timestamp, normalized_command)`,
  TTL **90s** (initial; tune on hardware), RAM-only. The timestamp in the key is load-bearing: two genuine "close
  salon" commands differ by timestamp → both run; a redelivery shares it → dropped.
- **Confirm gate** on `תריסים`: prompt **states the consequence** ("לסגור את כל N
  התריסים?"), `כן`/`לא`, **20s expiry**, and is **context-bound** to the same sender UUID
  + same pending action + same live window.
- **Conflict preemption**: a new command for an entity in `issued` state preempts the
  in-flight one (issue `stop`, then new direction); state → `preempted`. No queue.
- **WS reconnection policy**: on WS loss, retry with bounded exponential backoff
  (**initial: 1s → 30s cap, with jitter**); covers stay disabled until WS has been
  **continuously healthy for X seconds** (debounce, **initial X: 10s**) so a flapping
  connection can't briefly re-enable covers and accept an untrackable command. A pending
  cover command caught by an HA/WS outage waits up to the **`ha_reconnect_decision_window`**
  (**initial: 30s**) for HA to return; on expiry it transitions deterministically to
  `failed` (if it never issued — HA was unreachable) or `timeout` (if it issued but the
  state stream dropped before observing target); **no success ack** either way. This window
  is intentionally **longer than the debounce** — it's how long you *wait for HA before
  giving up*, whereas the debounce is how long you *distrust a flaky-but-present
  connection*; the two are not interchangeable.
- **Rate limiting**: per-sender cap (**initial: 5 commands / 30s**) + global burst cap
  (**initial: 15 / 30s**); trips logged with a "rate-limited" reason code. A **reserved
  confirm lane** exempts a valid `כן`/`לא` from those caps — but **only** when it matches
  a live context-bound `pending_confirm` (same UUID + action ID + unexpired window, per
  the confirm gate). The lane itself is capped (**max confirms: 6 / sender / minute**) so
  confirm-spam can't become a rate-limit side channel. The binding plus this cap is what
  keeps the lane safe.
- **Kill switch (hard kill)**: local bridge flag is authoritative; optional HA
  `input_boolean` mirror. Hard kill **blocks all new commands AND issues `cover.stop_cover`
  to every entity currently in `issued`**. The block is guaranteed; the stop is
  **best-effort** — if the kill is thrown because HA itself is misbehaving, the stop may
  not land. In safe mode, actuation is disabled but **help/status replies still work**.
- **Safe startup**: on restart, clear all pending ops, refuse action until a fresh command
  arrives, emit "state tracking reinitialized" once. Consequence: a command in flight at
  restart is **abandoned, not resumed** — the cover may be mid-travel and is no longer
  tracked (correct fail-safe; covered by a go-live gate).

## 6. Security (OWASP) & privacy

- **A01 — Authorization**: allowlist on **sourceUuid**; unknown senders get **no reply**;
  logs rate-limited, never include the body. A dedicated number is addressing, not auth.
- **A03 — Injection**: HTTP to HA/Signal, never shell/CLI strings; input validates to a
  closed verb/entity/scope set.
- **A02/A05 — Secrets**: the **HA long-lived token** is privileged (full user perms, no
  per-entity scoping in HA) — tight file perms, never logged, rotate if Pi exposed,
  env/mounted file only. The HA WebSocket reuses the **same scoped token**, not a broader
  one.
- **A05 — Hardening**: non-root, read-only rootfs + tmpfs, `no-new-privileges`,
  `cap_drop: ALL`, image pinned by digest, config read-only.
- **A06 — Components**: minimal pinned deps, lockfile, `npm audit`/Dependabot, keep
  signal-cli current (clients expire ~3 months).
- **Network**: private bridge, no LAN ports; host bind `127.0.0.1` only. Anything that can
  reach the Signal API container can send as the bot; the HA WS is a third connection in
  the trust zone — keep it tight.
- **Shared-daemon compromise**: Pi forces one signal-cli for this bot and the train bot.
  Harden the train container to **this** bot's standard, since it is now adjacent to house
  control.
- **Audit log (privacy-safe)**: timestamp, salted UUID hash, normalized intent, entity,
  result, latency, failure/reason code. No raw body by default. Salt policy (stable vs
  rotating) decided explicitly.

## 7. Home Assistant integration

- **Commands**: REST service calls (`cover.open_cover`, `cover.close_cover`, `cover.stop_cover`,
  `light.turn_on/off`) over localhost.
- **State**: WebSocket subscription, forwarded as completion ack + timeout/failure detector;
  its availability gates cover commands (§5 fail-closed).
- Adding a device later = HA config + one alias-table entry (incl. its per-entity timeout);
  no bridge code change.
- Caveat: Shelly generations differ in position reporting — completion-ack timing and
  mid-travel stop+reverse behavior depend on the device; verify on hardware.

## 8. Failure handling

- HA call fails/times out → honest error, no false ack.
- Cover never reaches target within per-entity timeout → manual-check message; `timeout`.
- WS state stream down → covers refused (fail-closed); lights still work.
- **HA restart during a pending command** → bridge survives; command becomes `failed`
  (never issued) or `timeout` (issued, stream lost before target) **after
  `ha_reconnect_decision_window`**, **no success ack**;
  covers remain disabled until WS healthy for X seconds (§5 debounce).
- **Clock unhealthy** (NTP unsynced / skew over threshold, **or `envelope.timestamp` more
  than the future tolerance ahead of `now`**) → covers in safe mode (lights fine), warned
  in status + logs; covers re-enable when the clock recovers. **All references
  unreachable** → last-known-good grace window, then fail safe (covers disabled) if no
  successful check within the grace.
- Rate limit tripped → reject with reason code; valid confirm path must survive.
- Signal send fails → log and drop (can't deliver an error if Signal is the broken link).
- Unauthorized sender → silent, rate-limited log, no body.
- Bridge restart mid-command → pending ops cleared, command abandoned, "reinitialized"
  notice emitted.

## 9. Open items

**Tunables — initial defaults set in §5; tune on hardware:**
- Freshness window: **30s**
- Future-timestamp tolerance: **10s** (→ clock-unhealthy path)
- Dedup TTL: **90s**
- WS-healthy debounce X: **10s**
- `ha_reconnect_decision_window` (wait before `failed`/`timeout`): **30s**
- Reconnect backoff: **1s → 30s cap, jitter**
- Rate limits: **5/30s sender, 15/30s global**
- Confirm-lane cap: **6/sender/min**
- Clock-skew threshold: **30s**
- Clock offline grace (reference unreachable): **1h**, then fail safe

**Genuinely open — decide before/at first deploy:**
1. **All-covers completion ack** — one summary line vs per-cover; lean summary + exception
   line only on failure.
2. **HA token scoping** — confirm current HA guidance.
3. **Shelly generation** of the actual devices — affects state granularity + stop/reverse.
4. **Bot tone** — terse vs conversational (family members).

## 10. Go-live gates — 9 MUST PASS (empirical, on real hardware)

These cannot be pre-cleared by design; they must be tested on the actual stack.

1. **Replay timestamp behavior (BLOCKING)** — does bbernhard's WS preserve the original
   Signal timestamp across reconnect-replay? Send command, sever connection ~90s,
   reconnect, inspect timestamp: old = freshness gate works; new = gate defeated. The
   whole stale-command defense rests on this.
2. **WS disconnect mid-travel** — covers correctly refuse / fail-closed; no false ack.
3. **HA restart during a pending command** — HA (device controller) drops while the
   **bridge survives**; the command transitions to `failed` (never issued) or `timeout`
   (issued, state stream lost before target) after **`ha_reconnect_decision_window`**, **no success
   ack**. Covers stay disabled until WS is healthy for X seconds (§5 debounce).
4. **Bridge restart during a pending command** — bridge (tracker) drops while the cover
   keeps moving; **all RAM pending state cleared globally**, in-flight action abandoned
   not resumed, "reinitialized" notice emitted, user-visible handling correct.
5. **Kill switch during a pending command (hard kill)** — new commands blocked
   (guaranteed); `cover.stop_cover` **attempts issued** to all in-flight covers; **observed
   stop** on entities whose HA path is healthy (stop is best-effort — if HA is the reason
   for the kill, it may not land). Status/help still reply.
6. **Duplicate Signal delivery** — dedup drops the replay; single action, single reply.
7. **Rate-limit trip does not break a valid confirm** — a legitimate `כן` after a trip
   still resolves via the confirm lane.
8. **Clock skew → cover safe mode** — induce NTP skew past threshold **and** send a
   command with a future timestamp past tolerance; both route covers to safe-mode and
   status warns; covers re-enable on recovery. (Protects the freshness gate from a wrong
   clock and from future-dated timestamps — the same silent-defeat class as gate 1.)
9. **Ambiguous Hebrew variants** — normalization + alias matching resolve real phrasings;
   misses fall to the correct disambiguation/menu path.

## 11. Explicitly out of scope

- Direct Shelly control — rejected (security).
- Local LLM / fuzzy NLU — closed domain; injection surface; Pi can't host usefully.
- Persistent cache / database — freshness gate + RAM-only dedup replace it.
- Second signal-cli container — Pi can't run two Java/Signal containers.
- Numbered menus — replaced by name-based disambiguation.
- Resuming in-flight commands across a restart — abandoned by design (fail-safe).
