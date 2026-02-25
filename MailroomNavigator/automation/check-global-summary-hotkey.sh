#!/usr/bin/env bash
set -euo pipefail

# Diagnostic helper for the global summary hotkey stack.
# It prints:
# 1) LaunchAgent state
# 2) hotkey daemon log tail
# 3) latest summary script log tail
# 4) launchd stdout/stderr tails

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LABEL="ai.betterletter.mailroomnavigator.summary-hotkey"
DAEMON_LOG="$REPO_ROOT/logs/summary-hotkey-daemon.log"
LAUNCHD_OUT_LOG="$REPO_ROOT/logs/summary-hotkey-launchd.out.log"
LAUNCHD_ERR_LOG="$REPO_ROOT/logs/summary-hotkey-launchd.err.log"
LIVE_LOG_GLOB="$REPO_ROOT/logs/live-summary-hotkey-"*.log

echo "=== Hotkey Agent Status ==="
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | sed -n '1,70p' || {
  echo "LaunchAgent not loaded: $LABEL"
  exit 1
}

echo
echo "=== Daemon Log (last 40) ==="
if [[ -f "$DAEMON_LOG" ]]; then
  tail -n 40 "$DAEMON_LOG"
else
  echo "No daemon log found at $DAEMON_LOG"
fi

echo
echo "=== Summary Script Log (latest, last 30) ==="
LATEST_LIVE_LOG="$(ls -1t $LIVE_LOG_GLOB 2>/dev/null | head -n 1 || true)"
if [[ -n "$LATEST_LIVE_LOG" && -f "$LATEST_LIVE_LOG" ]]; then
  echo "File: $LATEST_LIVE_LOG"
  grep -E '^\[|^SUMMARY=|^SUMMARY_JSON=|^SUMMARY_ERROR=' "$LATEST_LIVE_LOG" | tail -n 30 | sed -E 's/(.{220}).+/\1.../'
else
  echo "No live summary script log file found yet."
fi

echo
echo "=== launchd stdout/stderr (last 20) ==="
echo "--- stdout ---"
if [[ -f "$LAUNCHD_OUT_LOG" ]]; then
  tail -n 20 "$LAUNCHD_OUT_LOG"
else
  echo "No stdout log."
fi
echo "--- stderr ---"
if [[ -f "$LAUNCHD_ERR_LOG" ]]; then
  tail -n 20 "$LAUNCHD_ERR_LOG"
else
  echo "No stderr log."
fi
