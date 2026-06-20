#!/usr/bin/env bash
# Gate 1 (BLOCKING) — replay-timestamp behavior. Requires the real stack.
# This probe documents and partially guides the manual procedure; it cannot be
# fully automated because it depends on bbernhard's live WS reconnect-replay.
set -euo pipefail

echo "Gate 1 — replay timestamp behavior (BLOCKING)"
echo

missing=0
for v in SIGNAL_API_URL BOT_NUMBER; do
  if [ -z "${!v:-}" ]; then echo "  missing env: $v"; missing=1; fi
done
if [ "$missing" -ne 0 ]; then
  echo
  echo "SKIP: real signal-cli stack not configured (set SIGNAL_API_URL, BOT_NUMBER)."
  echo "      This gate MUST be run on the real Pi/signal-cli before go-live."
  exit 2
fi

cat <<'STEPS'
Procedure (manual, on the real stack):
  1. Send a command from an allowed sender; note the wall-clock time.
  2. Sever the bridge<->signal-cli WS for ~90s (stop the bridge container, or
     block the network path).
  3. Reconnect; capture the replayed envelope from the signal-cli receive stream.
  4. Inspect envelope.timestamp.

PASS  -> timestamp is the ORIGINAL (old) value  => freshness gate works.
FAIL  -> timestamp rewritten to ~now            => GATE DEFEATED (blocking).

Record the outcome in docs/go-live-gates.md.
STEPS
exit 0
