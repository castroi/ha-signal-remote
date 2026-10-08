# Status: Per-Device States Implementation Plan

**Goal:** `סטטוס` also reports the live state of every entity in the alias table — covers as a position percentage, lights/switches as on/off.

**Architecture:** A new `HaRestClient.getStates(ids)` issues one `GET /api/states/{id}` per configured entity in parallel (3s timeout) and returns strictly validated snapshots. The bridge wraps it in a single-flight + 3s cache so repeated `סטטוס` never fans out into concurrent HA reads. A pure `formatDevices()` in `core/status.ts` renders grouped Hebrew lines under the existing health line.

**Key decisions:**

- Per-entity reads (not the full `/api/states` dump): payload stays bounded by the alias table size regardless of how large HA grows (security review finding #1).
- Single-flight + 3s cache in the bridge: `סטטוס` bypasses the rate gate and envelopes are handled concurrently (`compose.ts` fire-and-forget), so without it N messages = N×entities HA requests.
- Cover shows live `current_position`; while moving, a `(נפתח…)` / `(נסגר…)` marker is appended.
- Existing health line kept on top, computed *before* any HA call; devices grouped below (covers, lights, switches) in config order, named by first alias (same as `helpText()`).
- Raw HA strings are never echoed — states map to fixed Hebrew words; anything else → `לא זמין`. HA unreachable → single line `מצב מכשירים לא זמין`.
- Read-only, so status stays answered in kill-switch / WS-down / clock-unhealthy. Allowlist gating is unchanged (enforced in `signal.ts` before `handleEnvelope`).
- Hebrew state words hardcoded, like the existing `formatStatus`. No config change.

---

## Output

```
מצב: WS תקין | שעון תקין | כיבוי חירום כבוי | תריסים פעילים

🪟 תריסים
גינה 20%
מטבח 45% (נפתח…)
סלון לא זמין

💡 אורות
חוץ דלוק

🔌 מתגים
מאוורר כבוי
שקע דלוק
```

| Type | HA state | Rendered |
|---|---|---|
| cover | `current_position` is an integer 0–100 | `{name} {pos}%` |
| cover | state `opening` / `closing` | append ` (נפתח…)` / ` (נסגר…)` |
| cover | `open` / `closed`, no valid position | `פתוח` / `סגור` |
| light, switch | `on` / `off` | `דלוק` / `כבוי` |
| any | absent, `unavailable`, `unknown`, any other string | `לא זמין` |

Empty groups are omitted.

---

## Tasks

### Task 1: `HaRestClient.getStates`

**Independent:** Yes
**Estimated scope:** Small (3 files)

**Files:**

- Modify: `src/core/status.ts` (add `EntitySnapshot` type)
- Modify: `src/adapters/ha-rest.ts` (add `getStates`)
- Test: `src/adapters/ha-rest.test.ts`

**Steps:**

1. Add to `src/core/status.ts`:
   ```ts
   export interface EntitySnapshot {
     readonly state: string;
     /** Covers only: attributes.current_position, when an integer 0–100. */
     readonly position?: number;
   }
   ```
2. Write failing tests in `ha-rest.test.ts` (`describe('getStates')`):
   - one GET per id to `{base}/api/states/{encodeURIComponent(id)}` with `authorization: Bearer <token>`
   - returns a Map keyed by id with `state` and `position`
   - drops an entry whose `state` is not a string; omits `position` unless it is an integer in 0–100 (test 150, -1, 20.5, NaN, `"20"`)
   - a single id failing (non-2xx / throw / non-JSON body) → that id absent, others present
   - every id failing → returns `undefined`
   - uses a 3s timeout (separate from the 10s used for service calls)
3. Run: `pnpm test src/adapters/ha-rest.test.ts` → Expect: FAIL (`getStates is not a function`)
4. Implement, mirroring `getCoverPosition` (AbortController, catch-all, never echo token/body/URL):
   ```ts
   async getStates(entityIds: readonly string[]): Promise<Map<string, EntitySnapshot> | undefined> {
     const results = await Promise.all(entityIds.map((id) => this.readState(id))); // 3s timeout each
     // collect defined results; return undefined if none succeeded
   }
   ```
5. Run: `pnpm test src/adapters/ha-rest.test.ts` → Expect: PASS

**Verification:** `pnpm test src/adapters/ha-rest.test.ts -t getStates`
**Acceptance criteria:**

- [ ] Tests exist and pass
- [ ] Strict type checks on `state` and `position`
- [ ] No token, response body, or URL in any error path

---

### Task 2: `formatDevices`

**Independent:** No (needs the `EntitySnapshot` type from Task 1 step 1)
**Estimated scope:** Small (2 files)

**Files:**

- Modify: `src/core/status.ts`
- Test: `src/core/status.test.ts`

**Steps:**

1. Write failing tests for `formatDevices(entities, snapshots)`, where `entities` is `readonly { name: string; type: EntityType; entityId: string }[]`:
   - cover 20 → `גינה 20%`; opening/closing markers; open/closed without position → `פתוח`/`סגור`
   - light/switch on/off → `דלוק`/`כבוי`
   - missing / `unavailable` / `unknown` / arbitrary string (e.g. `<script>`, `on\nfoo`) → `לא זמין`, and the raw string never appears in the output
   - group headers `🪟 תריסים` / `💡 אורות` / `🔌 מתגים`, empty groups omitted, config order kept
   - `snapshots === undefined` → `מצב מכשירים לא זמין`
2. Run: `pnpm test src/core/status.test.ts` → Expect: FAIL
3. Implement as a pure function returning the multi-line string.
4. Run: `pnpm test src/core/status.test.ts` → Expect: PASS

**Verification:** `pnpm test src/core/status.test.ts`
**Acceptance criteria:**

- [ ] All rendering rules in the table above are covered by tests
- [ ] Raw HA state strings are never rendered
- [ ] No HA/IO dependency in `core/status.ts`

---

### Task 3: Wire into the bridge (single-flight + cache)

**Independent:** No (after Tasks 1, 2)
**Estimated scope:** Medium (3–4 files)

**Files:**

- Modify: `src/app/bridge.ts` (`HaRestPort.getStates`, async `statusMessage`, snapshot cache, the `סטטוס` branch awaits it)
- Modify: `src/app/bridge.test.ts` (fake gains `getStates`; new cases)
- Modify: `src/app/compose.test.ts` (fake, if it implements `HaRestPort`)

**Steps:**

1. Write failing bridge tests:
   - the `סטטוס` reply is the health line + blank line + device section from the stubbed `getStates`
   - kill switch engaged → still replies with devices
   - `getStates` → `undefined` → reply contains the health line and `מצב מכשירים לא זמין`
   - `getStates` rejects/throws → health line still sent, devices line `מצב מכשירים לא זמין`
   - `getStates` is called with exactly the configured entity ids
   - **single-flight:** two concurrent `סטטוס` messages → `getStates` called once
   - **cache:** a second `סטטוס` within 3s (injected `now`) → no new call; after 3s → a new call
   - the audit entry is unchanged; no device state, token, or HA body in audit/log output on failure
2. Run: `pnpm test src/app/bridge.test.ts` → Expect: FAIL
3. Implement:
   - compute `formatStatus(...)` first (sync), then the device section in its own try/catch
   - `private deviceSnapshot()`: return a cached result if `now() - cachedAt < 3000`; else reuse an in-flight promise; else start `haRest.getStates(ids)`, store the promise, and clear it on settle
   - entities from `cfg.aliases.entities()`, name = first alias
4. Run: `pnpm test` → Expect: PASS

**Verification:** `pnpm typecheck && pnpm lint && pnpm test`
**Acceptance criteria:**

- [ ] Full suite, typecheck, and lint pass
- [ ] Status still answered under kill-switch / WS-down / HA-down
- [ ] Concurrent/back-to-back status never issues parallel HA reads
- [ ] Audit log carries no device state

---

### Task 4: Docs

**Independent:** No (after Task 3)
**Estimated scope:** Small (2 files)

**Files:**

- Modify: `README.md` (`סטטוס` row; security notes)
- Modify: `plans/home-control-bot-plan.md` (§6 threat model)

**Steps:**

1. Update the `סטטוס` row to mention per-device states.
2. Add a security note: `סטטוס` now reveals device states (and so occupancy patterns) to every allowlisted device; replies land in Signal history and notifications.

**Verification:** `pnpm lint` (no code change); manual read
**Acceptance criteria:**

- [ ] README and threat model mention the presence-disclosure trade-off

---

## Dependency Graph

```
Task 1 ──► Task 2 ──► Task 3 ──► Task 4
```

**Sequential:** all. Small enough that parallelizing isn't worth it.

---

## Verification Summary

| Task | Verification Command | Expected Output |
| ---- | -------------------- | --------------- |
| 1 | `pnpm test src/adapters/ha-rest.test.ts -t getStates` | All pass |
| 2 | `pnpm test src/core/status.test.ts` | All pass |
| 3 | `pnpm typecheck && pnpm lint && pnpm test` | Exit 0 |
| 4 | Manual read of README / threat model | Note present |
| E2E | Send `סטטוס` against the dev stack (`docs/dev-testing.md`) | Health line + device list |

---

## Security review (applied)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | Med | Full `/api/states` + concurrent un-rate-limited status → memory/HA amplification | Per-entity reads + single-flight + 3s cache (Tasks 1, 3) |
| 2 | Low | Untrusted HA JSON | Strict type checks; raw state never rendered (Tasks 1, 2) |
| 3 | Low | Error-path leakage | Health line first, device section in try/catch, no-leak tests (Task 3) |
| 4 | Low | Occupancy disclosure via device states | Documented (Task 4) |
| 5 | Low | Slow reply when HA is down | 3s per-read timeout (Task 1) |
