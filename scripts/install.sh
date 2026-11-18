#!/usr/bin/env bash
# Install the module onto a Move running Schwung (default host: move.local).
set -euo pipefail

HOST="${1:-move.local}"
ID="piano-keys"
DEST="/data/UserData/schwung/modules/overtake/${ID}"
SRC="$(cd "$(dirname "$0")/../src" && pwd)"

ssh "ableton@${HOST}" "mkdir -p '${DEST}'"
scp "${SRC}/module.json" "${SRC}/ui.js" "ableton@${HOST}:${DEST}/"
echo "Installed to ${HOST}:${DEST} - restart Schwung or rescan modules."
