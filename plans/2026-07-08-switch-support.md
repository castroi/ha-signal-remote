# HA Switch Entity Type Implementation Plan

**Issue:** [#25](https://github.com/castroi/ha-signal-remote/issues/25) — support the HA `switch` entity type
**Goal:** Control HA `switch` entities (fans, smart sockets) over Signal with the existing on/off Hebrew verbs, behaving exactly like lights.
**Architecture:** Add `'switch'` as a first-class `EntityType`. Switches ride the existing light pipeline end to end — the state machine's light branch becomes a shared *toggle* branch whose effect carries the HA service domain (`'light' | 'switch'`), and the REST adapter maps it to `POST /api/services/{domain}/turn_on|turn_off`. No parser, gate, or state-machine-logic changes.

**Key decisions (locked with user):**

- **Safety model = identical to lights.** Single-stage reply, completion via observed `state_changed` (`on`/`off`) with the per-entity timeout, never gated by clock-health or WS fail-closed (those are cover-only by design §5), blocked by the kill switch like all commands. No confirmation prompt.
- **Verbs = the existing `on`/`off` sets** (`הדלק`/`כבה` + variants). No new verbs, no parser change.
- **Help = new `{switches}` placeholder**, symmetric with `{lights}`: filled from the first alias of each `type: switch` entity in config order; a line whose placeholder resolves to empty is dropped, so deployments without switches render byte-identical help.
- **Explicit domain over inference (Option A).** The effect/adapter carry a typed domain from `entity.type` rather than parsing the `entity_id` prefix — matches the codebase's explicit-union style and keeps audit/test vocabulary truthful.
- **Sample names only in committed files.** This plan, the example alias table, and the dev stack use generic sample entities (`switch.fan` "מאוורר", `switch.garden_socket` "שקע"). Real household entity ids and aliases are configured only in the local, untracked `config/aliases.yaml`.

---

## Behavior reference

| Aspect | Switch behavior |
| --- | --- |
| HA command | `POST /api/services/switch/turn_on` / `turn_off`, body `{ "entity_id": "<id>" }` |
| Completion | Observed `state_changed` to `on`/`off` (HA switch states match the verb names — `reachesTarget` already handles them) |
| Timeout | Per-entity `completion_timeout_ms` (example: 5000, like `light.garden`) → honest timeout reply |
| WS down / clock unhealthy | Still operable (like lights); covers-only gates untouched |
| Kill switch | Blocked (all new commands are) |
| All-covers scope (`תריסים`) | Never includes switches (expands by `type === 'cover'`) |
| Preemption / progress ack / preset positions | Not applicable — all branch on `type === 'cover'` |

---

## Tasks

### Task 1: Config — `switch` entity type + `{switches}` help placeholder

**Independent:** Yes
**Scope:** Medium (3 files)

**Files:**
- Modify: `src/app/config.ts` — `EntityType = 'cover' | 'light' | 'switch'`; `helpText()` fills `{switches}` from `displayNames('switch')` and drops its line when empty; `DEFAULT_HELP_TEMPLATE` gains a `🔌 מתגים — "הדלק" / "כבה" + שם` + `מתגים: {switches}` section.
- Modify: `src/app/config.test.ts`
- Modify: `config/aliases.example.yaml` — sample switch entities + `{switches}` section in `messages.help`:

```yaml
  fan:
    type: switch
    entity_id: switch.fan
    completion_timeout_ms: 5000
    aliases: ["מאוורר"]
  garden_socket:
    type: switch
    entity_id: switch.garden_socket
    completion_timeout_ms: 5000
    aliases: ["שקע"]
```

**Steps:**
1. Failing tests: a table with a `type: switch` entity loads and `resolveEntity('מאוורר')` returns it with `type === 'switch'`; `helpText()` fills `{switches}` with `מאוורר · שקע`; a table with no switches drops the `{switches}` line entirely; reserved words still rejected as aliases.
2. `pnpm test src/app/config.test.ts` → Expect FAIL.
3. Implement; keep position-field validation cover-only (unchanged code path).
4. `pnpm test src/app/config.test.ts` → Expect PASS.

**Verification:** `pnpm test src/app/config.test.ts`
**Acceptance:** Switch entities parse; `{switches}` renders and drops-when-empty; existing tables (no switches) produce identical help output.

---

### Task 2: State machine — `switch` in `EntityRef`, generalized toggle effect

**Independent:** Yes
**Scope:** Small (2 files)

**Files:**
- Modify: `src/core/state-machine.ts` — `EntityRef.type` gains `'switch'`; rename `LightVerb` → `ToggleVerb` (same `'on' | 'off'`); replace the `issue-light` effect with `{ kind: 'issue-toggle'; commandId; entityId; domain: 'light' | 'switch'; verb: ToggleVerb }`, `domain` taken from `entity.type` in the non-cover issue branch.
- Modify: `src/core/state-machine.test.ts`

**Steps:**
1. Failing tests: submitting a `switch`-type entity with verb `on` emits `issue-toggle` with `domain: 'switch'`; a light emits `domain: 'light'`; switch completion acks on observed `'on'`/`'off'` (existing `reachesTarget` cases); a switch never receives `reply-progress`; cover preemption ignores an in-flight switch on cover state changes (existing `type === 'cover'` filter).
2. `pnpm test src/core/state-machine.test.ts` → Expect FAIL.
3. Implement the rename + effect generalization; update existing light-effect assertions.
4. `pnpm test src/core/state-machine.test.ts` → Expect PASS.

**Verification:** `pnpm test src/core/state-machine.test.ts`
**Acceptance:** Toggle effect carries the right domain per type; light behavior byte-identical apart from the effect shape; no cover semantics leak onto switches.

---

### Task 3: REST adapter — `callToggle(domain, entityId, verb)`

**Independent:** No — depends on Task 2 (`ToggleVerb` type).
**Scope:** Small (2 files)

**Files:**
- Modify: `src/adapters/ha-rest.ts` — replace `callLight` with `callToggle(domain: 'light' | 'switch', entityId, verb)` → `callService(domain, TOGGLE_SERVICE[verb], entityId)` (rename `LIGHT_SERVICE` → `TOGGLE_SERVICE`, same map); re-export `ToggleVerb`.
- Modify: `src/adapters/ha-rest.test.ts`

**Steps:**
1. Failing tests: `callToggle('switch', 'switch.fan', 'on')` posts `/api/services/switch/turn_on` with `{ entity_id: 'switch.fan' }` and the Bearer header; `callToggle('light', …, 'off')` posts `/api/services/light/turn_off`; non-2xx → `{ ok: false, reason: 'failed' }`; token never appears in results.
2. `pnpm test src/adapters/ha-rest.test.ts` → Expect FAIL.
3. Implement; no change to timeout/error/secret-hygiene invariants.
4. `pnpm test src/adapters/ha-rest.test.ts` → Expect PASS.

**Verification:** `pnpm test src/adapters/ha-rest.test.ts`
**Acceptance:** Correct domain/service per call; failures map to `failed`; no token/body leakage.

---

### Task 4: Bridge wiring — `issue-toggle` effect + end-to-end switch flow

**Independent:** No — depends on Tasks 1–3.
**Scope:** Small–Medium (2–3 files)

**Files:**
- Modify: `src/app/bridge.ts` — `runEffects` handles `issue-toggle` via `haRest.callToggle(e.domain, e.entityId, e.verb)` (replacing the `issue-light` case); `HaRestPort` signature updated. Dispatch needs no new branches — switches fall through the existing non-cover path.
- Modify: `src/app/bridge.test.ts`
- Modify (only if port signatures ripple): `src/app/compose.ts`

**Steps:**
1. Failing tests: `הדלק מאוורר` from an allowlisted sender calls `callToggle('switch', 'switch.fan', 'on')` and replies success after an observed `on` state change; `כבה שקע` → `turn_off`/`off`; a switch command while the HA WS is down (covers disabled) still issues; kill switch blocks it; failed HA call → `reply-failed`, no false ack; `עזרה` reply lists the switches.
2. `pnpm test src/app/bridge.test.ts` → Expect FAIL.
3. Implement; audit entries keep the existing shape (`intent`, `entity`, result codes — no new vocabulary needed).
4. `pnpm test src/app/bridge.test.ts` → Expect PASS.

**Verification:** `pnpm test src/app/bridge.test.ts`
**Acceptance:** Full pipeline drives a switch on/off with truthful acks; cover gates demonstrably do not block switches; all existing gates (allowlist, freshness, dedup, rate-limit, kill switch) apply unchanged.

---

### Task 5: Dev stack — simulated switches

**Independent:** No — after Task 1 (the dev bridge mounts `config/aliases.example.yaml` as its alias table, so the sample entity ids must match).
**Scope:** Small (2 files)

**Files:**
- Modify: `dev/homeassistant/configuration.yaml` — two `input_boolean`s (`fan`, `garden_socket`) + modern `template: - switch:` entities whose names slugify to `switch.fan` / `switch.garden_socket`, mirroring the garden-light template (instant `on`/`off` state from the backing boolean).
- Modify: `docs/dev-testing.md` — add the switches to the simulated-entities list; add a smoke line (`הדלק מאוורר` → single `בוצע`-style reply).

**Steps:**
1. Add the template switches + booleans.
2. `docker compose -f docker-compose.dev.yml up -d homeassistant mock-signal` then `--profile bridge up -d --build bridge`.
3. Inject `הדלק מאוורר` via the mock (`POST /inject`), confirm a single success reply in `GET /sent` and `switch.fan` state `on` in HA.

**Verification:** dev-stack smoke above (requires Docker; not part of `pnpm test`).
**Acceptance:** Switch round-trip works against real HA state_changed events; help reply lists the sample switches.

---

### Task 6: Docs — README

**Independent:** No — after Tasks 1 & 4.
**Scope:** Small (1 file)

**Files:**
- Modify: `README.md` — intro line ("cover/light" → "cover/light/switch"), HA-command list (`switch.turn_on/turn_off`), alias-table example (sample switch row), Usage note that `הדלק`/`כבה` drive lights and switches, safety table note that lights **and switches** are unaffected by clock/WS state, `{switches}` in the help-text paragraph.

**Verification:** `pnpm lint` + manual read.
**Acceptance:** A new reader can configure a switch from the docs alone; no real household names anywhere.

---

## Dependency Graph

```
Task 1 (config)        ──┐
Task 2 (state machine) ──┼─► Task 4 (bridge) ──► Task 6 (README)
  └─► Task 3 (ha-rest) ──┘
Task 1 ──► Task 5 (dev stack)
```

**Parallelizable:** Tasks 1, 2 (then 3 after 2).
**Sequential:** Task 4 (after 1–3) → Tasks 5, 6.

---

## Verification Summary

| Task | Verification Command | Expected |
| --- | --- | --- |
| 1 | `pnpm test src/app/config.test.ts` | All pass |
| 2 | `pnpm test src/core/state-machine.test.ts` | All pass |
| 3 | `pnpm test src/adapters/ha-rest.test.ts` | All pass |
| 4 | `pnpm test src/app/bridge.test.ts` | All pass |
| 5 | dev-stack smoke (`docs/dev-testing.md`) | switch round-trip + help |
| all | `pnpm lint && pnpm typecheck && pnpm test && pnpm audit` | Release gate green |

---

## Open items for the user (non-blocking)

1. Add the **real** switch entity ids and Hebrew aliases to the local, untracked `config/aliases.yaml` (and a `🔌` section to its `messages.help`) at deploy time.
2. Confirm the real devices report plain `on`/`off` states in HA (standard for the `switch` domain).
