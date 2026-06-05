#!/usr/bin/env bash
# Stub claude that hit the account's usage limit.
cat > /dev/null
echo "Claude usage limit reached. Your limit will reset at 6pm (UTC)." >&2
exit 1
