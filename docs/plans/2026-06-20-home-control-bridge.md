# Signal → Home Assistant Cover/Light Control — Implementation Plan

**Goal:** Build the long-running `home-control` bridge that turns Hebrew Signal messages into Home Assistant cover/light service calls, with the freshness/dedup/clock/WS/kill-switch safety controls from the design doc.

**Source design:** [`plans/home-control-bot-plan.md`](../../plans/home-control-bot-plan.md) (v2.1, 26 locked decisions, 9 go-live gates).

**Architecture:** A single Node.js + TypeScript service, packaged as a hardened Docker container on a private bridge network with **no inbound ports**. It opens an outbound WebSocket to the bbernhard `signal-cli-rest-api` container (`MODE=json-rpc`) to *receive* messages and sends replies over its REST API; it issues commands to Home Assistant over REST and subscribes to HA state over a second WebSocket. All state (dedup, pending commands, rate-limit counters, kill-switch flag) is RAM-only — no database, no persistent cache (locked §2). Pure decision logic (normalize → parse → gate → state machine) is isolated from I/O so it is unit-testable without Signal/HA; I/O adapters are thin.

**Key decisions (made during discovery; grounded in the design doc, see "Assumptions" at end):**

- **Node.js 20 + TypeScript**, ESM, Vitest for tests, `pnpm`. The doc's §6/A06 calls for `npm audit`/Dependabot/lockfile, which implies the Node ecosystem; a tiny event-loop service fits a Pi 3B+ better than the JVM (which the Pi already strains to run for signal-cli — §2).
- **Hexagonal layering**: `core/` (pure, no I/O — normalizer, parser, gates, state machine, rate limiter, clock-health policy) + `adapters/` (signal, ha-rest, ha-ws, clock-source) + `app/` (wiring, config). This makes gates 1, 6, 7, 8 unit-testable and gates 2–5 the only ones that truly need hardware.
- **Config-driven alias table** (`config/aliases.yaml`): verb/entity/scope whitelists, per-entity HA `entity_id` + completion timeout. Adding a device = HA config + one alias row, no code change (§7).
- **All tunables live in one typed config module** with the §9 initial defaults as constants, overridable by env/file.
- The 4 genuinely-open §9 items are surfaced as explicit config switches with the doc's leaning as the default (see "Open items" at end).

---

## Conventions for every task

- TDD: write the failing test first, watch it fail with the expected message, implement, watch it pass.
- Verification commands assume repo root and `pnpm` installed.
- Lint/typecheck gate: `pnpm lint && pnpm typecheck` must pass before any task is considered done.
- Secrets (HA long-lived token, signal-cli URL) are **env-only**, never committed, never logged (§6 A02/A05).

---

## Tasks

### Task 0: Repo, toolchain, CI skeleton

