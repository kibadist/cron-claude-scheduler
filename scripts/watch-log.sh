#!/usr/bin/env bash
# Live view of Claude's work: tails the most recent per-ticket run log and
# switches automatically when a new run starts. Run alongside `npm run tick`,
# `npm run loop`, or the launchd agent. Ctrl-C to stop.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p logs

current=""
tail_pid=""

cleanup() {
  [[ -n "$tail_pid" ]] && kill "$tail_pid" 2>/dev/null || true
}
trap cleanup EXIT

echo "watching logs/ for ticket run logs (Ctrl-C to stop)..."
while true; do
  newest="$(ls -t logs/*.log 2>/dev/null | grep -v 'launchd\.log$' | head -1 || true)"
  if [[ -n "$newest" && "$newest" != "$current" ]]; then
    cleanup
    current="$newest"
    echo ""
    echo "==> $current"
    tail -n +1 -f "$current" &
    tail_pid=$!
    disown "$tail_pid" # suppress bash's "Terminated" notice when we switch logs
  fi
  sleep 1
done
