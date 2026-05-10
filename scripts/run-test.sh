#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RUNNER_DIR="$ROOT_DIR/runner"

TEST="${1}"
ENV="${2:-local}"
EXTRA_FLAGS=""

for arg in "$@"; do
  [ "$arg" = "--report" ] && EXTRA_FLAGS="$EXTRA_FLAGS --report"
  [ "$arg" = "--auto"   ] && EXTRA_FLAGS="$EXTRA_FLAGS --auto"
  [ "$arg" = "--junit"  ] && EXTRA_FLAGS="$EXTRA_FLAGS --junit"
  [ "$arg" = "--fresh"  ] && EXTRA_FLAGS="$EXTRA_FLAGS --fresh"
done

if [ -z "$TEST" ]; then
  echo "Usage: run-test.sh <path/to/test.yml> [environment] [--auto] [--report] [--junit]"
  echo ""
  echo "Exemplos:"
  echo "  run-test.sh auth/login-success.yml"
  echo "  run-test.sh auth/login-success.yml local --report --junit"
  echo ""
  echo "Testes disponíveis:"
  find "$ROOT_DIR/tests" -name "*.yml" | sed "s|$ROOT_DIR/tests/||" | sort
  exit 1
fi

cd "$RUNNER_DIR"
[ ! -d node_modules ] && npm install --silent

node runner.js "$TEST" "$ENV" $EXTRA_FLAGS
