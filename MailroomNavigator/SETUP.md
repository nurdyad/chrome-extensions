# MailroomNavigator Setup

This document covers:

1. Base extension install (all OS)
2. Optional automation install (macOS)
3. Optional/manual alternatives for Windows/Linux

## 1. Base Install (macOS, Windows, Linux)

### Prerequisites

- Google Chrome (or Chromium-based browser with extension developer mode)
- Git
- Node.js 18+ (required for automation scripts; optional for extension-only usage)

### Steps

1. Clone repository:

```bash
git clone https://github.com/nurdyad/chrome-extensions.git
cd chrome-extensions
```

2. Load extension in Chrome:
   - Open `chrome://extensions`
   - Enable `Developer mode`
   - Click `Load unpacked`
   - Select folder: `MailroomNavigator`

3. Verify:
   - Open extension popup
   - Confirm tabs `Navigator`, `Job Panel`, `Others` are visible

## 2. Local Secrets and Config

1. Create local env file:

```bash
cd MailroomNavigator
cp .env.example .env
```

2. Edit `.env` and provide real values:
   - `user_email`, `user_password`
   - admin auth fields if required in your environment
   - OTP IMAP mailbox settings
   - `LINEAR_API_KEY`, `LINEAR_TEAM_KEY` (for extension "Create Linear Issue")
   - `SLACK_BOT_TOKEN` (only if you want Slack sync from the Linear Issue panel)
   - optional linear trigger settings

3. Never commit `.env`:
   - `.env` is gitignored
   - keep secrets only on local machine or secret manager

## 3. macOS Full Automation (Recommended)

This enables:

- morning session refresh
- native macOS summary notifications
- global hotkeys (`Cmd+Shift+9`, `Cmd+Ctrl+9`)
- `Trigger Linear` local service

### Install

```bash
cd MailroomNavigator/automation
npm install
chmod +x *.sh
./install-morning-login-launchagent.sh --hour 7 --minute 0 --interval 300
./install-linear-trigger-launchagent.sh
./install-global-summary-hotkey.sh
```

### Validate

```bash
cd MailroomNavigator/automation
/bin/bash ./morning-login-runner.sh --force
./show-live-summary-notification.sh
./check-global-summary-hotkey.sh
curl http://127.0.0.1:4817/health
```

## 4. Windows/Linux (Extension + Manual Automation)

The extension works cross-platform, but macOS-specific components do not:

- no `launchctl` LaunchAgent
- no AppKit/Carbon hotkey daemon (`global-summary-hotkey.m`)
- no `osascript` notification path

You can still run automation manually:

```bash
cd MailroomNavigator/automation
npm install
node save-auth-local.mjs
node fetch-dashboard-summary.mjs
node linear-trigger-server.mjs
```

For scheduled runs:

- Windows: Task Scheduler
- Linux: systemd user service / cron

## 5. Trigger Linear + Linear Issue Requirements

Both the `Trigger Linear` button and `Create Linear Issue` button call a localhost service on `127.0.0.1:4817`.

Required local setup:

- `LINEAR_API_KEY` and `LINEAR_TEAM_KEY` exist in `MailroomNavigator/.env`
- if Slack sync is enabled in panel:
  - `SLACK_BOT_TOKEN` exists in `MailroomNavigator/.env`
  - optional: `SLACK_SYNC_MEMBER_ONLY=1` to show only channels the bot already belongs to
  - click `Sync Slack` in panel to load channel/user suggestions
  - choose Slack target type (`channel`/`user`) and target ID in the panel
- `LINEAR_TRIGGER_BOT_JOBS_DIR` points to your `bot-jobs-linear` checkout
- `bot-jobs.js` exists in that directory
- target `.env` for bot-jobs is present

If not configured, the endpoint returns a clear error in extension status/logs.

## 5.1 User Management

MailroomNavigator access is now owner-controlled and centrally synced through the local trigger service + Linear.

1. Open the panel while signed in to BetterLetter.
2. The BetterLetter account `nur.siddique@dyad.net` is the fixed owner.
3. Open `Others` -> `Access Control`.
4. Add other BetterLetter user emails and choose:
   - `Admin`
   - `User`
5. Enable only the features they should use.

Notes:

- access is matched against the signed-in BetterLetter user email
- only `nur.siddique@dyad.net` can manage access
- owner access is always full
- `Admin` and `User` are centrally synced; neither can self-elevate through the UI
- regular users only see the views and buttons that are enabled for them
- current BetterLetter user is detected from the active BetterLetter session/tab
- if identity is not detected, open a signed-in BetterLetter tab and reload the extension
- after updating the trigger server code, restart the local trigger service:

```bash
cd MailroomNavigator/automation
./install-linear-trigger-launchagent.sh
```

## 6. Upgrade / Reinstall

After pulling updates:

```bash
cd MailroomNavigator/automation
npm install
./install-morning-login-launchagent.sh --hour 7 --minute 0 --interval 300
./install-linear-trigger-launchagent.sh
./install-global-summary-hotkey.sh
```

## 7. Uninstall Automation (macOS)

```bash
cd MailroomNavigator/automation
./uninstall-morning-login-launchagent.sh
./uninstall-linear-trigger-launchagent.sh
./uninstall-global-summary-hotkey.sh
```

## 8. Troubleshooting Quick Commands

```bash
cd MailroomNavigator/automation
./check-global-summary-hotkey.sh
tail -f ../logs/morning-login-$(date +%F).log
tail -f ../logs/live-summary-hotkey-$(date +%F).log
curl http://127.0.0.1:4817/health
```
