#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RUNNER_PATH="$SCRIPT_DIR/start-linear-trigger-server.sh"
ENV_FILE="$REPO_ROOT/.env"
SERVER_SCRIPT="$SCRIPT_DIR/linear-trigger-server.mjs"
BOT_JOBS_DIR="${LINEAR_TRIGGER_BOT_JOBS_DIR:-/Users/nursiddique/Projects/bot-jobs-linear}"
BOT_JOBS_ENTRY="${LINEAR_TRIGGER_BOT_JOBS_ENTRY:-bot-jobs.js}"
PORT="${LINEAR_TRIGGER_SERVER_PORT:-4817}"

LABEL="ai.betterletter.mailroomnavigator.linear-trigger-server"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
LOG_DIR="$REPO_ROOT/logs"
OUT_LOG="$LOG_DIR/linear-trigger-server-launchd.out.log"
ERR_LOG="$LOG_DIR/linear-trigger-server-launchd.err.log"

if [[ ! -x "$RUNNER_PATH" ]]; then
  echo "Runner script is missing or not executable: $RUNNER_PATH"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env file: $ENV_FILE"
  exit 1
fi

if [[ ! -f "$SERVER_SCRIPT" ]]; then
  echo "Missing server script: $SERVER_SCRIPT"
  exit 1
fi

if [[ ! -d "$BOT_JOBS_DIR" ]]; then
  echo "Missing bot-jobs-linear directory: $BOT_JOBS_DIR"
  exit 1
fi

if [[ ! -f "$BOT_JOBS_DIR/$BOT_JOBS_ENTRY" ]]; then
  echo "Missing bot-jobs entry script: $BOT_JOBS_DIR/$BOT_JOBS_ENTRY"
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${RUNNER_PATH}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
      <key>LINEAR_TRIGGER_ENV_FILE</key>
      <string>${ENV_FILE}</string>
      <key>LINEAR_TRIGGER_BOT_JOBS_DIR</key>
      <string>${BOT_JOBS_DIR}</string>
      <key>LINEAR_TRIGGER_BOT_JOBS_ENTRY</key>
      <string>${BOT_JOBS_ENTRY}</string>
      <key>LINEAR_TRIGGER_SERVER_PORT</key>
      <string>${PORT}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${OUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${ERR_LOG}</string>
  </dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/${LABEL}"

echo "Installed LaunchAgent: $PLIST_PATH"
echo "Linear trigger service URL: http://127.0.0.1:${PORT}"
