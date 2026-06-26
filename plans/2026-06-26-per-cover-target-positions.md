# Per-Cover Target Positions Implementation Plan

**Issue:** [#1](https://github.com/castroi/ha-signal-remote/issues/1) — support per-cover target positions
**Goal:** Let a user drive each cover to a configured intermediate position (not just full open/close) by speaking a dedicated "to-preset" verb, actuated through the household's own Home Assistant scripts, with completion verified by observed `current_position`.
**Architecture:** Add a second pair of cover verbs (`open_to` / `close_to`) alongside the existing full `open` / `close`. Full verbs keep today's native `cover.open_cover` / `close_cover` path unchanged. The preset verbs resolve a per-cover target position from `aliases.yaml`, run a bridge-side direction guard (live `GET /api/states` → `current_position`), and—if the move is real—call the user's `covers_up` / `covers_down` HA scripts with `{ entity_id: [...], position }`. Completion acks only when observed `current_position` is within a tolerance band of the target.

**Key decisions (locked with user):**

- **Option B grammar** — full vs preset is the user's runtime choice via *which word* they say; positions are **config**, never spoken numbers. The `verb + entity` grammar and "exact + prefix, no fuzzy" rule (design §2) stay intact.
- **Actuation = the user's HA scripts.** Bridge calls `script.covers_up` / `script.covers_down` via `POST /api/services/script/turn_on` with the list + position nested under `variables` (the safe form — keeps the `entity_id` list out of HA's target slot). Single cover = a one-element list; all-covers = the full list. Script entity names live in config. Chosen because the covers are script-driven (works without native position support) and reuses existing, working scripts.
- **Direction guard = bridge, via live position read.** Before firing a preset move the bridge does `GET /api/states/<entity_id>` and reads `attributes.current_position` (authoritative even after a restart clears RAM state). If the move would reverse direction or the cover is already within tolerance of the target, it replies a distinct "already there" message and does **not** fire. The HA script's own guard remains as belt-and-suspenders.
- **Completion = WS `current_position` within ±3%** (default; per-cover override allowed). Native full open/close keep string-state completion. Concurrency is safe because `state_changed` events are self-identifying per `entity_id`.
- **No-op reply is distinct** (e.g. `כבר במצב המבוקש`), so a correct refusal never looks like a failure/timeout. Exact Hebrew wording TBD by user.

---

## Direction-guard semantics (authoritative reference for Tasks 4–5)

Let `c` = live `current_position`, `t` = configured target, `tol` = tolerance %.

| Verb | Fire only if | Otherwise |
| --- | --- | --- |
| `open_to` (raise toward `t`) | `t - c > tol` | no-op reply |
| `close_to` (lower toward `t`) | `c - t > tol` | no-op reply |

- HA position convention: `0` = fully closed, `100` = fully open. `open` raises the number, `close` lowers it.
- If `attributes.current_position` is **missing** (cover reports no position): **fail-closed** — refuse with a "can't read position" reply, never fire blindly.
- Completion (both directions): ack when `|observed - t| <= tol`.

---

## Tasks

### Task 1: Surface `current_position` over the WebSocket

**Independent:** Yes
**Scope:** Small (2 files + test)

**Files:**
- Modify: `src/adapters/ha-ws.ts` — extend `StateChange` with `position?: number`; read `event.data.new_state.attributes.current_position` in `HaWsFrame` / `handle`.
- Modify: `src/adapters/ha-ws.test.ts`

**Steps:**
1. Failing test: a `state_changed` event whose `new_state.attributes.current_position = 42` produces `onStateChanged({ entityId, state, position: 42 })`; an event with no attribute yields `position: undefined`.
2. `pnpm test src/adapters/ha-ws.test.ts` → Expect FAIL.
3. Add `attributes?: { current_position?: number }` to the `new_state` frame type; include `position` in the emitted `StateChange`.
4. `pnpm test src/adapters/ha-ws.test.ts` → Expect PASS.

**Verification:** `pnpm test src/adapters/ha-ws.test.ts`
**Acceptance:** `StateChange.position` flows through; string-only events still emit with `position` undefined; no behavior change for existing consumers until Task 5.

---

### Task 2: Alias-table config — preset verbs, per-cover positions, script names, tolerance

**Independent:** Yes
**Scope:** Medium (2 files + test + example)

**Files:**
- Modify: `src/app/config.ts` — extend `Verb` union with `'open_to' | 'close_to'`; add optional `openPosition`, `closePosition`, `tolerancePercent` to `EntityDef`; add a `positionScripts` structure (`{ open: string; close: string; defaultTolerancePercent: number }`); parse a new `position_scripts:` block in `RawAliasFile` / `AliasTable`.
- Modify: `src/app/config.test.ts`
- Modify: `config/aliases.example.yaml` — add `open_to` / `close_to` verb rows (placeholder Hebrew words for the user to set), per-cover `open_position` / `close_position`, and a `position_scripts:` block.

