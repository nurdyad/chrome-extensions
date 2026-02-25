#!/usr/bin/env bash
set -euo pipefail

# Removes the global summary hotkey LaunchAgent and plist.

LABEL="ai.betterletter.mailroomnavigator.summary-hotkey"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl disable "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "Uninstalled global summary hotkey daemon."
