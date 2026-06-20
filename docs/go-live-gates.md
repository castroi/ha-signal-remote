# Go-live gates — runbook (design §10)

**9 gates must pass on the real stack** (Pi 3B+ + Home Assistant + bbernhard
signal-cli-rest-api). These are empirical and cannot be pre-cleared by design or by
unit tests — they exercise real timing, real device behavior, and real reconnect
semantics. The unit suite (`pnpm test`) covers the *logic* behind gates 2–9; this
runbook is the *hardware* acceptance.

Run the automatable probes:

```sh
bash scripts/gate-checks/run-all.sh
```

Record manual sign-off in the table at the bottom.

---

## Gate 1 — Replay timestamp behavior (BLOCKING)

**Why blocking:** the entire stale-command defense rests on bbernhard's WS
preserving the *original* Signal envelope timestamp across a reconnect-replay. If it
rewrites the timestamp to "now" on replay, the freshness gate is silently defeated.

**Procedure:**
1. Send a command from an allowed sender.
2. Sever the bridge↔signal-cli WS for ~90s (longer than the freshness window).
3. Reconnect and capture the replayed envelope.
4. Inspect `envelope.timestamp`.

**Pass:** timestamp is the *original* (old) value → freshness gate works.
**Fail (blocking):** timestamp is rewritten to ~now → **revisit the freshness
design before go-live.** Probe: `scripts/gate-checks/gate1-replay-timestamp.sh`.

## Gate 2 — WS disconnect mid-travel

Start a cover moving, drop the HA state WS mid-travel. **Pass:** covers fail-closed,
no false success ack; the command resolves to `timeout`, never `observed_target`.

## Gate 3 — HA restart during a pending command

Restart HA while a cover command is pending; the bridge survives. **Pass:** the
command becomes `failed` (never issued) or `timeout` (issued, stream lost) after the
`ha_reconnect_decision_window` (30s), **no success ack**; covers stay disabled until
WS healthy for 10s (debounce).

## Gate 4 — Bridge restart during a pending command

Restart the bridge while a cover keeps moving. **Pass:** all RAM pending state
cleared, in-flight action abandoned (not resumed), "מעקב מצב אותחל מחדש" emitted once.

## Gate 5 — Kill switch during a pending command (hard kill)

Engage the kill switch mid-command. **Pass:** new commands blocked (guaranteed);
`cover.stop_cover` attempted on all in-flight covers (observed stop where the HA path
is healthy — best-effort); status/help still reply.

## Gate 6 — Duplicate Signal delivery

Force a duplicate delivery (same uuid + envelope ts + text). **Pass:** dedup drops
the replay — single action, single reply.

## Gate 7 — Rate-limit trip does not break a valid confirm

Trip the per-sender command cap, then send a legitimate `כן` for a live
pending_confirm. **Pass:** the confirm still resolves via the reserved confirm lane.

## Gate 8 — Clock skew / future timestamp → cover safe mode

Induce NTP skew past 30s **and** send a command with a future timestamp past the 10s
tolerance. **Pass:** both route covers to safe-mode, status warns with the reason,
covers re-enable on recovery. Probe: `scripts/gate-checks/gate8-clock-skew.sh`.

## Gate 9 — Ambiguous Hebrew variants

Send real-world phrasings (with/without ה article, niqqud, final-letter variants).
**Pass:** normalization + alias matching resolve them; genuine misses fall to the
correct disambiguation / menu path. Probe: `scripts/gate-checks/gate9-hebrew-variants.sh`
(runs the offline normalize+parse path against a table of real phrasings).

---

## Sign-off

| Gate | Type | Probe | Result | Signed off (who / date) |
| --- | --- | --- | --- | --- |
| 1 Replay timestamp (BLOCKING) | Manual + probe | gate1-replay-timestamp.sh | ☐ | |
| 2 WS disconnect mid-travel | Manual | — | ☐ | |
| 3 HA restart pending | Manual | — | ☐ | |
| 4 Bridge restart pending | Manual | — | ☐ | |
| 5 Kill switch pending | Manual | — | ☐ | |
| 6 Duplicate delivery | Manual | — | ☐ | |
| 7 Rate-limit + confirm | Manual | — | ☐ | |
| 8 Clock skew / future ts | Manual + probe | gate8-clock-skew.sh | ☐ | |
| 9 Ambiguous Hebrew | Probe (offline) | gate9-hebrew-variants.sh | ☐ | |

**Gate 1 is blocking.** Do not go live until it passes on real hardware.
