#!/usr/bin/env bash
set -euo pipefail

# Wrapper used by LaunchAgent to start the local Linear trigger HTTP server.
# The server exposes localhost endpoints consumed by the extension button.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ENV_FILE="${LINEAR_TRIGGER_ENV_FILE:-$REPO_ROOT/.env}"
SERVER_SCRIPT="${LINEAR_TRIGGER_SERVER_SCRIPT:-$SCRIPT_DIR/linear-trigger-server.mjs}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

if [[ ! -f "$SERVER_SCRIPT" ]]; then
  echo "Missing trigger server script: $SERVER_SCRIPT"
  exit 1
fi

mkdir -p "$REPO_ROOT/logs" "$REPO_ROOT/.automation-state"

cd "$SCRIPT_DIR"
DOTENV_CONFIG_PATH="$ENV_FILE" node "$SERVER_SCRIPT"