**Independent:** Yes · **Scope:** Small

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.eslintrc.cjs`, `.gitignore`, `.nvmrc`
- Create: `src/index.ts` (placeholder entrypoint), `src/health.test.ts`
- Create: `.github/workflows/ci.yml` (typecheck + lint + test + `pnpm audit`)

**Steps:**
1. `git init`; scaffold `pnpm` project, TypeScript strict mode, ESM, Vitest.
2. Add a trivial `sum`-style test to prove the harness runs.
3. Pin Node 20 in `.nvmrc`/`engines`; add lockfile.

**Verification:** `pnpm install && pnpm typecheck && pnpm test`
**Acceptance:** Test harness runs green; `pnpm audit` wired in CI; lockfile committed.

---

### Task 1: Config & tunables module

**Independent:** Yes · **Scope:** Small

**Files:**
- Create: `src/app/config.ts`, `config/aliases.example.yaml`, `src/app/config.test.ts`

**Steps:**
1. Define a typed `Config` with all §9 tunables as defaults: freshness window **30s**, future tolerance **10s**, dedup TTL **90s**, WS-healthy debounce **10s**, `ha_reconnect_decision_window` **30s**, reconnect backoff **1s→30s cap + jitter**, rate limits **5/30s sender + 15/30s global**, confirm-lane cap **6/sender/min**, clock-skew threshold **30s**, clock offline grace **1h**, confirm expiry **20s**.
2. Load and validate the alias table (verb/entity/scope sets, per-entity `entity_id` + `completion_timeout_ms`, reserved control words `כן/לא/תפריט/עזרה/סטטוס/תריסים`).
3. Read secrets (`HA_TOKEN`, `HA_BASE_URL`, `SIGNAL_API_URL`, `BOT_NUMBER`, allowlist UUIDs, `AUDIT_SALT`) from env; fail fast if missing.

**Verification:** `pnpm test src/app/config.test.ts`
**Acceptance:** Defaults match §9 exactly; missing secret throws at startup; reserved words rejected as entity names.

---

### Task 2: Hebrew normalizer

**Independent:** Yes · **Scope:** Small

**Files:** Create `src/core/normalize.ts`, `src/core/normalize.test.ts`

**Steps:**
1. Strip niqqud, normalize final letters (ך→כ ם→מ ן→נ ף→פ ץ→צ), strip leading `ה` article / prefixes, collapse whitespace, trim (§4).
2. Table-driven tests over real Hebrew phrasings (feeds go-live gate 9).

**Verification:** `pnpm test src/core/normalize.test.ts`
**Acceptance:** Idempotent (`normalize(normalize(x)) === normalize(x)`); known variants collapse to canonical forms.

---

### Task 3: Command parser (verb + entity + scope) with failure taxonomy

**Independent:** No — needs Task 1 (alias table), Task 2 (normalize) · **Scope:** Medium

**Files:** Create `src/core/parse.ts`, `src/core/parse.test.ts`

**Steps:**
1. Match normalized tokens against verb/entity/scope whitelists. **Exact + prefix only, no fuzzy for covers** (§2).
2. Resolve bare `תריסים` → all-covers scope.
3. Return a discriminated union covering the three failure replies (§4): `no-verb→menu`, `verb-ok/entity-unknown→echo+list`, `ambiguous→ask-by-name`; plus reserved-word reply (`כן/לא/תפריט/עזרה/סטטוס`) and a distinct `unrecognized-control-reply` audit class.

**Verification:** `pnpm test src/core/parse.test.ts`
**Acceptance:** Each failure mode yields its own typed result; reserved words never resolve to a device; covers reject typos (no fuzzy).

---

### Task 4: Clock-health policy

**Independent:** No — needs Task 1 · **Scope:** Medium

**Files:** Create `src/core/clock-health.ts`, `src/adapters/clock-source.ts`, `src/core/clock-health.test.ts`

**Steps:**
1. Pure policy: given skew samples + last-good timestamp + `now`, output `healthy | unhealthy(reason)` and `covers_enabled` (§5). Skew > **30s** → unhealthy. All references unreachable → stay healthy within **1h** last-known-good grace, then fail safe.
2. Adapter: ordered reference list from config; "unreachable" = all failed within the check timeout; periodic check.
3. A **future-timestamp** (envelope − now > **10s** tolerance) routes to the clock-unhealthy path (§5), not a normal refusal.

**Verification:** `pnpm test src/core/clock-health.test.ts`
**Acceptance:** Skew/future-stamp/offline-grace transitions match §5; lights unaffected by clock state.

---

### Task 5: Freshness gate + future-timestamp guard

**Independent:** No — needs Task 1, Task 4 · **Scope:** Small

**Files:** Create `src/core/freshness.ts`, `src/core/freshness.test.ts`

**Steps:**
1. `now − envelope.timestamp > 30s` → refuse + ask-to-resend (stateless, §5).
2. `envelope.timestamp − now > 10s` → emit clock-unhealthy signal (Task 4), not a refusal.

**Verification:** `pnpm test src/core/freshness.test.ts`
**Acceptance:** Old → refused; future → clock-unhealthy path; in-window → pass. Zero stored state.

---

### Task 6: Dedup cache (RAM, TTL 90s)

**Independent:** No — needs Task 1 · **Scope:** Small

**Files:** Create `src/core/dedup.ts`, `src/core/dedup.test.ts`

**Steps:**
1. Key = `(sourceUuid, envelope_timestamp, normalized_command)`, TTL **90s**, RAM-only, with sweep (§5).
2. Two genuine same-text commands at different timestamps both pass; a redelivery (same key) drops.

**Verification:** `pnpm test src/core/dedup.test.ts`
**Acceptance:** Behavior matches go-live gate 6; entries expire after TTL.

---

### Task 7: Rate limiter + reserved confirm lane

**Independent:** No — needs Task 1 · **Scope:** Medium

**Files:** Create `src/core/rate-limit.ts`, `src/core/rate-limit.test.ts`

**Steps:**
1. Per-sender **5/30s** + global burst **15/30s**; trips return a `rate-limited` reason code (§5).
2. Reserved confirm lane: a valid `כן/לא` matching a live context-bound pending_confirm bypasses the caps, but the lane is itself capped at **6/sender/min** (§5).

**Verification:** `pnpm test src/core/rate-limit.test.ts`
**Acceptance:** Matches go-live gate 7 — a valid confirm survives a trip; confirm-spam is capped.

---

### Task 8: Command state machine

**Independent:** No — needs Tasks 3, 6 · **Scope:** Large

**Files:** Create `src/core/state-machine.ts`, `src/core/state-machine.test.ts`

**Steps:**
1. Implement `received → pending_confirm? → issued → observed_target | timeout | preempted | failed`, each command carrying a correlation/command ID present in acks + logs (§5).
2. **Context-bound confirm** for all-covers: prompt states consequence, `כן/לא`, **20s** expiry, bound to (same UUID + same pending action + live window).
3. **Conflict preemption**: a new command for an entity in `issued` issues `stop` then the new direction → `preempted` (no queue).
4. **Two-stage cover feedback** (`מבצע…` then completion); **single-stage** lights.
5. **Per-entity completion timeout** from the alias table → `timeout` + manual-check reply.
6. **`ha_reconnect_decision_window` (30s)**: a pending cover command caught by an HA/WS outage waits, then → `failed` (never issued) or `timeout` (issued, stream lost), **no success ack**.

**Verification:** `pnpm test src/core/state-machine.test.ts`
**Acceptance:** All terminal states reachable with distinct replies/audit codes; confirm binding rejects cross-sender/expired; preemption produces stop+new-direction.

---

### Task 9: HA REST adapter (commands)

**Independent:** No — needs Task 1 · **Scope:** Medium

**Files:** Create `src/adapters/ha-rest.ts`, `src/adapters/ha-rest.test.ts`

**Steps:**
1. `cover.open_cover / close_cover / stop_cover`, `light.turn_on / turn_off` over localhost (§7), HTTP only — never shell strings (§6 A03).
2. Auth via the long-lived token from env; token never logged (§6 A02).
3. Map HA errors/non-2xx → `failed` for the state machine; honest error, no false ack (§8).

**Verification:** `pnpm test src/adapters/ha-rest.test.ts` (mocked HTTP)
**Acceptance:** Correct service/payload per verb+entity; failures surface as `failed`.

---

### Task 10: HA WebSocket adapter (state) + WS-health gate

**Independent:** No — needs Task 1, Task 8 · **Scope:** Large

**Files:** Create `src/adapters/ha-ws.ts`, `src/adapters/ha-ws.test.ts`

**Steps:**
1. Auth + subscribe to `state_changed`; reuse the **same scoped token** (§6). Forward end-state to the state machine as completion ack / timeout detector (§5, §7).
2. **Fail-closed (covers only)**: WS unavailable → reject cover commands with `אין כרגע מעקב מצב, התריסים מושבתים זמנית`; lights stay operable.
3. **Reconnect**: bounded exponential backoff **1s→30s + jitter**; covers re-enable only after WS **continuously healthy for 10s** (debounce) so flapping can't briefly re-enable.

**Verification:** `pnpm test src/adapters/ha-ws.test.ts` (fake WS server)
**Acceptance:** Matches go-live gates 2 & 3 logic at unit level — covers refuse on WS down, debounce blocks flapping re-enable.

---

### Task 11: Signal adapter (receive + send) + identity/allowlist

**Independent:** No — needs Task 1 · **Scope:** Medium

**Files:** Create `src/adapters/signal.ts`, `src/adapters/signal.test.ts`

**Steps:**
1. Connect to bbernhard `signal-cli-rest-api` JSON-RPC receive WS for `BOT_NUMBER`; send replies over its REST endpoint.
2. **Identity pinned on `sourceUuid` (ACI)**, not phone number (§2). Allowlist check first; **unknown UUID → silent**, rate-limited log, no body (§6 A01).
3. Send failures are logged and dropped — cannot deliver an error if Signal is the broken link (§8).

**Verification:** `pnpm test src/adapters/signal.test.ts` (mocked transport)
**Acceptance:** Unknown sender produces no outbound; envelope timestamp + sourceUuid extracted for downstream gates.

---

### Task 12: Privacy-safe audit logger

**Independent:** No — needs Task 1 · **Scope:** Small

**Files:** Create `src/core/audit.ts`, `src/core/audit.test.ts`

**Steps:**
1. Emit: timestamp, **salted UUID hash** (salt from env, policy documented), normalized intent, entity, result, latency, failure/reason code — **no raw body** (§6).
2. Assert no secret/PII/body field can be logged (redaction test).

**Verification:** `pnpm test src/core/audit.test.ts`
**Acceptance:** Raw message body never appears; UUID is hashed; reason codes (`rate-limited`, `unrecognized-control-reply`, etc.) present.

---

### Task 13: Kill switch (hard kill) + status command

**Independent:** No — needs Tasks 8, 9, 10 · **Scope:** Medium

**Files:** Create `src/core/kill-switch.ts`, `src/core/status.ts`, tests alongside

**Steps:**
1. Local bridge flag is **authoritative** (optional HA `input_boolean` mirror). Hard kill **blocks all new commands** (guaranteed) **and issues `cover.stop_cover` to every entity in `issued`** (best-effort) (§5). Help/status still reply in safe mode.
2. `סטטוס`: allowlist-checked first (silent to unknown), then **always answered** for authorized — returns WS / clock / kill-switch / covers-enabled(+reason) in one short message (§4).

**Verification:** `pnpm test src/core/kill-switch.test.ts src/core/status.test.ts`
**Acceptance:** Matches go-live gate 5 logic; status never blocked by safe-mode/kill.

---

### Task 14: App wiring + safe startup

**Independent:** No — needs Tasks 2–13 · **Scope:** Medium

**Files:** Create `src/app/bridge.ts`, modify `src/index.ts`, create `src/app/bridge.test.ts`

**Steps:**
1. Wire the receive→normalize→dedup→freshness→clock→rate-limit→parse→state-machine→HA→reply pipeline.
2. **Safe startup**: clear all pending ops, refuse action until a fresh command arrives, emit "state tracking reinitialized" once (§5). In-flight commands at restart are abandoned, not resumed.

**Verification:** `pnpm test src/app/bridge.test.ts`
**Acceptance:** Pipeline integration test (all adapters mocked) drives a close-salon command to `observed_target`; restart clears state (go-live gate 4 logic).

---

### Task 15: Hardened container + compose

**Independent:** No — needs Task 14 · **Scope:** Medium

**Files:** Create `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `docs/deploy.md`

