#!/usr/bin/env bash
# Dual-purpose stub: PASSES a browser verification, but FAILS to resolve a merge
# conflict (pushes nothing, reports RESOLVED: FAIL).
prompt="$(cat)"
case "$prompt" in
  *"RESOLVED:"*)
    echo "RESOLVED: FAIL — could not resolve safely"
    ;;
  *)
    echo "VERDICT: PASS"
    ;;
esac
exit 0
