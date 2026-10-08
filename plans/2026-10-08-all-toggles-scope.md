# All-Toggles Scope (`כבה הכל` / `הדלק הכל`) Implementation Plan

**Goal:** `כבה הכל` / `הדלק הכל` turn off/on the configured lights and switches after a `כן`/`לא` confirm, with one summary reply — delivered after fixing command completion tracking that the feature (and `תריסים`, and single commands) depends on.

**Architecture:** Two PRs. PR 1 gives every command per-device outcomes resolved through one `settle()` path, seeds outcomes from a live state snapshot so devices already at their target count as done, and fixes the cancel/kill/cleanup paths. PR 2 adds an optional config-driven `all_toggles` scope that the parser recognizes only as the entire target and the bridge dispatches through the existing confirm flow (renamed `submitAll`).

**Key decisions:**

- Config-driven scope (not an HA scene/script): one device list (`aliases.yaml`) shared with status/help; per-device feedback; nothing to keep in sync in HA.
- Covers excluded from `הכל`; they keep `תריסים` and their gates.
- `off` = every light + switch. `on` = every light + only switches marked `all_on: true` (a remotely powered socket/fan is a physical hazard). Both confirm-gated.
- The scope word must be the **entire** target (`כבה הכל`, `הדלק את הכל`), never part of a longer phrase.
- `הכל` is refused while HA's WebSocket is down (no state tracking) — same as covers; no untracked mode.
- Dedicated limit for the scope: 1 per 60s per sender and globally (a third window in the existing `RateLimiter`).
- One tracking path for all commands (`settle()`); only the final reply differs: 1 device → today's replies, >1 → one summary with device names.

---

## Background: current defects (fixed in PR 1)

| # | Where | Defect |
|---|---|---|
| A1 | `state-machine.ts` `observeState` | First device to reach its target marks the whole command done and clears the others → `סגור תריסים` acks after the first cover. |
| A2 | `state-machine.ts` `tick` | First device past its deadline times out the whole command and clears the others. |
| A3 | `state-machine.ts` `preemptHolder` | A new command on one cover preempts the whole batch. |
| A4 | `state-machine.ts` `preemptHolder` | Lights/switches are never preempted → two issued records can track one light; `observeState`'s first match can settle the wrong one. |
| A5 | `state-machine.ts` `observeState` | Matches records where the device is no longer pending; duplicate events are not ignored. |
| G | issue path (all commands) | HA fires no `state_changed` when a device is already at the target, so `כבה גינה` on an already-off light (or `סגור תריסים` with closed covers) ends in `לא הגיב`. |
| B | `bridge.ts` `reply-confirm-prompt` | Prompt always says `לסגור`, even for `פתח תריסים`. |
| C | `bridge.ts` multi-cover issue | One `מבצע…` per cover. |
| D | `state-machine.ts` / `bridge.ts` | `issue-toggle` failure calls `markIssueFailed` (whole record); `decisionDeadline` is never set (dead code). |
| E | `bridge.ts` `לא` | Only clears the bridge binding; the record stays `pending_confirm` and `tick` replies `הפעולה נכשלה` ~20s after a cancel. |
| F | `state-machine.ts` `commands`, `bridge.ts` `replyTo` | Finished records are never deleted. |
| K | `bridge.ts` `engageKill` | Stops covers but never clears tracking; can stop covers that already finished. |

---

## PR 1 — command completion tracking

### Task 1: One `settle()` path with per-device outcomes

**Independent:** Yes
**Estimated scope:** Medium (2 files, large test file)

**Files:**

- Modify: `src/core/state-machine.ts`
- Test: `src/core/state-machine.test.ts`

**Steps:**

