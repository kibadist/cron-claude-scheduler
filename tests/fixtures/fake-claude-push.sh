#!/usr/bin/env bash
set -euo pipefail
PROMPT=$(cat)
BRANCH=$(echo "$PROMPT" | grep -oE 'claude/[a-z0-9-]+' | head -1)
git checkout -b "$BRANCH"
echo "work done" > claude-output.txt
git add claude-output.txt
git commit -m "work for $BRANCH"
git push -u origin "$BRANCH"
echo "pushed $BRANCH"
