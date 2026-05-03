#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(dirname "$SCRIPT_DIR")/runner"

KEY="${1}"
VALUE="${2}"

if [ -z "$KEY" ]; then
  echo "Usage:"
  echo "  set-var.sh <key> <value>   ← setar uma variável"
  echo "  set-var.sh --get [key]     ← ver o estado atual"
  echo ""
  echo "Exemplos:"
  echo "  set-var.sh targetUserId abc123-..."
  echo "  set-var.sh userEmail outro@email.com"
  echo "  set-var.sh --get"
  echo "  set-var.sh --get targetUserId"
  exit 1
fi

cd "$RUNNER_DIR"
[ ! -d node_modules ] && npm install --silent

if [ "$KEY" = "--get" ]; then
  node runner.js --get "$VALUE"
else
  node runner.js --set "$KEY" "$VALUE"
fi
