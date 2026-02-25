#!/usr/bin/env bash
set -euo pipefail

# Installs a macOS LaunchAgent that runs the morning-login runner:
# - at user login (RunAtLoad)
# - every day at a selected clock time
#
# Usage:
#   ./install-morning-login-launchagent.sh [--hour 7] [--minute 0]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RUNNER_PATH="$SCRIPT_DIR/morning-login-runner.sh"
ENV_FILE="$REPO_ROOT/.env"
AUTH_SCRIPT_PATH="$SCRIPT_DIR/save-auth-local.mjs"
AUTH_STATE_FILE="$REPO_ROOT/.automation-state/storageState.mailroomnavigator.json"

LABEL="ai.betterletter.mailroomnavigator.morning-login"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
LOG_DIR="$REPO_ROOT/logs"
OUT_LOG="$LOG_DIR/morning-login-launchd.out.log"
ERR_LOG="$LOG_DIR/morning-login-launchd.err.log"

HOUR=7
MINUTE=0
INTERVAL_SECONDS="${MORNING_LOGIN_HEARTBEAT_SECONDS:-300}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hour)
      HOUR="$2"
      shift 2
      ;;
    --minute)
      MINUTE="$2"
      shift 2
      ;;
    --interval)
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: install-morning-login-launchagent.sh [--hour 7] [--minute 0] [--interval 300]
USAGE
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || (( INTERVAL_SECONDS <= 0 )); then
  echo "Invalid --interval value: $INTERVAL_SECONDS (must be a positive integer)."
  exit 1
fi

if [[ ! -x "$RUNNER_PATH" ]]; then
  echo "Runner script is missing or not executable: $RUNNER_PATH"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env file: $ENV_FILE"
  exit 1
fi

if [[ ! -f "$AUTH_SCRIPT_PATH" ]]; then
  echo "Missing local auth script: $AUTH_SCRIPT_PATH"
  exit 1
fi

if ! (
  cd "$SCRIPT_DIR"
  node --input-type=module -e 'await import("dotenv/config"); await import("playwright"); await import("imapflow");'
) >/dev/null 2>&1; then
  echo "Missing automation dependencies."
  echo "Run: cd \"$SCRIPT_DIR\" && npm install"
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
      <key>MORNING_LOGIN_ENV_FILE</key>
      <string>${ENV_FILE}</string>
      <key>MORNING_LOGIN_AUTH_SCRIPT_PATH</key>
      <string>${AUTH_SCRIPT_PATH}</string>
      <key>MORNING_LOGIN_AUTH_STATE_FILE</key>
      <string>${AUTH_STATE_FILE}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${HOUR}</integer>
      <key>Minute</key>
      <integer>${MINUTE}</integer>
    </dict>

    <key>StartInterval</key>
    <integer>${INTERVAL_SECONDS}</integer>

    <key>StandardOutPath</key>
    <string>${OUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${ERR_LOG}</string>
  </dict>
</plist>
PLIST

# Replace any existing loaded job with the new plist.
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/${LABEL}"

echo "Installed LaunchAgent: $PLIST_PATH"
echo "Daily schedule: $(printf '%02d:%02d' "$HOUR" "$MINUTE")"
echo "Run once now for verification:"
echo "  /bin/bash \"$RUNNER_PATH\" --force"
