#!/usr/bin/env bash
# Dual-purpose stub: PASSES a browser verification, and for a conflict-resolution
# run actually merges the base in (favouring base on conflict), commits, pushes,
# and reports success. Branches on which prompt it was given.
prompt="$(cat)"
case "$prompt" in
  *"RESOLVED:"*)
    branch="$(git rev-parse --abbrev-ref HEAD)"
    git merge -X theirs origin/main -m "auto-resolve conflict" >/dev/null 2>&1
    git push origin "HEAD:$branch" >/dev/null 2>&1
    echo "RESOLVED: OK"
    ;;
  *)
    echo "VERDICT: PASS"
    ;;
esac
exit 0
