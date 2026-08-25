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

## 5.1 Cloud SQL UUID Lookup Requirements

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

## 5.2 Sharing One Machine's Trigger Server (Optional)

Instead of every teammate installing their own Level 2 setup (Node.js,
Cloud SQL Proxy, Linear/Slack keys, `bot-jobs-linear` checkout), one
machine's trigger server can be shared over the local network. Other
installs then only need the browser extension itself (Section 1) -
nothing else - and point it at the shared machine.

**Security note:** the trigger server has no authentication. Anyone who
can reach the chosen port on the host machine can trigger Linear
issues, run Docman automation, and query the database through it. Only
do this on a network you trust (e.g. your own office/home network), not
a shared or public one.

**On the host machine** (the one already fully set up):

1. Find its LAN IP address (macOS: `ipconfig getifaddr en0`).
2. Re-run the install script with that IP:
   ```bash
   cd MailroomNavigator/automation
   LINEAR_TRIGGER_SERVER_HOST=<your-LAN-IP> ./install-linear-trigger-launchagent.sh
   ```
   This makes the server listen on that specific address only - it
   will **no longer be reachable via `127.0.0.1` on this same machine**,
   so the host machine's own extension also needs step 2 below.
3. If DHCP could reassign this machine a different IP later, set a DHCP
   reservation for it on the router - otherwise every other install
   pointing at the old IP will silently stop working whenever it changes.
4. Make sure the Mac firewall (System Settings → Network → Firewall)
   allows incoming connections to `node` for this to be reachable from
   other machines at all.

**On every machine using the shared server** (including the host
machine's own extension, per step 2 above):

1. Complete Section 1 (Base Install) only - no Node.js, no Cloud SQL
   Proxy, no `.env` needed on this machine.
2. Open the extension panel → Linear section → "Trigger server address"
   field, enter `http://<host-machine-LAN-IP>:4817`, and click Save.
3. Leaving the field blank always means "use this machine's own server
   at `127.0.0.1:4817`" - clear it to go back to a fully local setup.

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
