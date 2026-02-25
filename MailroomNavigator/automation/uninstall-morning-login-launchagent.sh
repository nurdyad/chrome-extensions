#!/usr/bin/env bash
set -euo pipefail

# Removes the morning-login LaunchAgent and plist.

LABEL="ai.betterletter.mailroomnavigator.morning-login"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "Uninstalled LaunchAgent: $PLIST_PATH"
