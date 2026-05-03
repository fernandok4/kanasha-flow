#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RUNNER_DIR="$ROOT_DIR/runner"

COLLECTION="${1}"
FOLDER="${2}"
REQUEST="${3}"
ENV="${4:-local}"

if [ -z "$COLLECTION" ] || [ -z "$FOLDER" ] || [ -z "$REQUEST" ]; then
  echo "Usage: run-request.sh <collection> <folder> <request> [environment]"
  echo ""
  echo "Collections disponíveis:"
  echo "  authentication-service"
  echo "  communication-service"
  echo ""
  echo "Para listar todos os requests disponíveis:"
  echo "  cd runner && node runner.js --list"
  exit 1
fi

cd "$RUNNER_DIR"
[ ! -d node_modules ] && npm install --silent

node runner.js --request "$COLLECTION" "$FOLDER" "$REQUEST" "$ENV"
