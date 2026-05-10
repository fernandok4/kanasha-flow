#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RUNNER_DIR="$ROOT_DIR/runner"

ENV="${1:-local}"
EXTRA_FLAGS=""

for arg in "$@"; do
  [ "$arg" = "--report" ] && EXTRA_FLAGS="$EXTRA_FLAGS --report"
  [ "$arg" = "--auto"   ] && EXTRA_FLAGS="$EXTRA_FLAGS --auto"
  [ "$arg" = "--junit"  ] && EXTRA_FLAGS="$EXTRA_FLAGS --junit"
  [ "$arg" = "--fresh"  ] && EXTRA_FLAGS="$EXTRA_FLAGS --fresh"
done

echo "======================================"
echo " Kanasha API Tests — All Tests"
echo " Environment: $ENV"
echo "======================================"

cd "$RUNNER_DIR"
[ ! -d node_modules ] && npm install --silent

node runner.js --all "$ENV" $EXTRA_FLAGS
