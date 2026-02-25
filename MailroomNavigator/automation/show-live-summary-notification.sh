#!/usr/bin/env bash
set -euo pipefail

# One-shot live dashboard summary fetch + macOS notification entrypoint.
# Behavior:
# - Uses saved auth state when available
# - Retries once after refreshing auth if response is unauthorized
# - Emits one final success/failure notification

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${MORNING_LOGIN_ENV_FILE:-$REPO_ROOT/.env}"
STATE_DIR="${MORNING_LOGIN_STATE_DIR:-$REPO_ROOT/.automation-state}"
LOG_DIR="${MORNING_LOGIN_LOG_DIR:-$REPO_ROOT/logs}"
AUTH_STATE_FILE="${MORNING_LOGIN_AUTH_STATE_FILE:-$STATE_DIR/storageState.mailroomnavigator.json}"
SUMMARY_SCRIPT_PATH="${SUMMARY_SCRIPT_PATH:-$SCRIPT_DIR/fetch-dashboard-summary.mjs}"
SAVE_AUTH_SCRIPT_PATH="${SAVE_AUTH_SCRIPT_PATH:-$SCRIPT_DIR/save-auth-local.mjs}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p "$STATE_DIR" "$LOG_DIR"
TODAY="$(date '+%Y-%m-%d')"
RUN_LOG="$LOG_DIR/live-summary-hotkey-${TODAY}.log"

notify_macos() {
  local title="$1"
  local subtitle="$2"
  local message="$3"

  /usr/bin/osascript \
    -e 'on run argv' \
    -e 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)' \
    -e 'end run' \
    "$message" "$title" "$subtitle" >/dev/null 2>&1 || true
}

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$RUN_LOG"
}

contains_unauthorized() {
  local text="$1"
  printf '%s\n' "$text" | grep -qi "unauthorized"
}

run_summary_fetch() {
  local stderr_file
  stderr_file="$(mktemp)"
  set +e
  summary_output="$(
    cd "$SCRIPT_DIR" && \
    DOTENV_CONFIG_PATH="$ENV_FILE" AUTH_STORAGE_STATE_PATH="$AUTH_STATE_FILE" node "$SUMMARY_SCRIPT_PATH" 2>"$stderr_file"
  )"
  summary_status=$?
  set -e
  summary_stderr="$(cat "$stderr_file" 2>/dev/null || true)"
  rm -f "$stderr_file"
  if [[ -n "$summary_stderr" ]]; then
    printf '%s\n' "$summary_stderr" >>"$RUN_LOG"
  fi
}

refresh_auth_once() {
  if [[ ! -f "$SAVE_AUTH_SCRIPT_PATH" ]]; then
    log "Cannot refresh auth: save-auth script missing at $SAVE_AUTH_SCRIPT_PATH"
    return 1
  fi
  log "Session unauthorized. Attempting one auth refresh..."
  if (
    cd "$SCRIPT_DIR" && \
    DOTENV_CONFIG_PATH="$ENV_FILE" node "$SAVE_AUTH_SCRIPT_PATH"
  ) >>"$RUN_LOG" 2>&1; then
    log "Auth refresh completed."
    return 0
  fi
  log "Auth refresh failed."
  return 1
}

if [[ ! -f "$ENV_FILE" ]]; then
  log "Missing env file: $ENV_FILE"
  notify_macos "MailroomNavigator" "Live Summary Failed" "Missing .env file."
  exit 1
fi

if [[ ! -f "$AUTH_STATE_FILE" ]]; then
  log "Missing auth state file: $AUTH_STATE_FILE"
  notify_macos "MailroomNavigator" "Live Summary Failed" "No saved BetterLetter session. Run morning login once."
  exit 1
fi

if [[ ! -f "$SUMMARY_SCRIPT_PATH" ]]; then
  log "Missing summary script: $SUMMARY_SCRIPT_PATH"
  notify_macos "MailroomNavigator" "Live Summary Failed" "Summary script missing."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  log "Node.js not found in PATH."
  notify_macos "MailroomNavigator" "Live Summary Failed" "Node.js not found."
  exit 1
fi

summary_output=""
summary_stderr=""
summary_status=1

run_summary_fetch
combined_output="$(printf '%s\n%s\n' "$summary_output" "$summary_stderr")"
if [[ $summary_status -ne 0 ]] && contains_unauthorized "$combined_output"; then
  if refresh_auth_once; then
    run_summary_fetch
    combined_output="$(printf '%s\n%s\n' "$summary_output" "$summary_stderr")"
  fi
fi

if [[ $summary_status -eq 0 ]]; then
  summary_line="$(printf '%s\n' "$summary_output" | grep -m1 '^SUMMARY=' || true)"
  summary_text="${summary_line#SUMMARY=}"
  if [[ -z "$summary_text" ]]; then
    summary_text="Live dashboard summary unavailable."
  fi

  json_line="$(printf '%s\n' "$summary_output" | grep -m1 '^SUMMARY_JSON=' || true)"
  if [[ -n "$json_line" ]]; then
    log "$json_line"
  fi
  log "SUMMARY=${summary_text}"
  notify_macos "MailroomNavigator" "Live BetterLetter Summary" "$summary_text"
  printf '%s\n' "$summary_text"
  exit 0
fi

summary_error="$(printf '%s\n' "$combined_output" | grep -m1 '^SUMMARY_ERROR=' || true)"
if [[ -z "$summary_error" ]]; then
  summary_error="$(printf '%s\n' "$combined_output" | awk 'NF{line=$0} END{print line}')"
fi
if [[ -z "$summary_error" ]]; then
  summary_error="Unknown summary fetch failure."
fi
log "Summary fetch failed: $summary_error"
notify_macos "MailroomNavigator" "Live Summary Failed" "Could not fetch summary. Check live-summary-hotkey log."
exit 1