**`aliases.yaml` shape added:**
```yaml
verbs:
  open_to:  ["<word>"]      # user fills in
  close_to: ["<word>"]      # user fills in
entities:
  salon:
    type: cover
    entity_id: cover.living_room
    completion_timeout_ms: 30000
    aliases: ["סלון"]
    open_position: 80        # optional; target for open_to
    close_position: 30       # optional; target for close_to
    tolerance_percent: 3     # optional per-cover override
position_scripts:
  open: script.covers_up
  close: script.covers_down
  default_tolerance_percent: 3
```

**Steps:**
1. Failing test: loading a table with the above resolves `open_to`/`close_to` verbs, exposes `salon.openPosition === 80` / `closePosition === 30`, and `positionScripts.open === 'script.covers_up'`; covers without position fields leave them `undefined`.
2. `pnpm test src/app/config.test.ts` → Expect FAIL.
3. Implement parsing; default `tolerance_percent` to `position_scripts.default_tolerance_percent` when per-cover unset; validate `position` 0–100 if present.
4. `pnpm test src/app/config.test.ts` → Expect PASS.

**Verification:** `pnpm test src/app/config.test.ts`
**Acceptance:** New verbs resolve; per-cover positions + tolerance parse with sane defaults; example file documents the shape; absent fields are `undefined` (full-only covers unaffected).

---

### Task 3: REST adapter — read position + call the position script

**Independent:** Yes
**Scope:** Small (2 files + test)

**Files:**
- Modify: `src/adapters/ha-rest.ts` — add `getCoverPosition(entityId): Promise<number | undefined>` (`GET /api/states/<entity_id>`, return `attributes.current_position`); add `callPositionScript(scriptEntityId, entityIds, position): Promise<HaCallResult>` (`POST /api/services/script/turn_on`, body `{ entity_id: scriptEntityId, variables: { entity_id: entityIds, position } }`).
- Modify: `src/adapters/ha-rest.test.ts`

**Steps:**
1. Failing tests: `getCoverPosition` returns the numeric attribute on 200, `undefined` on non-2xx/missing attribute; `callPositionScript` posts the exact `variables`-wrapped body and Bearer header, maps non-2xx → `{ ok: false, reason: 'failed' }`. Assert the token never appears in any returned error.
2. `pnpm test src/adapters/ha-rest.test.ts` → Expect FAIL.
3. Implement both methods reusing the existing AbortController/timeout pattern; never log body or token.
4. `pnpm test src/adapters/ha-rest.test.ts` → Expect PASS.

**Verification:** `pnpm test src/adapters/ha-rest.test.ts`
**Acceptance:** Position read and script call work; failures map to `failed`; security invariants (no token/body leakage) preserved.

---

### Task 4: State machine — position-aware target & tolerance completion

**Independent:** No — depends on Task 2 (verb types).
**Scope:** Medium (2 files + test)

**Files:**
- Modify: `src/core/state-machine.ts`
- Modify: `src/core/state-machine.test.ts`

**Design:**
- `SubmitArgs` / `SubmitAllArgs` accept an optional per-entity `target?: { position: number; tolerancePercent: number }`. The stored `verb` stays the base direction (`'open'`/`'close'`) for preempt/stop semantics; a present `target` flips completion to position mode.
- `CommandRecord` stores per-entity targets (keyed by `entityId`, like `completionDeadlines`).
- New effect `{ kind: 'issue-cover-position'; commandId; entityId; scriptDirection: 'open' | 'close'; position }` emitted instead of `issue-cover` when a target is present. Progress ack + per-entity timeout behave as today.
- `observeState(entityId, observedState, observedPosition?)`: for a position command, `reachesTarget` returns `|observedPosition - target.position| <= tolerance`; for a string command, unchanged.

**Steps:**
1. Failing tests: position command acks `reply-success` when observed position is within tolerance; stays pending (then `reply-timeout` on tick) when outside; tolerance edge (exactly `tol`) acks; native open/close completion unchanged; all-covers tracks N independent position targets.
2. `pnpm test src/core/state-machine.test.ts` → Expect FAIL.
3. Implement target storage, `issue-cover-position` emission, position branch in `reachesTarget`, threaded `observedPosition`.
4. `pnpm test src/core/state-machine.test.ts` → Expect PASS.

**Verification:** `pnpm test src/core/state-machine.test.ts`
**Acceptance:** Position completion within tolerance; out-of-band → timeout (never false success); native paths untouched; per-entity targets independent under concurrency.

---

### Task 5: Bridge wiring — guard, dispatch, effects, all-covers preset

