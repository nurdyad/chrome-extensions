# Morning BetterLetter Login Automation

This automation runs on macOS login (and daily at a set time) and sends a native macOS notification.
It is fully local to `MailroomNavigator/automation` and does not depend on `bot-jobs-linear`.
For full extension install across platforms, see `MailroomNavigator/SETUP.md`.

## What it does

1. Loads credentials and IMAP 2FA settings from `MailroomNavigator/.env`
2. Runs BetterLetter login + email 2FA using `save-auth-local.mjs`
3. Verifies saved session can access:
   - Admin panel dashboard
   - Mailroom preparing page
4. Shows macOS notification for success/failure
5. Runs once per morning trigger context (boot/login/wake), unless forced
6. Includes live dashboard `Require Attention` counts in success notification

## Prerequisites

1. `node` installed
2. Local dependencies installed in `MailroomNavigator/automation`:
   - `npm install`
3. `.env` file at `MailroomNavigator/.env` containing:
   - `user_email`, `user_password`
   - `ADMIN_PANEL_USERNAME`, `ADMIN_PANEL_PASSWORD`
   - `OTP_EMAIL_IMAP_HOST`, `OTP_EMAIL_USERNAME`, `OTP_EMAIL_PASSWORD`
   - `LINEAR_API_KEY`, `LINEAR_TEAM_KEY` (if using extension "Create Linear Issue")
   - `SLACK_BOT_TOKEN` (optional, only if Slack sync is enabled in panel)
   - plus any optional OTP tuning keys you already use

## Install

```bash
cd <repo>/MailroomNavigator/automation
npm install
chmod +x morning-login-runner.sh install-morning-login-launchagent.sh uninstall-morning-login-launchagent.sh reliability-test.sh start-linear-trigger-server.sh install-linear-trigger-launchagent.sh uninstall-linear-trigger-launchagent.sh show-live-summary-notification.sh install-global-summary-hotkey.sh uninstall-global-summary-hotkey.sh check-global-summary-hotkey.sh
./install-morning-login-launchagent.sh --hour 7 --minute 0 --interval 300
```

## Trigger Linear + Create Linear Issue From Extension

The extension uses a local service for:
- `Trigger Linear` (runs `bot-jobs-linear/bot-jobs.js`)
- `Create Linear Issue` (creates issue in Linear; optional Slack sync uses `SLACK_BOT_TOKEN`, with workspace targets loaded via panel `Sync Slack`)

Install the local trigger service:

```bash
cd <repo>/MailroomNavigator/automation
chmod +x start-linear-trigger-server.sh install-linear-trigger-launchagent.sh uninstall-linear-trigger-launchagent.sh
./install-linear-trigger-launchagent.sh
```

After install, health endpoint:

```bash
curl http://127.0.0.1:4817/health
```

## Test immediately

```bash
cd <repo>/MailroomNavigator/automation
/bin/bash ./morning-login-runner.sh --force
```

## Global Hotkey (Works Outside Chrome)

Install a macOS global shortcut daemon (`Cmd+Shift+9`, fallback `Cmd+Ctrl+9`) that triggers a live summary notification from any app (Slack desktop, Linear desktop, Meet tab, etc.).

```bash
cd <repo>/MailroomNavigator/automation
./install-global-summary-hotkey.sh
```

After install, a menu-bar indicator (`MRN`) stays visible and shows live state:
- `MRN` idle
- `MRN...` running
- `MRN+` success
- `MRN!` failure

Manual one-off run of the same summary notification script:

```bash
cd <repo>/MailroomNavigator/automation
./show-live-summary-notification.sh
```

Check daemon health/logs quickly:

```bash
cd <repo>/MailroomNavigator/automation
./check-global-summary-hotkey.sh
```

Logs:
- Script log: `MailroomNavigator/logs/live-summary-hotkey-YYYY-MM-DD.log`
- Daemon logs:
  - `MailroomNavigator/logs/summary-hotkey-daemon.log`
  - `MailroomNavigator/logs/summary-hotkey-launchd.out.log`
  - `MailroomNavigator/logs/summary-hotkey-launchd.err.log`

## Reliability test

Run multiple forced attempts and get a success-rate summary:

```bash
cd <repo>/MailroomNavigator/automation
./reliability-test.sh --attempts 3 --delay 20
```

## Logs

- Runner log: `MailroomNavigator/logs/morning-login-YYYY-MM-DD.log`
- Reliability test log: `MailroomNavigator/logs/morning-login-reliability-YYYYMMDD-HHMMSS.log`
- launchd logs:
  - `MailroomNavigator/logs/morning-login-launchd.out.log`
  - `MailroomNavigator/logs/morning-login-launchd.err.log`

## Optional tuning

Set these as environment variables in the LaunchAgent plist if needed:

- `MORNING_LOGIN_SAVE_AUTH_MAX_ATTEMPTS` (default `3`)
- `MORNING_LOGIN_SAVE_AUTH_RETRY_DELAY_SECONDS` (default `12`)
- `MORNING_LOGIN_SAVE_AUTH_TIMEOUT_SECONDS` (default `420`)
- `MORNING_LOGIN_VERIFY_TIMEOUT_SECONDS` (default `240`)
- `MORNING_LOGIN_DASHBOARD_SUMMARY_TIMEOUT_SECONDS` (default `160`)
- `MAILROOM_HOTKEY_COOLDOWN_SECONDS` (default `2.0`)
- `MORNING_LOGIN_WINDOW_START_HOUR` (default `7`)
- `MORNING_LOGIN_WINDOW_END_HOUR` (default `17`)
- `MORNING_LOGIN_ANCHOR_HOUR` (default `7`)
- `OTP_RELOGIN_MAX_CYCLES` (default `3`)
- `OTP_SUBMIT_MAX_ATTEMPTS` (default `3`)
- `POST_OTP_WAIT_SECONDS` (default `35`)
- `OTP_EMAIL_ACCEPT_SKEW_SECONDS` (default `60`)

Behavior details:
- LaunchAgent now runs at login, daily at your selected time, and every `--interval` seconds.
- Runner executes only inside the morning window and de-dupes by trigger key (`cycle + boot + console session + wake count + unlock marker`).
- Default active window is `07:00` to `17:00` local time.
- This catches login, wake/resume, or power-on scenarios without constant alert spam.

## Uninstall

```bash
cd <repo>/MailroomNavigator/automation
./uninstall-morning-login-launchagent.sh
./uninstall-linear-trigger-launchagent.sh
./uninstall-global-summary-hotkey.sh
```

## Important note

This refreshes auth via Playwright automation and stores session in `MailroomNavigator/.automation-state/storageState.mailroomnavigator.json`.
It does not directly sign in your existing interactive Google Chrome profile.
