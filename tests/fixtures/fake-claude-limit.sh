#!/usr/bin/env bash
# Stub claude that hit the account's session limit (the exact CLI phrasing that
# must be recognised as a limit, not blamed on the ticket).
cat > /dev/null
echo "You've hit your session limit · resets 2pm (America/New_York)" >&2
exit 1