**Independent:** No — depends on Tasks 1–4.
**Scope:** Medium (2 files + test)

**Files:**
- Modify: `src/app/bridge.ts`
- Modify: `src/app/bridge.test.ts`

**Changes:**
1. `HaRestPort` gains `getCoverPosition` + `callPositionScript`. `SignalSendPort` unchanged. Add `REPLY.alreadyThere` (placeholder Hebrew) and `REPLY.positionUnknown`; extend `REPLY.help` to mention the preset verbs.
2. `dispatchCommand` single-entity, preset verb (`open_to`/`close_to`) on a cover:
   - resolve target from `entity.openPosition` / `closePosition` (if unset for that direction → treat as full and fall through to the native path).
   - covers fail-closed gate (`coversEnabled`) as today.
   - `const c = await haRest.getCoverPosition(entityId)`; if `undefined` → `REPLY.positionUnknown`, audit `reason: position-unknown`, return.
   - apply the guard table; on no-op → `REPLY.alreadyThere`, audit `reason: noop-already-there`, return.
   - else `submit({ ..., verb: baseDirection, entity: ref, target: { position, tolerancePercent } })` → `runEffects`.
3. `runEffects`: handle `issue-cover-position` → `await haRest.callPositionScript(positionScripts[scriptDirection], [entityId], position)`; on `!ok` → `markEntityIssueFailed` (same as `issue-cover`).
4. `onStateChanged(entityId, state, position?)` threads `position` into `stateMachine.observeState`.
5. All-covers preset (`open_to`/`close_to` + `תריסים`): confirm-gated as today; on `כן`, group covers by their resolved target position and call `callPositionScript` once per distinct target (commonly one). Covers lacking a preset for that direction fall back to the native batch path. Track N completions via position tolerance.
6. Update `compose.ts` only if the port wiring signature changes (verify after Task 3).

**Steps:**
1. Failing tests: `open_to סלון` when below target fires the script and acks on in-tolerance position; when already within tolerance replies `alreadyThere` and never calls the script; `close_to` on a cover already more-closed than target → `alreadyThere`; missing `current_position` → `positionUnknown`; full `open`/`close` unchanged; all-covers preset confirm→fire→batch completion.
2. `pnpm test src/app/bridge.test.ts` → Expect FAIL.
3. Implement; keep audit reason codes (`noop-already-there`, `position-unknown`) privacy-safe (no raw body/token).
4. `pnpm test src/app/bridge.test.ts` → Expect PASS.

**Verification:** `pnpm test src/app/bridge.test.ts`
**Acceptance:** Preset moves actuate via script and ack on observed position; no-op and unknown-position reply distinctly; native paths and all existing gates (kill-switch, freshness, clock, WS fail-closed, rate-limit, dedup) unchanged.

---

### Task 6: Example config, docs, README

**Independent:** No — after Tasks 2 & 5.
**Scope:** Small (3 files)

**Files:**
- Modify: `config/aliases.example.yaml` (if not fully done in Task 2)
- Modify: `README.md` — add preset verbs to the Usage table and the alias-table example; note positions are config-driven and the no-op behavior.
- Modify: `docs/deploy.md` if it enumerates required HA entities (the `covers_up` / `covers_down` scripts must exist).

**Verification:** `pnpm lint` (markdown/code unaffected) + manual read.
**Acceptance:** A new reader can configure a preset cover from the docs alone.

---

## Dependency Graph

```
Task 1 (ha-ws)      ─┐
Task 2 (config)     ─┼─► Task 4 (state-machine) ─► Task 5 (bridge) ─► Task 6 (docs)
Task 3 (ha-rest)    ─┘
```

**Parallelizable:** Tasks 1, 2, 3 (then 4 after 2).
**Sequential:** Task 4 (after 2) → Task 5 (after 1,3,4) → Task 6.

---

## Verification Summary

| Task | Verification Command | Expected |
| --- | --- | --- |
| 1 | `pnpm test src/adapters/ha-ws.test.ts` | All pass |
| 2 | `pnpm test src/app/config.test.ts` | All pass |
| 3 | `pnpm test src/adapters/ha-rest.test.ts` | All pass |
| 4 | `pnpm test src/core/state-machine.test.ts` | All pass |
| 5 | `pnpm test src/app/bridge.test.ts` | All pass |
| all | `pnpm lint && pnpm typecheck && pnpm test && pnpm audit` | Release gate green |

---

## Open items for the user (non-blocking)

1. The actual **Hebrew words** for `open_to` / `close_to` (set in `aliases.yaml`).
2. Exact **Hebrew wording** of `REPLY.alreadyThere` and `REPLY.positionUnknown`.
3. Per-cover **`open_position` / `close_position`** values for each cover.
4. Confirm the `covers_up` / `covers_down` script `object_id`s match what's deployed in HA.