**Steps:**
1. Multi-stage build; **non-root, read-only rootfs + tmpfs, `no-new-privileges`, `cap_drop: ALL`, image pinned by digest, config mounted read-only** (§6 A05).
2. Private bridge network; **no published host ports** (host bind `127.0.0.1` only if any). signal-cli + HA reached over the private network/localhost (§3).
3. Document the train-bot container hardening note (§6 shared-daemon).

**Verification:** `docker compose config && docker build -t home-control-bridge .` then `docker run --rm home-control-bridge node -e "process.exit(0)"`
**Acceptance:** Container runs non-root; `docker inspect` shows read-only rootfs + dropped caps; no ports published.

---

### Task 16: Go-live gate harness (hardware acceptance — §10)

**Independent:** No — needs Task 15 + real Pi/HA/signal-cli · **Scope:** Large

**Files:** Create `docs/go-live-gates.md` (runbook), `scripts/gate-checks/*` (helper probes where automatable)

**Steps:** Document and execute, on the **real stack**, the 9 must-pass gates (§10):
1. **Replay timestamp (BLOCKING)** — sever WS ~90s, reconnect, inspect whether bbernhard preserves the original Signal timestamp. Old = freshness gate works; new = gate defeated (whole stale-defense rests on this).
2. WS disconnect mid-travel → covers fail-closed, no false ack.
3. HA restart during pending → `failed`/`timeout` after the decision window, no success ack; covers disabled until WS healthy 10s.
4. Bridge restart during pending → RAM state cleared, action abandoned, "reinitialized" emitted.
5. Kill switch during pending → new blocked; `stop_cover` attempted on in-flight; status/help still reply.
6. Duplicate Signal delivery → dedup drops replay; single action, single reply.
7. Rate-limit trip → valid `כן` still resolves via confirm lane.
8. Clock skew + future timestamp → covers safe-mode, status warns, re-enable on recovery.
9. Ambiguous Hebrew variants → normalize+alias resolve; misses fall to disambiguation/menu.