1. Write failing tests:
   - **A1** two devices: observing the first → no effect; the second → one `reply-summary { failed: [], timedOut: [] }`, state `observed_target`
   - **A2** device 1 observed, device 2 past deadline → one `reply-summary { timedOut: [dev2] }`; mixed deadlines keep the later device tracked
   - **A3** preempting one cover of a batch marks only it `preempted`; the others complete; it is not listed as failed
   - **A4** a new command on a light held by an issued batch marks it `preempted` in the batch (no stop effect); the next observation resolves the new command, not the batch
   - **A5** duplicate observe → no second effect; observe after the device timed out → no effect; only records with that device `pending` are matched
   - **G** `issue(rec, snapshot)` with a snapshot showing a device already at target → that device `done` before any deadline; all devices already at target → immediate resolution (single: `reply-success`; multi: summary)
   - **D** `markEntityIssueFailed` on one device → per-device `failed`; all devices fail → `reply-summary` with everyone failed (single-device: `reply-failed` as today)
   - every device preempted → state `preempted`, no `reply-summary` and no success
   - `cancelPendingConfirm` → no later `reply-failed` from `tick`
   - records in a terminal state are deleted by `tick` 10 minutes after `resolvedAt`; `tick` returns the pruned commandIds; pending/issued records are never pruned
   - `clearAll` during an issued batch → no effects ever emitted for it
   - `issuedCoverEntityIds` returns only covers still `pending`
   - existing single-device behaviour: the current tests pass unchanged
2. Run: `pnpm test src/core/state-machine.test.ts` → Expect: FAIL
3. Implement:
   ```ts
   type EntityOutcome = 'pending' | 'done' | 'failed' | 'timeout' | 'preempted';
   // CommandRecord += outcomes: Map<string, EntityOutcome>, resolvedAt?: number
   // Effect += { kind: 'reply-summary'; commandId; failed: string[]; timedOut: string[] }
   // settle(rec, entityId, outcome, effects): no-op unless outcomes.get(id) === 'pending';
   //   sets outcome, deletes the deadline; when none pending → resolve():
   //     all preempted → 'preempted' (no reply); all done|preempted → 'observed_target';
   //     any timeout → 'timeout'; else 'failed'; resolvedAt = now;
   //     reply: 1 entity → reply-success | reply-timeout(entityId) | reply-failed;
   //            >1 → one reply-summary.
   // issue(rec, effects, snapshot?: ReadonlyMap<string, EntitySnapshot>): seeds outcomes;
   //   a device already at target settles 'done' immediately.
   // Every path (observeState, tick completion, markEntityIssueFailed, preemptHolder)
   //   goes through settle(). Remove decisionDeadline and markIssueFailed.
   // tick(): also prunes terminal records older than 10 min; returns { effects, pruned }.
   ```
4. Run: `pnpm test src/core/state-machine.test.ts` → Expect: PASS

**Verification:** `pnpm test src/core/state-machine.test.ts`
**Acceptance criteria:**

- [ ] A1–A5, G, D, F each covered by a failing-then-passing test
- [ ] One resolution path; no `entities.length > 1` branching outside the reply choice
- [ ] Existing single-device tests pass unchanged

---

### Task 2: Bridge — snapshot, replies, cancel, kill, cleanup

**Independent:** No (after Task 1)
**Estimated scope:** Medium (2–3 files)

**Files:**

- Modify: `src/app/bridge.ts`
- Modify: `src/core/state-machine.ts` (`reply-confirm-prompt` carries `verb`; one `reply-progress` per issue)
- Test: `src/app/bridge.test.ts`

**Steps:**

