#!/usr/bin/env bash
# Build piano-keys-module.tar.gz (extracts to piano-keys/) for Schwung Manager.
set -euo pipefail

ID="piano-keys"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${ROOT}/dist/${ID}"

rm -rf "${ROOT}/dist"
mkdir -p "${DIST}"
cp "${ROOT}/src/module.json" "${ROOT}/src/ui.js" "${ROOT}/src/help.json" "${DIST}/"
tar -czf "${ROOT}/dist/${ID}-module.tar.gz" -C "${ROOT}/dist" "${ID}"
echo "Built ${ROOT}/dist/${ID}-module.tar.gz"