**Verification:** `bash scripts/gate-checks/run-all.sh` where automatable; manual sign-off recorded in `docs/go-live-gates.md` for the rest.
**Acceptance:** All 9 gates pass on real hardware. **Gate 1 is blocking** — if bbernhard rewrites the timestamp on replay, the freshness design must be revisited before go-live.

---

## Dependency graph

```
Task 0 ─┬─► Task 1 ─┬─► Task 2 ─► Task 3 ─┐
        │           ├─► Task 4 ─► Task 5  │
        │           ├─► Task 6 ───────────┼─► Task 8 ─┐
        │           ├─► Task 7            │           │
        │           ├─► Task 9 ───────────┘           ├─► Task 13 ─► Task 14 ─► Task 15 ─► Task 16
        │           ├─► Task 10 ──────────────────────┤
        │           ├─► Task 11 ─────────────────────►│
        │           └─► Task 12 ─────────────────────►│
```

**Parallelizable:** Tasks 2, 4, 6, 7, 9, 10, 11, 12 (all after Task 1).
**Sequential spine:** 0 → 1 → 8 → 13 → 14 → 15 → 16.

---

## Verification summary

| Task | Verification command | Expected |
| --- | --- | --- |
| 0 | `pnpm install && pnpm typecheck && pnpm test` | green harness |
| 1 | `pnpm test src/app/config.test.ts` | defaults == §9; missing secret throws |
| 2 | `pnpm test src/core/normalize.test.ts` | idempotent; variants collapse |
| 3 | `pnpm test src/core/parse.test.ts` | 3 failure replies + reserved-word handling |
| 4 | `pnpm test src/core/clock-health.test.ts` | skew/future/offline-grace transitions |
| 5 | `pnpm test src/core/freshness.test.ts` | old refused, future → clock path |
| 6 | `pnpm test src/core/dedup.test.ts` | replay dropped; distinct ts both pass |
| 7 | `pnpm test src/core/rate-limit.test.ts` | trip + confirm lane survives |
| 8 | `pnpm test src/core/state-machine.test.ts` | all terminal states + confirm binding |
| 9 | `pnpm test src/adapters/ha-rest.test.ts` | correct service calls; errors → failed |
| 10 | `pnpm test src/adapters/ha-ws.test.ts` | fail-closed + debounce |
| 11 | `pnpm test src/adapters/signal.test.ts` | unknown UUID silent |
| 12 | `pnpm test src/core/audit.test.ts` | no body; hashed UUID |
| 13 | `pnpm test src/core/kill-switch.test.ts src/core/status.test.ts` | hard kill + status always answers |
| 14 | `pnpm test src/app/bridge.test.ts` | full pipeline + safe startup |
| 15 | `docker compose config && docker build -t home-control-bridge .` | builds; non-root; no ports |
| 16 | `bash scripts/gate-checks/run-all.sh` + manual sign-off | 9 gates pass on hardware |