1. Write failing bridge tests:
   - **G** `כבה גינה` on a light whose snapshot is already `off` → `בוצע` without waiting; `סגור תריסים` + `כן` with some covers already closed → those count as done
   - snapshot unavailable (`getStates` → undefined) → issue normally, no device pre-settled
   - **C** `סגור תריסים` → `כן` → exactly one `מבצע…`
   - summary texts: all done → `בוצע`; one timeout → `בוצע, חוץ מ: סלון (לא הגיב)`; one failed → `… (נכשל)`; all failed → `הפעולה נכשלה`; names are the first alias, never an entity_id
   - **B** prompt: `פתח תריסים` → `לפתוח את כל N התריסים? כן/לא`; `סגור` → `לסגור…`; `הרם` → `להרים…`; `הורד` → `להוריד…`
   - **D** a failing `issue-toggle` → per-device failure via `markEntityIssueFailed`
   - **E** `לא` → `בוטל`, and no `הפעולה נכשלה` afterwards
   - **K** `engageKill` during a batch → stops only still-pending covers; no later summary; `replyTo` and `pendingConfirm` cleared
   - **F** records pruned by `tick` are removed from `replyTo`
   - audit: summary logs `{ intent: 'completion', result: 'observed_target' | 'timeout' | 'failed', reasonCode: 'summary' }` plus one event per failed/timed-out entity (entity_id + reasonCode only)
2. Run: `pnpm test src/app/bridge.test.ts` → Expect: FAIL
3. Implement: the bridge fetches `getStates(ids)` right before issuing (single: in `dispatchCommand`; batch: in `handleConfirmReply` on `כן`) and passes it to `submit`/`confirm`; `runEffects` renders `reply-summary` via an id→first-alias lookup; `לא` calls `cancelPendingConfirm`; `engageKill` stops pending covers then calls `clearAll` and clears the maps; `tick`'s pruned ids are deleted from `replyTo`.
4. Run: `pnpm typecheck && pnpm lint && pnpm test` → Expect: PASS

**Verification:** `pnpm typecheck && pnpm lint && pnpm test`
**Acceptance criteria:**

- [ ] B, C, D, E, F, G, K covered by tests
- [ ] Full suite, typecheck, lint clean

---

## PR 2 — `הכל` scope (after PR 1 is merged)

### Task 3: Config — optional `all_toggles` scope and `all_on`

**Independent:** Yes (within PR 2)
**Estimated scope:** Small (3 files)

**Files:**

- Modify: `src/app/config.ts` (`RawAliasFile.scopes.all_toggles?`, per-entity `all_on?: boolean`, `AliasTable.allTogglesWord?`, `toggleEntityIds(verb: 'on' | 'off')`)
- Modify: `config/aliases.example.yaml` (scope block, `all_on` example, help line)
- Test: `src/app/config.test.ts` (+ fixtures under `src/app/__fixtures__/`)

**Steps:**

1. Write failing tests:
   - scope absent → `allTogglesWord` undefined (feature off)
   - scope present → normalized word (`הכל` → `כל`); `toggleEntityIds('off')` = every light + switch in config order; `toggleEntityIds('on')` = lights + switches with `all_on: true`; never covers
   - `all_on` on a cover or light rejected; non-boolean rejected
   - the word is rejected if it normalizes to: an entity alias, a verb variant or a prefix of / prefixed by one (`resolveVerb` prefix-matches), the `תריסים` word, a reserved word, or an empty / 1-character string
   - unknown keys under `scopes` rejected
   - `all_toggles` set with no lights or switches → rejected
2. Run: `pnpm test src/app/config.test.ts` → Expect: FAIL
3. Implement with the same fail-fast style as the reserved-alias check. `הכל` is **not** added to `RESERVED_WORDS`; the configured word is protected by the alias check instead.
4. Run: `pnpm test src/app/config.test.ts` → Expect: PASS

**Verification:** `pnpm test src/app/config.test.ts`

---

### Task 4: Parser — recognize the scope

**Independent:** No (after Task 3)
**Estimated scope:** Small (2 files)

**Files:**

- Modify: `src/core/parse.ts` (`Scope` += `{ type: 'all-toggles' }`; match only when `targetTokens` is exactly `[allTogglesWord]`; comment the deliberate asymmetry with `תריסים`, which matches anywhere in the target)
- Test: `src/core/parse.test.ts`

**Steps:**

