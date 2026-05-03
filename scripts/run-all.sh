#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${1:-local}"

echo "======================================"
echo " Kanasha API Tests — All Services"
echo " Environment: $ENV"
echo "======================================"

bash "$SCRIPT_DIR/run-authentication.sh" "$ENV"
bash "$SCRIPT_DIR/run-communication.sh" "$ENV"

echo ""
echo "All tests completed. Reports in reports/"
