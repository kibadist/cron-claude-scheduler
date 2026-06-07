#!/usr/bin/env bash
set -euo pipefail
PROMPT=$(cat)
BRANCH=$(echo "$PROMPT" | grep -oE 'claude/[a-z0-9-]+' | head -1)
git checkout -b "$BRANCH"
echo "work done $(git rev-parse HEAD)" > claude-output.txt
git add claude-output.txt
git commit -m "work for $BRANCH"
# Mirrors the real prompt: replaces a previous attempt's branch when present.
git push --force-with-lease -u origin "$BRANCH"
echo "pushed $BRANCH"
