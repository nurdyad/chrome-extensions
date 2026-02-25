#!/usr/bin/env bash
set -euo pipefail

# This runner performs BetterLetter morning auth refresh when a new morning trigger is detected:
# 1) Uses credentials + IMAP OTP config from MailroomNavigator/.env
# 2) Uses local save-auth-local.mjs for BetterLetter + admin auth
# 3) Verifies both admin panel and mailroom pages are reachable with saved session
# 4) Sends a macOS notification on success/failure

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${MORNING_LOGIN_ENV_FILE:-$REPO_ROOT/.env}"
STATE_DIR="${MORNING_LOGIN_STATE_DIR:-$REPO_ROOT/.automation-state}"
LOG_DIR="${MORNING_LOGIN_LOG_DIR:-$REPO_ROOT/logs}"
AUTH_SCRIPT_PATH="${MORNING_LOGIN_AUTH_SCRIPT_PATH:-$SCRIPT_DIR/save-auth-local.mjs}"
AUTH_STATE_FILE="${MORNING_LOGIN_AUTH_STATE_FILE:-$STATE_DIR/storageState.mailroomnavigator.json}"

STATE_FILE="$STATE_DIR/last-success-trigger-key.txt"
LEGACY_CYCLE_STATE_FILE="$STATE_DIR/last-success-cycle-key.txt"
LEGACY_DATE_STATE_FILE="$STATE_DIR/last-success-date.txt"
LOCK_DIR="$STATE_DIR/runner.lock"

# Keep PATH explicit for launchd runs.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p "$STATE_DIR" "$LOG_DIR"

usage() {
  cat <<'USAGE'
Usage: morning-login-runner.sh [--force]

Options:
  --force    Run immediately, bypassing trigger-key dedupe.
USAGE
}

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

is_integer_between_0_23() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  (( value >= 0 && value <= 23 ))
}

is_hour_within_window() {
  local hour="$1"
  local start_hour="$2"
  local end_hour="$3"

  if (( start_hour == end_hour )); then
    return 0
  fi

  if (( start_hour < end_hour )); then
    (( hour >= start_hour && hour < end_hour ))
    return
  fi

  # Wrapped window (e.g. 22 -> 6)
  (( hour >= start_hour || hour < end_hour ))
}

get_cycle_key_for_hour() {
  local hour="$1"
  local anchor_hour="$2"
  if (( hour < anchor_hour )); then
    date -v-1d '+%Y-%m-%d'
  else
    date '+%Y-%m-%d'
  fi
}

get_console_session_signature() {
  local signature
  signature="$(who | awk '$2=="console"{print $1 "|" $3 "|" $4 "|" $5; exit}')"
  if [[ -z "$signature" ]]; then
    signature="unknown_console"
  fi
  printf '%s' "$signature"
}

get_boot_signature() {
  local signature
  signature="$(who -b 2>/dev/null | awk '{print $3 "|" $4 "|" $5}')"
  if [[ -z "$signature" ]]; then
    signature="unknown_boot"
  fi
  printf '%s' "$signature"
}

get_sleep_wake_counter() {
  local value
  value="$(
    pmset -g log 2>/dev/null | awk '
      /^Sleep\/Wakes since boot/ {
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^:[0-9]+$/) {
            n = $i
            gsub(":", "", n)
            val = n
            break
          }
        }
      }
      END {
        if (val == "") {
          print "unknown_wakes"
        } else {
          print val
        }
      }
    '
  )"
  printf '%s' "$value"
}

get_loginwindow_activity_marker() {
  local value
  value="$(
    pmset -g log 2>/dev/null | awk '
      /loginwindow\) Created UserIsActive "Loginwindow User Activity"/ {
        if ($1 ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/ && $2 ~ /^[0-9]{2}:[0-9]{2}:[0-9]{2}$/) {
          marker = $1 "_" $2
        }
      }
      END {
        if (marker == "") {
          print "unknown_loginwindow_activity"
        } else {
          print marker
        }
      }
    '
  )"
  printf '%s' "$value"
}

