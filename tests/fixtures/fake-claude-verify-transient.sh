#!/usr/bin/env bash
# Stub claude verifier: the environment hiccupped (dev server unreachable).
# Exits 0 with no VERDICT line; the transient signal is in the log text, which
# classifyFailure reads to route this to a cooldown instead of a real failure.
cat > /dev/null
echo "navigating to http://localhost:3000 ..."
echo "Error: connect ECONNREFUSED 127.0.0.1:3000 — the dev server did not start"
exit 0
