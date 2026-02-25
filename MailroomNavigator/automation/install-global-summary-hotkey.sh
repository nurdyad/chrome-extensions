#!/usr/bin/env bash
set -euo pipefail

# Installs the macOS LaunchAgent that runs the global hotkey daemon.
# Hotkeys:
# - Cmd+Shift+9 (primary)
# - Cmd+Ctrl+9 (fallback)
# The daemon triggers a live BetterLetter dashboard summary notification.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LABEL="ai.betterletter.mailroomnavigator.summary-hotkey"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"

STATE_DIR="$REPO_ROOT/.automation-state"
BIN_DIR="$STATE_DIR/bin"
LOG_DIR="$REPO_ROOT/logs"

SOURCE_FILE="$SCRIPT_DIR/global-summary-hotkey.m"
HOTKEY_BINARY="$BIN_DIR/mailroom-summary-hotkey"
SUMMARY_SCRIPT="$SCRIPT_DIR/show-live-summary-notification.sh"
DAEMON_OUT_LOG="$LOG_DIR/summary-hotkey-launchd.out.log"
DAEMON_ERR_LOG="$LOG_DIR/summary-hotkey-launchd.err.log"
DAEMON_LOG="$LOG_DIR/summary-hotkey-daemon.log"
COOLDOWN_SECONDS="${MAILROOM_HOTKEY_COOLDOWN_SECONDS:-2.0}"

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Missing source file: $SOURCE_FILE"
  exit 1
fi

if [[ ! -f "$SUMMARY_SCRIPT" ]]; then
  echo "Missing summary script: $SUMMARY_SCRIPT"
  exit 1
fi

if ! command -v clang >/dev/null 2>&1; then
  echo "clang not found. Install Xcode command line tools."
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR" "$BIN_DIR" "$LOG_DIR"
chmod +x "$SUMMARY_SCRIPT"

echo "Compiling global hotkey daemon..."
clang -fobjc-arc -framework Foundation -framework AppKit -framework Carbon "$SOURCE_FILE" -o "$HOTKEY_BINARY"
chmod +x "$HOTKEY_BINARY"

cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${HOTKEY_BINARY}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
      <key>MAILROOM_HOTKEY_SCRIPT_PATH</key>
      <string>${SUMMARY_SCRIPT}</string>
      <key>MAILROOM_HOTKEY_DAEMON_LOG</key>
      <string>${DAEMON_LOG}</string>
      <key>MAILROOM_HOTKEY_COOLDOWN_SECONDS</key>
      <string>${COOLDOWN_SECONDS}</string>
      <key>MORNING_LOGIN_ENV_FILE</key>
      <string>${REPO_ROOT}/.env</string>
      <key>MORNING_LOGIN_AUTH_STATE_FILE</key>
      <string>${REPO_ROOT}/.automation-state/storageState.mailroomnavigator.json</string>
    </dict>

    <key>LimitLoadToSessionType</key>
    <array>
      <string>Aqua</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${DAEMON_OUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${DAEMON_ERR_LOG}</string>
  </dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/${LABEL}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "Installed global hotkey daemon."
echo "Shortcuts: Cmd+Shift+9 (primary), Cmd+Ctrl+9 (fallback)"
echo "Summary script: $SUMMARY_SCRIPT"
echo "Daemon log: $DAEMON_LOG"
