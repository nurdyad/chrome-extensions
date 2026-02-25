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

## 5. Trigger Linear Requirements

The `Trigger Linear` button calls a localhost service on `127.0.0.1:4817`.

Required local setup:

- `LINEAR_TRIGGER_BOT_JOBS_DIR` points to your `bot-jobs-linear` checkout
- `bot-jobs.js` exists in that directory
- target `.env` for bot-jobs is present

If not configured, trigger endpoint will return a clear error in status/logs.

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

