# MailroomNavigator Colleague Install Guide

This guide is for installing MailroomNavigator on another Mac and enabling the local service used by Linear issue creation.

## What The Local Service Does

The Chrome extension cannot create Linear issues by itself. It talks to a small local service on the same computer:

```text
http://127.0.0.1:4817
```

If Chrome says `Local trigger service is unavailable`, the extension is installed but that local service is not running or is not configured.

## One-Time Setup

### 1. Install Node.js

Install Node.js LTS from:

```text
https://nodejs.org/
```

After installing, open Terminal and check:

```bash
node -v
npm -v
```

Both commands should print a version number.

### 2. Put The Extension Folder On The Mac

Copy or clone the `chrome-extensions` folder so this path exists:

```text
~/chrome-extensions/MailroomNavigator
```

If the folder is somewhere else, the install still works, but keep the path stable after installing.

### 3. Create `.env`

In `MailroomNavigator`, copy:

```text
.env.example
```

to:

```text
.env
```

For creating Linear issues, these values are required:

```env
LINEAR_API_KEY=...
LINEAR_TEAM_KEY=SUPP
LINEAR_TRIGGER_SERVER_HOST=127.0.0.1
LINEAR_TRIGGER_SERVER_PORT=4817
```

Do not commit or share `.env` publicly.

### 4. Install The Local Service

Open Terminal and run:

```bash
cd ~/chrome-extensions/MailroomNavigator/automation
npm install
chmod +x *.sh
./install-linear-trigger-launchagent.sh
./check-linear-trigger-service.sh
```

Healthy output should show:

- LaunchAgent state is `running`
- something listening on `127.0.0.1:4817`
- health JSON contains `"ok":true`

In the health JSON, `"running":false` is normal. It means no job is currently active.

### 5. Load The Chrome Extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select:

```text
~/chrome-extensions/MailroomNavigator
```

After updates, use the reload icon on this page and refresh BetterLetter.

## Quick Fixes

### Local Trigger Service Is Unavailable

Run:

```bash
cd ~/chrome-extensions/MailroomNavigator/automation
./check-linear-trigger-service.sh
```

If it is not running:

```bash
./install-linear-trigger-launchagent.sh
./check-linear-trigger-service.sh
```

Then reload the extension in `chrome://extensions` and refresh the page.

### Restart The Service

```bash
launchctl kickstart -k "gui/$(id -u)/ai.betterletter.mailroomnavigator.linear-trigger-server"
```

Then check:

```bash
curl http://127.0.0.1:4817/health
```

### Missing `.env`

If the install says:

```text
Missing .env file
```

Create `MailroomNavigator/.env` from `.env.example` and fill in the Linear values.

### Bot Jobs Directory Warning

If the install warns about `bot-jobs-linear`, issue creation can still work.

`Trigger Linear` and `Reconcile Linear` need the bot-jobs checkout. Basic `Issue Page` / row issue creation mainly needs:

```env
LINEAR_API_KEY
LINEAR_TEAM_KEY
```

### Logs

Service log:

```bash
tail -n 120 ~/chrome-extensions/MailroomNavigator/logs/linear-trigger-server.log
```

LaunchAgent logs:

```bash
tail -n 120 ~/chrome-extensions/MailroomNavigator/logs/linear-trigger-server-launchd.out.log
tail -n 120 ~/chrome-extensions/MailroomNavigator/logs/linear-trigger-server-launchd.err.log
```

## Daily Use

She does not need to keep Terminal open. The LaunchAgent starts the local service at login and restarts it if it exits.

If Linear issue creation fails after a Chrome extension update:

1. Reload the extension in `chrome://extensions`.
2. Refresh the BetterLetter page.
3. Run `./check-linear-trigger-service.sh` if the local service still shows unavailable.
