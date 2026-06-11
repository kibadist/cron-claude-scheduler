#!/usr/bin/env bash
# Stub claude: records the argv it was invoked with, then claims success.
cat > /dev/null
echo "args: $*"
exit 0