1. Write failing tests:
   - `כבה הכל`, `הדלק את הכל`, `כבה כל` → `all-toggles` with the right verb
   - **negative:** `כבה את כל האורות`, `כבה את כל האורות בסלון`, `כבה סלון כל` → never `all-toggles`
   - `הכל` alone → `no-verb` (menu)
   - `פתח הכל` → `all-toggles` with verb `open` (rejected later by the bridge)
   - scope not configured → `entity-unknown`
2. Run: `pnpm test src/core/parse.test.ts` → Expect: FAIL
3. Implement.
4. Run: `pnpm test src/core/parse.test.ts` → Expect: PASS

**Verification:** `pnpm test src/core/parse.test.ts`

---

### Task 5: Bridge — dispatch, confirm, gates, limiter

**Independent:** No (after Tasks 1–4)
**Estimated scope:** Medium (3–4 files)

**Files:**

- Modify: `src/app/bridge.ts` (dispatch branch; scope-aware confirm re-check reading the scope from the record; supersede guard)
- Modify: `src/core/state-machine.ts` (rename `submitAllCovers` → `submitAll`, `verb: Verb`; record carries `scope` and the submitting envelope's timestamp)
- Modify: `src/core/rate-limit.ts` (third `SlidingWindow` pair for the scope: 1/60s per sender + global)
- Test: `src/app/bridge.test.ts`, `src/core/state-machine.test.ts`, `src/core/rate-limit.test.ts`

**Steps:**

1. Write failing tests:
   - `כבה הכל` → `לכבות את כל N האורות והמתגים? כן/לא`; `הדלק הכל` → `להדליק את כל N האורות והמתגים? כן/לא` (N = lights + `all_on` switches)
   - `כבה הכל` + `כן` → `turn_off` for every light + switch, nothing to covers; devices already off settle immediately; one `מבצע…`; summary
   - `הדלק הכל` + `כן` → `turn_on` for lights + `all_on` switches only
   - works while the clock is unhealthy
   - **WS down** → `הכל` refused with `אין כרגע מעקב מצב, נסה שוב בעוד רגע`, at submit and again at `כן`
   - kill switch engaged → refused; engaged between prompt and `כן` → `כן` refused
   - `פתח הכל` / `עצור הכל` / `הרם הכל` → `"הכל" עובד רק עם הדלק / כבה`, nothing issued, audited `rejected`/`unsupported-verb`
   - a second `הכל` within 60s (same sender, or another sender) → rate-limit reply, nothing prompted
   - a pending `תריסים` confirm superseded by `כבה הכל` and vice versa → audited `superseded`
   - **supersede guard:** after a supersede, a `כן` whose envelope timestamp is not later than the superseding command's envelope timestamp → `הבקשה השתנתה, שלח כן שוב`; a later `כן` confirms the new batch (both timestamps come from the sender's device)
   - `כן` from another sender does not confirm
2. Run: `pnpm test src/app/bridge.test.ts src/core` → Expect: FAIL
3. Implement.
4. Run: `pnpm typecheck && pnpm lint && pnpm test` → Expect: PASS

**Verification:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Task 6: Docs

**Independent:** No (after Task 5)
**Estimated scope:** Small (3 files)

**Files:**

- Modify: `README.md` (usage: `כבה הכל` / `הדלק הכל`; config: `scopes.all_toggles`, per-switch `all_on`)
- Modify: `src/app/config.ts` `DEFAULT_HELP_TEMPLATE` (line for the scope, dropped when not configured)
- Modify: `plans/home-control-bot-plan.md` §4/§6 (new scope; confirm-gated; refused when WS is down; `all_on` opt-in)

**Verification:** `pnpm test src/app/config.test.ts` (help text); manual read

---

## Security & code review (applied)

