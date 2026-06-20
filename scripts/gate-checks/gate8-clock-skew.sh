#!/usr/bin/env bash
# Gate 8 — clock skew / future timestamp -> cover safe mode. Requires real stack
# (ability to induce NTP skew and observe the bridge's status reply).
set -euo pipefail

echo "Gate 8 — clock skew / future timestamp -> cover safe mode"
echo

if [ -z "${HA_BASE_URL:-}" ]; then
  echo "SKIP: real HA stack not configured (set HA_BASE_URL)."
  echo "      Run on the real Pi: induce NTP skew > 30s AND send a future-dated"
  echo "      command; confirm covers enter safe-mode and status warns; confirm"
  echo "      covers re-enable on recovery. Record in docs/go-live-gates.md."
  exit 2
fi

cat <<'STEPS'
Procedure (manual, on the real stack):
  1. Induce system-clock skew > 30s (e.g. `sudo date -s ...` with NTP paused).
  2. Send a cover command -> expect refusal + status reason "clock skew".
  3. Send a command whose envelope timestamp is > 10s in the future -> same path.
  4. Restore the clock / NTP -> covers re-enable.

PASS -> covers safe-mode on skew AND on future timestamp; status warns; recovers.
STEPS
exit 0