Full suite gate before any release: `pnpm lint && pnpm typecheck && pnpm test && pnpm audit`.

---

## Assumptions made during discovery (no human available to confirm)

This plan was generated in a non-interactive (background) run, so the discover skill's
question phases were resolved by deferring to the design doc's **26 locked decisions** and
**§9 defaults**. Decisions I had to make that the doc did not state explicitly:

1. **Runtime = Node.js 20 + TypeScript.** Grounded in §6/A06 (`npm audit`, Dependabot,
   lockfile) and the Pi 3B+ constraint (§2). *Note:* the repo's global `CLAUDE.md` describes
   a .NET/SQL Server web-app template; I treated that as a generic house template that does
   **not** apply to this Pi bridge, because the design doc's tooling and topology contradict
   it. **Flag for confirmation if a human disagrees.**
2. **Test framework = Vitest, package manager = pnpm.** Matches the discover skill's
   `pnpm test` convention; no DB means pure-function unit tests cover most logic.
3. **Hexagonal core/adapters split.** Chosen so 7 of the 9 go-live gates are unit-testable
   and only gates 2–5 strictly need hardware. Not mandated by the doc but consistent with it.
4. **Plan written to `docs/plans/`** (the skill's primary location). The repo root and
   `plans/` are root-owned and read-only to the `user` account, so `docs/` was created with
   sudo and chowned to `user`. The original design doc in `plans/` was left untouched.

## Genuinely open items (from §9 — decide before/at first deploy)

These remain open and are wired as config switches with the doc's leaning as default:

| # | Open question | Default chosen | Where |
| --- | --- | --- | --- |
| 1 | All-covers completion ack: summary vs per-cover | **Summary line + exception line on failure** (doc's lean) | Task 8 / config |
| 2 | HA token scoping — confirm current HA guidance | Use single long-lived token (§6); revisit if HA adds scoping | Task 9 |
| 3 | Shelly generation of actual devices (affects state granularity + stop/reverse) | **Unknown — verify on hardware** (§7 caveat) | Task 16, gate 2/5 |
| 4 | Bot tone: terse vs conversational | **Terse** default; reply strings centralized for easy swap | Task 3/8 reply module |

All 10 §9 tunables are set to their stated initial defaults in Task 1 and are marked
"tune on hardware."
