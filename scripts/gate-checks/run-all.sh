#!/usr/bin/env bash
# Go-live gate harness (design §10). Runs the automatable probes and reports which
# gates still require manual hardware sign-off.
#
# Exit codes:
#   0  all runnable probes passed (manual gates still pending sign-off)
#   1  a runnable probe FAILED
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

fail=0

echo "== Gate 9 (offline, automatable): Hebrew variants =="
if [ ! -d "$root/dist" ]; then
  echo "  building (pnpm build)..."
  (cd "$root" && pnpm build >/dev/null)
fi
if node "$here/gate9-hebrew-variants.mjs"; then
  echo "  Gate 9: PASS"
else
  echo "  Gate 9: FAIL"
  fail=1
fi
echo

echo "== Gate 1 (BLOCKING, hardware): replay timestamp =="
bash "$here/gate1-replay-timestamp.sh" || true
echo

echo "== Gate 8 (hardware): clock skew / future timestamp =="
bash "$here/gate8-clock-skew.sh" || true
echo

echo "== Manual gates (2,3,4,5,6,7): run on real hardware per docs/go-live-gates.md =="
echo "   These exercise live HA + signal-cli timing and cannot be automated here."
echo

if [ "$fail" -ne 0 ]; then
  echo "RESULT: a runnable probe FAILED."
  exit 1
fi
echo "RESULT: runnable probes passed. Gates 1-8 (hardware) + 2-7 require manual"
echo "        sign-off on the real Pi/HA/signal-cli stack before go-live."
exit 0
