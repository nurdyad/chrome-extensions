#!/usr/bin/env bash
set -u

LABEL="ai.betterletter.mailroomnavigator.linear-trigger-server"
PORT="${LINEAR_TRIGGER_SERVER_PORT:-4817}"
HOST="${LINEAR_TRIGGER_SERVER_HOST:-127.0.0.1}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$REPO_ROOT/logs"

echo "== MailroomNavigator Linear Trigger Service =="
echo "Service: $LABEL"
echo "URL: http://${HOST}:${PORT}/health"
echo

echo "== LaunchAgent =="
if [[ -f "$PLIST_PATH" ]]; then
  echo "Installed: $PLIST_PATH"
else
  echo "Missing LaunchAgent plist: $PLIST_PATH"
fi
launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | sed -n '1,90p' || {
  echo "LaunchAgent is not loaded."
}
echo

echo "== Listening Socket =="
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || {
  echo "Nothing is listening on TCP port $PORT."
}
echo

echo "== Health =="
curl -sS --max-time 5 "http://${HOST}:${PORT}/health" 2>&1 || true
echo
echo

echo "== Recent Logs =="
tail -n 80 \
  "$LOG_DIR/linear-trigger-server.log" \
  "$LOG_DIR/linear-trigger-server-launchd.out.log" \
  "$LOG_DIR/linear-trigger-server-launchd.err.log" \
  2>/dev/null || true