sanitize_signature_token() {
  local raw="$1"
  printf '%s' "$raw" | tr ' ' '_' | tr -cd '[:alnum:]_|\-'
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift

  "$@" &
  local cmd_pid="$!"
  local started_at
  started_at="$(date +%s)"

  while kill -0 "$cmd_pid" >/dev/null 2>&1; do
    local now
    now="$(date +%s)"
    if (( now - started_at >= timeout_seconds )); then
      kill "$cmd_pid" >/dev/null 2>&1 || true
      sleep 2
      kill -9 "$cmd_pid" >/dev/null 2>&1 || true
      wait "$cmd_pid" >/dev/null 2>&1 || true
      return 124
    fi
    sleep 1
  done

  wait "$cmd_pid"
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

require_env_key() {
  local key="$1"
  local file="$2"
  grep -Eq "^[[:space:]]*${key}[[:space:]]*=" "$file"
}

ensure_env_has_credentials() {
  local file="$1"
  local missing=()

  # BetterLetter credentials.
  require_env_key "user_email" "$file" || missing+=("user_email")
  require_env_key "user_password" "$file" || missing+=("user_password")

  # Basic auth credentials: support either ADMIN_PANEL_* or BASIC_AUTH_* pair.
  local has_admin_user=0
  local has_admin_pass=0
  local has_basic_user=0
  local has_basic_pass=0
  require_env_key "ADMIN_PANEL_USERNAME" "$file" && has_admin_user=1
  require_env_key "ADMIN_PANEL_PASSWORD" "$file" && has_admin_pass=1
  require_env_key "BASIC_AUTH_USERNAME" "$file" && has_basic_user=1
  require_env_key "BASIC_AUTH_PASSWORD" "$file" && has_basic_pass=1

  if [[ $has_admin_user -ne 1 && $has_basic_user -ne 1 ]]; then
    missing+=("ADMIN_PANEL_USERNAME or BASIC_AUTH_USERNAME")
  fi
  if [[ $has_admin_pass -ne 1 && $has_basic_pass -ne 1 ]]; then
    missing+=("ADMIN_PANEL_PASSWORD or BASIC_AUTH_PASSWORD")
  fi

  # IMAP OTP requirements for AUTO_2FA_FROM_EMAIL flow.
  require_env_key "OTP_EMAIL_IMAP_HOST" "$file" || missing+=("OTP_EMAIL_IMAP_HOST")
  require_env_key "OTP_EMAIL_USERNAME" "$file" || missing+=("OTP_EMAIL_USERNAME")
  require_env_key "OTP_EMAIL_PASSWORD" "$file" || missing+=("OTP_EMAIL_PASSWORD")

  if [[ ${#missing[@]} -gt 0 ]]; then
    log "Missing required .env keys: ${missing[*]}"
    notify_macos \
      "MailroomNavigator" \
      "Morning Login Failed" \
      "Missing required .env keys: ${missing[*]}"
    return 1
  fi

  return 0
}

FORCE_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE_RUN=1
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

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "Another morning-login run is already in progress. Exiting."
  exit 0
fi
SUMMARY_TMP_FILE=""
cleanup_runner() {
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
  if [[ -n "${SUMMARY_TMP_FILE:-}" && -f "$SUMMARY_TMP_FILE" ]]; then
    rm -f "$SUMMARY_TMP_FILE" >/dev/null 2>&1 || true
  fi
}
trap cleanup_runner EXIT

TODAY="$(date '+%Y-%m-%d')"
CURRENT_HOUR_RAW="$(date '+%H')"
CURRENT_HOUR=$((10#$CURRENT_HOUR_RAW))

ANCHOR_HOUR_RAW="${MORNING_LOGIN_ANCHOR_HOUR:-7}"
WINDOW_START_HOUR_RAW="${MORNING_LOGIN_WINDOW_START_HOUR:-7}"
WINDOW_END_HOUR_RAW="${MORNING_LOGIN_WINDOW_END_HOUR:-17}"

if ! is_integer_between_0_23 "$ANCHOR_HOUR_RAW"; then
  log "Invalid MORNING_LOGIN_ANCHOR_HOUR=${ANCHOR_HOUR_RAW}. Expected 0-23."
  exit 1
fi
if ! is_integer_between_0_23 "$WINDOW_START_HOUR_RAW"; then
  log "Invalid MORNING_LOGIN_WINDOW_START_HOUR=${WINDOW_START_HOUR_RAW}. Expected 0-23."
  exit 1
fi
if ! is_integer_between_0_23 "$WINDOW_END_HOUR_RAW"; then
  log "Invalid MORNING_LOGIN_WINDOW_END_HOUR=${WINDOW_END_HOUR_RAW}. Expected 0-23."
  exit 1
fi

ANCHOR_HOUR=$((10#$ANCHOR_HOUR_RAW))
WINDOW_START_HOUR=$((10#$WINDOW_START_HOUR_RAW))
WINDOW_END_HOUR=$((10#$WINDOW_END_HOUR_RAW))

if [[ $FORCE_RUN -ne 1 ]]; then
  if ! is_hour_within_window "$CURRENT_HOUR" "$WINDOW_START_HOUR" "$WINDOW_END_HOUR"; then
    log "Outside morning window (${WINDOW_START_HOUR}:00-${WINDOW_END_HOUR}:00). Skipping."
    exit 0
  fi
fi

CURRENT_CYCLE_KEY="$(get_cycle_key_for_hour "$CURRENT_HOUR" "$ANCHOR_HOUR")"
BOOT_SIGNATURE="$(sanitize_signature_token "$(get_boot_signature)")"
CONSOLE_SIGNATURE="$(sanitize_signature_token "$(get_console_session_signature)")"
WAKE_COUNTER="$(sanitize_signature_token "$(get_sleep_wake_counter)")"
LOGINWINDOW_ACTIVITY_MARKER="$(sanitize_signature_token "$(get_loginwindow_activity_marker)")"
CURRENT_TRIGGER_KEY="${CURRENT_CYCLE_KEY}|boot:${BOOT_SIGNATURE}|console:${CONSOLE_SIGNATURE}|wake:${WAKE_COUNTER}|unlock:${LOGINWINDOW_ACTIVITY_MARKER}"

LAST_SUCCESS_TRIGGER_KEY=""
if [[ -f "$STATE_FILE" ]]; then
  LAST_SUCCESS_TRIGGER_KEY="$(cat "$STATE_FILE" 2>/dev/null || true)"
fi

if [[ $FORCE_RUN -ne 1 && "$LAST_SUCCESS_TRIGGER_KEY" == "$CURRENT_TRIGGER_KEY" ]]; then
  log "A successful morning-login run already happened for trigger ${CURRENT_TRIGGER_KEY}."
  exit 0
fi

log "Current trigger key: ${CURRENT_TRIGGER_KEY}"

if [[ ! -f "$ENV_FILE" ]]; then
  log "Missing env file: $ENV_FILE"
  notify_macos "MailroomNavigator" "Morning Login Failed" "Missing .env file at $ENV_FILE"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  log "Node.js is not installed or not in PATH."
  notify_macos "MailroomNavigator" "Morning Login Failed" "Node.js not found in PATH"
  exit 1
fi

if [[ ! -f "$AUTH_SCRIPT_PATH" ]]; then
  log "Missing local auth script: $AUTH_SCRIPT_PATH"
  notify_macos "MailroomNavigator" "Morning Login Failed" "Missing local auth script"
  exit 1
fi

# Ensure local automation dependencies are installed.
if ! (
  cd "$SCRIPT_DIR"
  node --input-type=module -e 'await import("dotenv/config"); await import("playwright"); await import("imapflow");'
) >/dev/null 2>&1; then
  log "Missing Node dependencies in $SCRIPT_DIR. Run: cd $SCRIPT_DIR && npm install"
  notify_macos \
    "MailroomNavigator" \
    "Morning Login Failed" \
    "Missing automation deps. Run npm install in automation folder."
  exit 1
fi

ensure_env_has_credentials "$ENV_FILE"

RUN_LOG="$LOG_DIR/morning-login-${TODAY}.log"
log "Starting morning login run. Log file: $RUN_LOG"

SAVE_AUTH_TIMEOUT_SECONDS="${MORNING_LOGIN_SAVE_AUTH_TIMEOUT_SECONDS:-420}"
VERIFY_TIMEOUT_SECONDS="${MORNING_LOGIN_VERIFY_TIMEOUT_SECONDS:-240}"
DASHBOARD_SUMMARY_TIMEOUT_SECONDS="${MORNING_LOGIN_DASHBOARD_SUMMARY_TIMEOUT_SECONDS:-160}"
SAVE_AUTH_MAX_ATTEMPTS="${MORNING_LOGIN_SAVE_AUTH_MAX_ATTEMPTS:-3}"
SAVE_AUTH_RETRY_DELAY_SECONDS="${MORNING_LOGIN_SAVE_AUTH_RETRY_DELAY_SECONDS:-12}"

run_save_auth() {
  (
    cd "$SCRIPT_DIR"
    DOTENV_CONFIG_PATH="$ENV_FILE" AUTH_STORAGE_STATE_PATH="$AUTH_STATE_FILE" AUTH_HEADLESS="${AUTH_HEADLESS:-1}" AUTO_2FA_FROM_EMAIL="${AUTO_2FA_FROM_EMAIL:-1}" node "$AUTH_SCRIPT_PATH"
  )
}

run_session_verify() {
  (
    cd "$SCRIPT_DIR"
    DOTENV_CONFIG_PATH="$ENV_FILE" AUTH_STORAGE_STATE_PATH="$AUTH_STATE_FILE" node --input-type=module - <<'NODE'
import "dotenv/config";
import { chromium } from "playwright";

const adminUrl = "https://app.betterletter.ai/admin_panel/bots/dashboard?status=paused";
const mailroomUrl = "https://app.betterletter.ai/mailroom/preparing?only_action_items=true&practice=all&service=self&sort=upload_date&sort_dir=asc&urgent=false";
const storageStatePath = String(process.env.AUTH_STORAGE_STATE_PATH || "storageState.mailroomnavigator.json");

const httpUser = String(process.env.ADMIN_PANEL_USERNAME || process.env.BASIC_AUTH_USERNAME || "");
const httpPass = String(process.env.ADMIN_PANEL_PASSWORD || process.env.BASIC_AUTH_PASSWORD || "");

const httpCredentials =
  httpUser && httpPass
    ? { username: httpUser, password: httpPass }
    : undefined;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: storageStatePath,
  httpCredentials,
});
const page = await context.newPage();

async function assertReachable(url, name) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  const status = response?.status?.() ?? 0;
  const currentUrl = String(page.url() || "");
  const bodyText = String((await page.locator("body").innerText().catch(() => "")) || "").toLowerCase();

  if (status === 401 || status === 403) {
    throw new Error(`${name} returned HTTP ${status}`);
  }
  if (currentUrl.toLowerCase().includes("/sign-in")) {
    throw new Error(`${name} redirected to sign-in (${currentUrl})`);
  }
  if (bodyText.includes("sign in to betterletter")) {
    throw new Error(`${name} still shows sign-in content`);
  }
}

try {
  await assertReachable(adminUrl, "Admin panel");
  await assertReachable(mailroomUrl, "Mailroom");
  console.log("session-verify=ok");
} finally {
  await browser.close().catch(() => {});
}
NODE
  )
}

run_dashboard_summary() {
  (
    cd "$SCRIPT_DIR"
    DOTENV_CONFIG_PATH="$ENV_FILE" AUTH_STORAGE_STATE_PATH="$AUTH_STATE_FILE" node --input-type=module - <<'NODE'
import "dotenv/config";
import { chromium } from "playwright";

const adminUrl = "https://app.betterletter.ai/admin_panel/bots/dashboard?status=paused";
const storageStatePath = String(process.env.AUTH_STORAGE_STATE_PATH || "storageState.mailroomnavigator.json");

const summaryRequests = [
  {
    key: "filing",
    label: "Filing",
    path: "/admin_panel/bots/dashboard?job_types=generate_output+docman_upload+docman_file+merge_tasks_for_same_recipient+docman_review+docman_delete_original+docman_validate&status=paused",
  },
  {
    key: "docman",
    label: "Docman Import",
    path: "/admin_panel/bots/dashboard?job_types=docman_import&status=paused",
  },
  {
    key: "coding",
    label: "Coding",
    path: "/admin_panel/bots/dashboard?job_types=emis_coding+emis_api_consultation&status=paused",
  },
  {
    key: "import",
    label: "Import",
    path: "/admin_panel/bots/dashboard?job_types=import_jobs+emis_prepare&status=paused",
  },
];

const httpUser = String(process.env.ADMIN_PANEL_USERNAME || process.env.BASIC_AUTH_USERNAME || "");
const httpPass = String(process.env.ADMIN_PANEL_PASSWORD || process.env.BASIC_AUTH_PASSWORD || "");
const httpCredentials = httpUser && httpPass ? { username: httpUser, password: httpPass } : undefined;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: storageStatePath,
  httpCredentials,
});
const page = await context.newPage();

try {
  await page.goto(adminUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  const result = await page.evaluate(async (requests) => {
    const collapse = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const buildLooseLabelPattern = (label) => {
      const tokens = collapse(label).toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.length) return "";
      return tokens.join("\\s*");
    };
    const parseCountByLabel = (text, label) => {
      const source = collapse(text);
      const looseLabelPattern = buildLooseLabelPattern(label);
      if (!source || !looseLabelPattern) return null;

      const patterns = [
        new RegExp(`${looseLabelPattern}[^0-9]{0,20}\\((\\d+)\\)`, "gi"),
        new RegExp(`${looseLabelPattern}[^0-9]{0,20}[:\\-]?\\s*(\\d+)\\b`, "gi"),
      ];

      const values = [];
      patterns.forEach((regex) => {
        for (const match of source.matchAll(regex)) {
          const parsed = Number.parseInt(String(match?.[1] || ""), 10);
          if (Number.isFinite(parsed) && parsed >= 0) values.push(parsed);
        }
      });

      if (!values.length) return null;
      return Math.max(...values);
    };

    const fetchOne = async (item) => {
      try {
        const response = await fetch(String(item?.path || ""), {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          return { label: String(item?.label || item?.key || "Category"), requireAttention: null, unauthorized: false };
        }

        const html = await response.text();
        const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
        const sourceText = collapse(doc?.body?.innerText || "");
        const unauthorized = /log in|sign in|password/i.test(sourceText) &&
          Boolean(doc.querySelector('form[action*="sign"], input[type="password"]'));

        const requireAttention = parseCountByLabel(sourceText, "Require Attention");
        const requireAttentionCount = Number.isFinite(requireAttention) ? requireAttention : null;

        return {
          label: String(item?.label || item?.key || "Category"),
          requireAttention: requireAttentionCount,
          unauthorized,
        };
      } catch {
        return { label: String(item?.label || item?.key || "Category"), requireAttention: null, unauthorized: false };
      }
    };

    const categories = await Promise.all((Array.isArray(requests) ? requests : []).map(fetchOne));
    const unauthorized = categories.some((item) => item?.unauthorized);
    return { categories, unauthorized };
  }, summaryRequests);

  if (result?.unauthorized) {
    throw new Error("Unauthorized while fetching dashboard summary");
  }

  const formatCount = (value) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : "unknown";
  };

  const categories = Array.isArray(result?.categories) ? result.categories : [];
  const summary = categories
    .map((item) => `${String(item?.label || "Category")}: ${formatCount(item?.requireAttention)} require attention`)
    .join(" | ");

  console.log(`MORNING_DASHBOARD_SUMMARY=${summary || "Unavailable"}`);
} finally {
  await browser.close().catch(() => {});
}
NODE
  )
}

save_auth_succeeded=0
save_auth_last_error=""

for ((attempt=1; attempt<=SAVE_AUTH_MAX_ATTEMPTS; attempt++)); do
  log "Running save-auth-local.mjs attempt ${attempt}/${SAVE_AUTH_MAX_ATTEMPTS}..."
  if run_with_timeout "$SAVE_AUTH_TIMEOUT_SECONDS" run_save_auth >>"$RUN_LOG" 2>&1; then
    save_auth_status=0
  else
    save_auth_status="$?"
  fi

  if [[ "$save_auth_status" -eq 0 ]]; then
    save_auth_succeeded=1
    log "save-auth-local.mjs completed successfully on attempt ${attempt}."
    break
  fi

  if [[ "$save_auth_status" -eq 124 ]]; then
    save_auth_last_error="timed out after ${SAVE_AUTH_TIMEOUT_SECONDS}s"
    log "save-auth-local.mjs attempt ${attempt} timed out after ${SAVE_AUTH_TIMEOUT_SECONDS}s."
  else
    save_auth_last_error="failed with exit code ${save_auth_status}"
    log "save-auth-local.mjs attempt ${attempt} failed (exit=${save_auth_status})."
  fi

  if (( attempt < SAVE_AUTH_MAX_ATTEMPTS )); then
    log "Waiting ${SAVE_AUTH_RETRY_DELAY_SECONDS}s before retry..."
    sleep "$SAVE_AUTH_RETRY_DELAY_SECONDS"
  fi
done

if [[ "$save_auth_succeeded" -ne 1 ]]; then
  log "save-auth-local.mjs failed after ${SAVE_AUTH_MAX_ATTEMPTS} attempt(s). Check $RUN_LOG."
  notify_macos \
    "MailroomNavigator" \
    "Morning Login Failed" \
    "BetterLetter login ${save_auth_last_error}. See ${RUN_LOG##*/}"
  exit 1
fi

# Verify that the newly-saved auth session can access both admin panel and mailroom.
if run_with_timeout "$VERIFY_TIMEOUT_SECONDS" run_session_verify >>"$RUN_LOG" 2>&1; then
  verify_status=0
else
  verify_status="$?"
fi

if [[ "$verify_status" -eq 0 ]]; then
  log "Session verification passed for admin panel + mailroom."
else
  if [[ "$verify_status" -eq 124 ]]; then
    log "Session verification timed out after ${VERIFY_TIMEOUT_SECONDS}s. Check $RUN_LOG."
    notify_macos \
      "MailroomNavigator" \
      "Morning Login Failed" \
      "Session check timed out after ${VERIFY_TIMEOUT_SECONDS}s. See ${RUN_LOG##*/}"
    exit 1
  fi
  log "Session verification failed. Check $RUN_LOG."
  notify_macos \
    "MailroomNavigator" \
    "Morning Login Failed" \
    "Session check failed. See ${RUN_LOG##*/}"
  exit 1
fi

dashboard_summary_message="Live dashboard summary unavailable."
SUMMARY_TMP_FILE="$(mktemp "$STATE_DIR/morning-dashboard-summary.XXXXXX")"
if run_with_timeout "$DASHBOARD_SUMMARY_TIMEOUT_SECONDS" run_dashboard_summary >"$SUMMARY_TMP_FILE" 2>>"$RUN_LOG"; then
  cat "$SUMMARY_TMP_FILE" >>"$RUN_LOG"
  summary_line="$(grep -m1 '^MORNING_DASHBOARD_SUMMARY=' "$SUMMARY_TMP_FILE" 2>/dev/null || true)"
  if [[ -n "$summary_line" ]]; then
    dashboard_summary_message="${summary_line#MORNING_DASHBOARD_SUMMARY=}"
  fi
  log "Dashboard summary ready: ${dashboard_summary_message}"
else
  summary_status="$?"
  if [[ "$summary_status" -eq 124 ]]; then
    log "Dashboard summary fetch timed out after ${DASHBOARD_SUMMARY_TIMEOUT_SECONDS}s."
  else
    log "Dashboard summary fetch failed (exit=${summary_status})."
  fi
fi
rm -f "$SUMMARY_TMP_FILE" >/dev/null 2>&1 || true
SUMMARY_TMP_FILE=""

echo "$CURRENT_TRIGGER_KEY" >"$STATE_FILE"
echo "$CURRENT_CYCLE_KEY" >"$LEGACY_CYCLE_STATE_FILE"
echo "$TODAY" >"$LEGACY_DATE_STATE_FILE"
notify_macos \
  "MailroomNavigator" \
  "Morning Login Complete" \
  "BetterLetter/admin session refreshed. ${dashboard_summary_message}"
log "Morning login flow completed successfully."