| # | Source | Finding | Resolution |
|---|---|---|---|
| S1 | Security High | `כל` inside sentences would expand to everything | Entire-target match + negative tests (Task 4) |
| S2 | Security Med | `הדלק הכל` powers socket/fan remotely | `all_on` opt-in; 1/60s scope limit (Tasks 3, 5) |
| S3 | Security Med | `כן` for a superseded prompt confirms the new batch | Same-device envelope-timestamp guard; scope from the record; `superseded` audit (Task 5) |
| S4 | Security Med | WS down → false timeouts | `הכל` refused while WS is down (Task 5) |
| S5 | Security Med | Whole-record failure paths, overlap, unbounded map, kill | A4, D, F, K (Tasks 1, 2) |
| S6 | Security Low | Config validation gaps | Reserved/empty/1-char/verb-prefix collisions, unknown keys (Task 3) |
| S7 | Security Low | Audit/PII | entity_id + reason codes only (Tasks 2, 5) |
| R-H1 | Code review High | Devices already at target never emit `state_changed` | Pre-issue snapshot via `getStates` (G; Tasks 1, 2) |
| R-H2 | Code review High | `observeState` matches settled records | Match only `pending`; `settle()` idempotent (A5) |
| R-M1 | Code review Med | Kill never clears tracking | K (Task 2) |
| R-M2 | Code review Med | `replyTo` never pruned | `tick` returns pruned ids (F) |
| R-M3 | Code review Med | Toggle failure path, dead `decisionDeadline` | D in PR 1 |
| R-M4 | Code review Med | Single/multi paths drift | One `settle()`; branch only on the reply |
| R-M5 | Code review Med | All-preempted batch undefined | State `preempted`, no reply |
| R-M6 | Code review Med | Supersede guard mixed clock domains | Compare two sender envelope timestamps |
| R-M7 | Code review Med | Untracked WS-down mode | Dropped; refuse instead (owner's choice) |
| R-L1 | Code review Low | `הכל` normalizes to `כל`; reserved-word side effects; verb prefixes | Not reserved; alias + verb-prefix validation; `כבה כל` documented |
| R-L3 | Code review Low | Limiter shape | Third window in `RateLimiter` |
| R-L4 | Code review Low | `לא` leaves a pending record → late failure reply | E (Task 2) |

---

## Dependency Graph

```
PR 1:  Task 1 ──► Task 2 ──► (merge, deploy)
PR 2:  Task 3 ──► Task 4 ──► Task 5 ──► Task 6 ──► (merge, deploy)
```

**Sequential:** all. PR 2 starts from `main` after PR 1 merges.

---

## Rollout (on the deployment host, with explicit approval at that step)

1. After PR 1 deploys: pull + restart; live test `סגור תריסים` → `כן` (one `מבצע…`, correct summary) and `כבה <light already off>` → immediate `בוצע`.
2. After PR 2 deploys: add to the deployed `config/aliases.yaml`:
   ```yaml
   scopes:
     all_toggles:
       word: "הכל"
   ```
   plus `all_on: true` on any switch the owner wants `הדלק הכל` to turn on, and a help line `"כבה הכל" / "הדלק הכל" — כל האורות והמתגים (כן/לא)`.
3. `docker compose pull home-control-bridge && docker compose up -d --no-deps home-control-bridge` (config is read at startup).
4. Live test: `כבה הכל` → prompt → `כן` → summary.

Without `all_toggles` in the config the new image adds no new command, so image and config can roll out separately.

---

## Verification Summary

| Task | Verification Command | Expected Output |
| ---- | -------------------- | --------------- |
| 1 | `pnpm test src/core/state-machine.test.ts` | All pass |
| 2 | `pnpm typecheck && pnpm lint && pnpm test` | Exit 0 |
| 3 | `pnpm test src/app/config.test.ts` | All pass |
| 4 | `pnpm test src/core/parse.test.ts` | All pass |
| 5 | `pnpm typecheck && pnpm lint && pnpm test` | Exit 0 |
| 6 | `pnpm test src/app/config.test.ts`; manual read | Pass; docs updated |
| Live | Rollout steps above | Prompt, then summary |
