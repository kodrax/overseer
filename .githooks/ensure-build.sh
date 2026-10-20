#!/bin/sh
# Shared by the git hooks: rebuilds dist when its sources changed. Never fails the git command.
root=$(git rev-parse --show-toplevel) || exit 0
if [ ! -d "$root/node_modules" ]; then
  echo "overseer: node_modules is missing, skipping the dist rebuild; run npm ci" >&2
  exit 0
fi
node "$root/scripts/ensure-build.mjs" || echo "overseer: dist rebuild failed; run npm run build" >&2
exit 0
