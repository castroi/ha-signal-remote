# Configurable Hebrew Help (עזרה) Command Implementation Plan

**Issue:** [#21](https://github.com/castroi/ha-signal-remote/issues/21) — configurable, device-aware help/menu
**Goal:** Make the `עזרה`/`תפריט` reply configurable from `config/aliases.yaml` and replace the dense one-line text with a grouped, scannable menu whose device list auto-fills from the alias table.
**Architecture:** Add an optional `messages.help` string to the alias YAML. `AliasTable` gains a `helpText()` renderer that fills `{rooms}`/`{lights}` placeholders from the configured cover/light entities and drops any line whose placeholder resolves to empty. The bridge's existing help handler calls `helpText()` instead of the hardcoded `REPLY.help`. A built-in `DEFAULT_HELP_TEMPLATE` is the fallback when the key is absent, so existing deployments keep working with no config change.

**Key decisions (locked with user):**

- **Approach B — template + auto-filled device list.** The configurable text lives in `aliases.yaml` (consistent with "add a device = one config row"), and `{rooms}`/`{lights}` are filled at render time from each entity's *first alias*, in config order — so the listed devices never drift from the alias table.
- **Emoji section anchors.** Grouped layout with blank-line separators and 🪟 / 📐 / 💡 / 🏠 / ℹ️ anchors, favouring concrete examples (`"סגור סלון"`) over grammar. Emojis sit at line starts so they survive RTL.
- **Empty placeholder ⇒ drop the line.** If `{rooms}` or `{lights}` resolves to empty (e.g. a deployment with no lights), the entire line containing that placeholder is removed — no dangling `אורות:` label or blank gap.
- **Non-breaking default.** `messages.help` is optional; absent ⇒ `DEFAULT_HELP_TEMPLATE`. Handler, audit (`result: 'help'`), and kill-switch safe-mode behavior are unchanged.
- **Scope guard.** Only the `help` message becomes configurable in this change. `REPLY.menu` (the "didn't understand" fallback) and all other replies stay hardcoded.

---

## Rendering semantics (authoritative reference for Task 1)

Given the template string and the alias table:

1. `{rooms}` → display names of all `cover` entities, `{lights}` → all `light` entities. Display name = `entity.aliases[0]`. Order = entity insertion order. Joined with ` · `.
2. Substitution is line-aware: for each line, if it contains a placeholder and that placeholder's resolved value is empty, **drop the whole line**; otherwise substitute in place.
3. A line with no placeholder is always kept verbatim (including intentional blank lines).
4. Unknown `{...}` tokens are left untouched (not treated as placeholders).

| Template line | rooms = `סלון · מטבח` | rooms = `` (none) |
| --- | --- | --- |
| `חדרים: {rooms}` | `חדרים: סלון · מטבח` | *(line dropped)* |
| `🪟 תריסים` | `🪟 תריסים` | `🪟 תריסים` |

---

## Tasks

### Task 1: `helpText()` renderer + `messages.help` parsing in `AliasTable`

**Independent:** Yes
**Scope:** Small (1 file + test)

**Files:**
- Modify: `src/app/config.ts` — add `DEFAULT_HELP_TEMPLATE`; add `messages?: { help?: string }` to `RawAliasFile`; store `helpTemplate` on `AliasTable`; add public `helpText()` and a private `displayNames(type)` helper.
- Modify: `src/app/config.test.ts`

**Steps:**
1. Failing tests (against `aliases.example.yaml` loaded via `loadAliasTable`):
   - `helpText()` with a template containing `חדרים: {rooms}` returns the line with cover display names joined by ` · ` in config order.
   - `{lights}` is filled with light display names.
   - A template line whose placeholder resolves to empty (build a small `AliasTable` from a raw object with no `light` entities) is **omitted** from the output; a non-placeholder line is kept.
   - When `messages.help` is absent, `helpText()` returns the rendered `DEFAULT_HELP_TEMPLATE` (assert a stable substring, e.g. `ℹ️` and `חדרים:`).
2. `pnpm test src/app/config.test.ts` → Expect FAIL (no `helpText`).
3. Implement:
   ```ts
   helpText(): string {
     const rooms = this.displayNames('cover').join(' · ');
     const lights = this.displayNames('light').join(' · ');
     return this.helpTemplate
       .split('\n')
       .filter((line) => !(line.includes('{rooms}') && rooms === '') &&
                         !(line.includes('{lights}') && lights === ''))
       .map((line) => line.split('{rooms}').join(rooms).split('{lights}').join(lights))
       .join('\n');
   }
   ```
   `displayNames(type)` iterates `this.entities.values()`, taking `aliases[0]` of each entity whose `type` matches.
4. `pnpm test src/app/config.test.ts` → Expect PASS.

**Verification:** `pnpm test src/app/config.test.ts`
**Acceptance:**
- [ ] `helpText()` fills both placeholders from the alias table in config order.
- [ ] Empty-placeholder lines are dropped; other lines (incl. blank) preserved.
- [ ] Missing `messages.help` falls back to `DEFAULT_HELP_TEMPLATE`.
- [ ] No TypeScript errors (`displayNames` narrows `aliases[0]` safely).

---

### Task 2: Wire the bridge help handler to `helpText()`

**Independent:** No — depends on Task 1.
**Scope:** Small (1 file + test)

**Files:**
- Modify: `src/app/bridge.ts` — remove the `help:` entry from the `REPLY` object; at the existing handler (`bridge.ts:220`) reply with `this.cfg.aliases.helpText()`.
- Modify: `src/app/bridge.test.ts` — update the help assertion (currently `startsWith('פקודות:')`).

**Steps:**
1. Update the failing test first: the existing test "answers עזרה/תפריט with the help menu" asserts `s.message.startsWith('פקודות:')`. Change it to assert the reply equals `testConfig().aliases.helpText()` (and still: 2 sends, no kill reply, no HA call, 2 audit `result: 'help'`). This keeps the audit/kill-switch coverage intact.
2. `pnpm test src/app/bridge.test.ts` → Expect FAIL (still sends old `REPLY.help`).
3. Replace `await this.reply(env, REPLY.help);` with `await this.reply(env, this.cfg.aliases.helpText());` and delete the now-unused `help` key from `REPLY`.
4. `pnpm test src/app/bridge.test.ts` → Expect PASS.

**Verification:** `pnpm test src/app/bridge.test.ts`
**Acceptance:**
- [ ] `עזרה` and `תפריט` both reply with `helpText()`.
- [ ] Still answered under kill-switch; still audited as `result: 'help'`; no HA action.
- [ ] No remaining reference to `REPLY.help`.

---

### Task 3: Ship the configurable template in the example YAML + README note

**Independent:** No — depends on Task 1 (placeholder contract) for the doc to be accurate.
**Scope:** Small (2 files, no tests)

**Files:**
- Modify: `config/aliases.example.yaml` — add a documented `messages.help` block with the emoji-anchored layout and concrete examples.
- Modify: `README.md` — under "Alias table", add a short note that help text is configurable via `messages.help` and auto-lists devices.

**Template to ship (example YAML):**
```yaml
# User-facing reply text. Edit freely — no code change needed.
# In `help`, {rooms} and {lights} are auto-filled from the entities above
# (first alias of each). A line whose placeholder resolves to empty is dropped.
messages:
  help: |
    🪟 תריסים
    "סגור סלון" · "פתח מטבח" · "עצור סלון"
    חדרים: {rooms}

    📐 מצב שמור
    "העלה סלון" / "הנמך סלון"

    💡 אורות
    "הדלק גינה" / "כבה גינה"
    אורות: {lights}

    🏠 כל התריסים
    שלח "תריסים", ואז כן / לא

    ℹ️ מצב המערכת
    שלח "סטטוס"
```

**Steps:**
1. Add the block to `config/aliases.example.yaml` (the config-test loads this file, so confirm Task 1/2 tests still pass after adding it).
2. Add the README note.
3. `pnpm test` → Expect PASS (full suite; the example file feeds `testConfig()`).

**Verification:** `pnpm test src/app/config.test.ts src/app/bridge.test.ts`
**Acceptance:**
- [ ] `aliases.example.yaml` parses and renders the grouped menu via `helpText()`.
- [ ] README documents `messages.help` and the auto-fill placeholders.
- [ ] The user's local (gitignored) `config/aliases.yaml` is **not** modified by this task.

---

## Dependency Graph

```
Task 1 (independent) ──► Task 2 ──► Task 3
```

**Parallelizable:** none (small, tightly coupled chain).
**Sequential:** Task 1 → Task 2 → Task 3.

---

## Verification Summary

| Task | Verification Command | Expected Output |
| --- | --- | --- |
| 1 | `pnpm test src/app/config.test.ts` | All tests pass |
| 2 | `pnpm test src/app/bridge.test.ts` | All tests pass |
| 3 | `pnpm test` | Full suite passes |
| all | `pnpm lint && pnpm typecheck && pnpm test` | Release gate green |

---

## Out of scope (YAGNI)

- Making `REPLY.menu` or any other reply configurable — only `help` this round.
- Per-room dynamic examples / templating beyond `{rooms}` and `{lights}`.
- Localization framework — the text is Hebrew, edited directly in YAML.
