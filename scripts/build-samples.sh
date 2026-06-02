#!/usr/bin/env bash
# Build a sample workspace through the editor's own CLI.
#
# Plan called for `node .../packages/cli/src/index.ts build .`, but that fails
# because packages/cli is an ESM TypeScript project whose `import` statements
# use `.js` extensions and whose bin points to `./dist/index.js`. We pick
# Option A from the task brief: run the TS source directly via `tsx` (already
# in @latte/cli's devDeps), so no prior `tsc` build is required.
#
# Usage: scripts/build-samples.sh [sample-dir]
#   sample-dir defaults to samples/minimal-ts

set -euo pipefail

# Resolve repo root (parent of this script's directory) so pnpm --filter
# resolves correctly regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SAMPLE_DIR="${1:-$REPO_ROOT/samples/minimal-ts}"
if [[ "$SAMPLE_DIR" != /* ]]; then
  SAMPLE_DIR="$REPO_ROOT/$SAMPLE_DIR"
fi

if [[ ! -d "$SAMPLE_DIR" ]]; then
  echo "error: sample directory not found: $SAMPLE_DIR" >&2
  exit 1
fi

cd "$REPO_ROOT"
pnpm --filter @latte/cli exec tsx src/index.ts build "$SAMPLE_DIR"
