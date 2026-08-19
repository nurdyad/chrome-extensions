# MailroomNavigator Setup

This document covers:

1. Base extension install (all OS)
2. Local trigger service install
3. Optional/manual alternatives for Windows/Linux

## 1. Base Install (macOS, Windows, Linux)

### Prerequisites

- Google Chrome (or Chromium-based browser with extension developer mode)
- Git
- Node.js 18+ (required for the local trigger service; optional for extension-only usage)

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
   - `LINEAR_API_KEY`, `LINEAR_TEAM_KEY` (for extension "Create Linear Issue")
   - `SLACK_BOT_TOKEN` (only if you want Slack sync from the Linear Issue panel)
   - optional Access Control settings:
     - `MAILROOMNAV_ACCESS_CONTROL_STATE_FILE`
     - `MAILROOMNAV_ACCESS_CONTROL_SLACK_TARGET_TYPE`
     - `MAILROOMNAV_ACCESS_CONTROL_SLACK_TARGET`
     - `MAILROOMNAV_ACCESS_CONTROL_ALERT_COOLDOWN_MINUTES`
   - optional Cloud SQL UUID lookup settings:
     - `MAILROOMNAV_SQL_HOST`
     - `MAILROOMNAV_SQL_PORT`
     - `MAILROOMNAV_SQL_DATABASE`
     - `MAILROOMNAV_SQL_USER`
     - `MAILROOMNAV_SQL_PASSWORD`
   - optional linear trigger settings

3. Never commit `.env`:
   - `.env` is gitignored
   - keep secrets only on local machine or secret manager

## 3. macOS Local Trigger Service

This enables:

- `Trigger Linear` local service
- Cloud SQL-backed practice/UUID lookup and reconcile helpers

### Install

```bash
cd MailroomNavigator/automation
npm install
chmod +x *.sh
./install-linear-trigger-launchagent.sh
```

### Validate

```bash
cd MailroomNavigator/automation
./check-linear-trigger-service.sh
curl http://127.0.0.1:4817/health
```

## 4. Windows/Linux (Extension + Manual Service)

The extension works cross-platform, but the macOS LaunchAgent installer uses `launchctl`.

You can still run the local service manually:

```bash
cd MailroomNavigator/automation
npm install
node linear-trigger-server.mjs
```

Windows shortcut:

```powershell
cd MailroomNavigator\automation
npm install
.\start-linear-trigger-server.cmd
```

Alternative from any shell:

```powershell
cd MailroomNavigator\automation
npm install
npm run trigger:start
```

Important:

- `install-linear-trigger-launchagent.sh` is macOS-only and will not work in Command Prompt or PowerShell.
- Abby must run the local trigger server on Abby's own Windows machine because the extension connects to `127.0.0.1:4817` on the same computer as Chrome.
- If you want it to auto-start on Windows, create a Task Scheduler task that runs `start-linear-trigger-server.cmd` at logon.

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

MailroomNavigator access is now owner-controlled and stored by the local trigger service.

1. Open the panel while signed in to BetterLetter.
2. The BetterLetter account `nur.siddique@dyad.net` is the fixed owner.
3. Open `Others` -> `Access Control`.
4. Add other BetterLetter user emails and choose:
   - `Admin`
   - `User`
5. Enable only the features they should use.

Notes:

- `Hybrid` with `Open Access Mode` is now the default deployment mode for this repo
- new GitHub installs are not blocked from Navigator, Job Panel, dashboard hover tools, or other browser-side features
- localhost-backed tools such as `Cloud SQL UUID Lookup`, `Create Linear Issue`, `Slack Sync`, `Trigger Linear`, and `Reconcile Linear` remain visible, but still require the optional local trigger service when someone wants to use them
- access is matched against the signed-in BetterLetter user email
- only `nur.siddique@dyad.net` can manage access
- owner access is always full
- Access Control is stored locally by the trigger server in a JSON file, not in Linear
- if Access Control Slack alerts are configured, denied-access events and user save/delete events are posted to that Slack target
- `Admin` and `User` are centrally synced; neither can self-elevate through the UI
- regular users only see the views and buttons that are enabled for them
- current BetterLetter user is detected from the active BetterLetter session/tab
- if identity is not detected, open a signed-in BetterLetter tab and reload the extension
- if you want to stop access checks on the current machine, open the panel and enable `Open Access Mode on this machine` in `Access Service`
- after updating the trigger server code, restart the local trigger service:

```bash
cd MailroomNavigator/automation
./install-linear-trigger-launchagent.sh
```

### Cross-Machine Access Control

If you want the Access Control checkboxes to govern another machine, use one machine as the shared access service host.

Host machine:

- run `linear-trigger-server.mjs`
- set `LINEAR_TRIGGER_SERVER_HOST=0.0.0.0` in `MailroomNavigator/.env`
- optionally set `MAILROOMNAV_ACCESS_CONTROL_SHARED_KEY` in `MailroomNavigator/.env`
- restart the trigger server after env changes

Client machine:

- if you want new installs to auto-bootstrap to the shared access service, set `sharedAccessServiceBaseUrl` in `MailroomNavigator/deployment_defaults.js` before distributing the extension
- if you want new installs to skip feature gating completely, set `openAccessMode: true` in `MailroomNavigator/deployment_defaults.js` before distributing the extension
- open the panel
- in `BetterLetter Session Required`, set `Shared Access Service URL` to the host machine URL, for example `http://192.168.1.20:4817`
- if the host uses `MAILROOMNAV_ACCESS_CONTROL_SHARED_KEY`, enter the same key in `Shared Access Key`
- save the access service config, then refresh the panel

With this setup, the Access Control panel on the host machine remains the source of truth for users and feature checkboxes across machines.

Access requests:

- denied users can submit `Request Access` from the panel
- the host owner can review `Requests` in `Access Control`
- the shared access service stores the requester email, recent IPs, request count, requested features, note, and last user agent
- IPs may reflect a proxy, VPN, or NAT rather than a unique device

## 5.2 Cloud SQL UUID Lookup Requirements

The Job Panel UUID field calls the same localhost service on `127.0.0.1:4817`.

Required local setup:

- Cloud SQL Proxy is running on `127.0.0.1:15432`
- `MAILROOMNAV_SQL_PASSWORD` exists in `MailroomNavigator/.env`
- the local trigger service has been restarted after `.env` changes

Defaults:

- host: `127.0.0.1`
- port: `15432`
- database: `mailroom_prod`
- user: `reporting`

## 6. Upgrade / Reinstall

After pulling updates:

```bash
cd MailroomNavigator/automation
npm install
./install-linear-trigger-launchagent.sh
```

## 7. Uninstall Local Trigger Service (macOS)

```bash
cd MailroomNavigator/automation
./uninstall-linear-trigger-launchagent.sh
```

## 8. Troubleshooting Quick Commands

```bash
cd MailroomNavigator/automation
./check-linear-trigger-service.sh
tail -f ../logs/linear-trigger-server.log
curl http://127.0.0.1:4817/health
```
