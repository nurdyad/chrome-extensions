#!/usr/bin/env bash
set -euo pipefail

# Runs repeated forced morning-login flows and reports success rate.
# Purpose: quantify stability of auth + OTP + session verification.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER_PATH="$SCRIPT_DIR/morning-login-runner.sh"
LOG_DIR="$REPO_ROOT/logs"

ATTEMPTS=3
DELAY_SECONDS=20
STOP_ON_FAILURE=0

usage() {
  cat <<'USAGE'
Usage: reliability-test.sh [--attempts 3] [--delay 20] [--stop-on-failure]

Options:
  --attempts N          Number of forced morning-login runs (default: 3)
  --delay SECONDS       Delay between runs (default: 20)
  --stop-on-failure     Stop immediately on first failure
USAGE
}

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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --attempts)
      ATTEMPTS="$2"
      shift 2
      ;;
    --delay)
      DELAY_SECONDS="$2"
      shift 2
      ;;
    --stop-on-failure)
      STOP_ON_FAILURE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ ! -x "$RUNNER_PATH" ]]; then
  echo "Runner script missing or not executable: $RUNNER_PATH"
  exit 1
fi

mkdir -p "$LOG_DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
REPORT_LOG="$LOG_DIR/morning-login-reliability-${STAMP}.log"

echo "Starting reliability test: attempts=$ATTEMPTS delay=${DELAY_SECONDS}s" | tee -a "$REPORT_LOG"

success_count=0
failure_count=0
run_count=0

for ((i=1; i<=ATTEMPTS; i++)); do
  run_count=$i
  start_epoch="$(date +%s)"
  echo "--- Attempt $i/$ATTEMPTS started at $(date '+%Y-%m-%d %H:%M:%S') ---" | tee -a "$REPORT_LOG"

  if /bin/bash "$RUNNER_PATH" --force >>"$REPORT_LOG" 2>&1; then
    end_epoch="$(date +%s)"
    duration=$((end_epoch - start_epoch))
    success_count=$((success_count + 1))
    echo "Attempt $i: SUCCESS (${duration}s)" | tee -a "$REPORT_LOG"
  else
    end_epoch="$(date +%s)"
    duration=$((end_epoch - start_epoch))
    failure_count=$((failure_count + 1))
    echo "Attempt $i: FAILED (${duration}s)" | tee -a "$REPORT_LOG"
    if [[ "$STOP_ON_FAILURE" -eq 1 ]]; then
      break
    fi
  fi

  if (( i < ATTEMPTS )); then
    sleep "$DELAY_SECONDS"
  fi
done

success_rate=0
if (( run_count > 0 )); then
  success_rate=$((100 * success_count / run_count))
fi

summary="Runs: ${run_count}, Success: ${success_count}, Failed: ${failure_count}, SuccessRate: ${success_rate}%"
echo "$summary" | tee -a "$REPORT_LOG"
echo "Report log: $REPORT_LOG" | tee -a "$REPORT_LOG"

notify_macos "MailroomNavigator" "Reliability Test Complete" "$summary"

if (( failure_count > 0 )); then
  exit 1
fi
