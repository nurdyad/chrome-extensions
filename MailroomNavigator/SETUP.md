# MailroomNavigator Setup

This guide is written so anyone can follow it, step by step, on their own machine. Every machine sets up its **own** copy of everything below — nobody shares credentials or a `.env` file with anyone else.

There are two levels:

- **Level 1 — Basic install.** Just the Chrome extension. Takes a few minutes. No Node.js, no Cloud SQL, no passwords needed.
- **Level 2 — Full install.** Adds Create Linear Issue, Trigger Linear, Reconcile Linear, Slack sync, and Cloud SQL-backed UUID lookup. Needs Node.js and your own credentials.

If you're not sure which one you need: start with Level 1. You can always come back and do Level 2 later — nothing about Level 1 needs to be redone.

---

## Level 1 — Basic Install (everyone does this)

### What you need
- Google Chrome (or any Chromium-based browser that supports extension developer mode)
- Git

### Steps

1. Open a terminal and clone the repository:
   ```bash
   git clone https://github.com/nurdyad/chrome-extensions.git
   ```
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. In the file picker, select the `MailroomNavigator` folder inside the repository you just cloned.
6. Click the extension's icon in Chrome's toolbar to open it.
7. Check that you can see the `Navigator`, `Job Panel`, and `Others` tabs.

That's it — you're done with Level 1. Practice Navigator, Job Panel document/job links, dashboard hover tools, and all four Bookmarklet Tools (UUID Picker, Custom Workflow, Docman Groups, Email Formatter) all work right now, with nothing else to install.

---

## Level 2 — Full Install (Create Linear Issue, Trigger Linear, Reconcile Linear, Slack sync, Cloud SQL UUID lookup)

Only do this if you personally need one of the features listed above. Each feature below tells you exactly what it needs, so you can stop as soon as you've got what you actually want.

### What you need first
- Everything from Level 1, already done
- Node.js version 18 or newer, installed on your machine
- Your **own** Linear API key (from your own Linear account) if you want to create/trigger Linear issues
- Your **own** Slack bot token if you want Slack sync
- Cloud SQL Proxy running on your machine, only if you want the Cloud SQL-backed UUID lookup (explained further down)

### Step 1: Create your own `.env` file

1. In a terminal, go into the `MailroomNavigator` folder from the repository you cloned.
2. Copy the template file to create your real config file:
   ```bash
   cp .env.example .env
   ```
3. Open the new `.env` file in a text editor. You'll fill in real values here in the steps below.
4. Never share this file or commit it to Git — it's already excluded by `.gitignore`, and it will hold your personal credentials.

### Step 2: Add your Linear credentials (needed for "Create Linear Issue" and "Trigger Linear")

1. Get your own Linear API key from your Linear account settings.
2. In `.env`, set:
   ```
   LINEAR_API_KEY=your-own-key-here
   LINEAR_TEAM_KEY=SUPP
   ```
   (`LINEAR_TEAM_KEY` is the short code shown in your Linear issue IDs, e.g. `SUPP` for `SUPP-1762`. Change it if your team uses a different one.)
3. If you don't need Linear features at all, leave `LINEAR_API_KEY` blank — the buttons will show a clear error instead of failing silently.

### Step 3: Add Slack sync (optional — only if you want Slack notifications from Linear issues)

1. Get your own Slack bot token.
2. In `.env`, set:
   ```
   SLACK_BOT_TOKEN=your-own-token-here
   ```
3. Leave it blank if you don't need Slack sync — the rest of the extension works fine without it.

### Step 4: Point at your own bot-jobs checkout (needed for "Trigger Linear")

1. Clone or locate your own copy of the `bot-jobs-linear` project on your machine.
2. In `.env`, set:
   ```
   LINEAR_TRIGGER_BOT_JOBS_DIR=/full/path/to/your/bot-jobs-linear
   ```
3. Make sure that folder has its own `bot-jobs.js` file and its own `.env` file already set up, separately from this extension's `.env`.

### Step 5: Decide about Cloud SQL (optional — only for the database-backed UUID lookup)

This step is entirely optional. Skipping it does not break anything else — it only disables one specific feature: the Cloud SQL UUID lookup in Job Panel.

If you want that feature:

1. Install and run Cloud SQL Proxy on your own machine, listening on `127.0.0.1:15432`.
2. Get the database password from your team's secret manager (e.g. Bitwarden).
3. In `.env`, set:
   ```
   MAILROOMNAV_SQL_PASSWORD=your-own-password-here
   ```
4. Everything else (`MAILROOMNAV_SQL_HOST`, `_PORT`, `_DATABASE`, `_USER`) already has sensible defaults in `.env.example` — you usually don't need to change them.

If you don't want this feature, just leave `MAILROOMNAV_SQL_PASSWORD` blank in `.env`. You do not need to install Cloud SQL Proxy at all.

### Step 6: Install and start the local trigger service

This is the background service on your own machine that the extension talks to for all Level 2 features. It only needs to be running if you're using at least one Level 2 feature.

**On macOS** (runs automatically in the background from now on):
```bash
cd MailroomNavigator/automation
npm install
chmod +x *.sh
./install-linear-trigger-launchagent.sh
```

**On Windows**, open PowerShell or Command Prompt:
```powershell
cd MailroomNavigator\automation
npm install
.\start-linear-trigger-server.cmd
```
To make it start automatically every time you log in, create a Windows Task Scheduler task that runs `start-linear-trigger-server.cmd` at logon.

**On Linux**, or manually on any OS:
```bash
cd MailroomNavigator/automation
npm install
node linear-trigger-server.mjs
```
To make it start automatically, set up a systemd user service or a cron job that runs this command at login/boot.

### Step 7: Check it's working

1. Run:
   ```bash
   curl http://127.0.0.1:4817/health
   ```
2. You should get back a response that says the service is running.
3. On macOS, you can also run the built-in checker:
   ```bash
   cd MailroomNavigator/automation
   ./check-linear-trigger-service.sh
   ```
4. Open the extension in Chrome and try the feature you set up (e.g. click "Create Linear Issue"). If something's wrong, the extension shows a clear error message telling you what's missing.

**Important**: the extension always talks to `127.0.0.1:4817` — that means "this same computer." The trigger service has to be running on the exact same machine as the Chrome extension using it. It cannot be shared between machines.

---

## Updating later

Whenever you pull new code changes:

```bash
cd MailroomNavigator/automation
npm install
./install-linear-trigger-launchagent.sh
```
(Windows/Linux users: just restart the service the same way you started it in Step 6.)

Your `.env` file is untouched by updates — you only need to redo the setup steps above if the feature you use changes.

## Uninstalling the trigger service (macOS)

```bash
cd MailroomNavigator/automation
./uninstall-linear-trigger-launchagent.sh
```

## Troubleshooting

```bash
cd MailroomNavigator/automation
./check-linear-trigger-service.sh
tail -f ../logs/linear-trigger-server.log
curl http://127.0.0.1:4817/health
```

If a Level 2 feature isn't working, check in this order:
1. Is the trigger service actually running? (`curl http://127.0.0.1:4817/health`)
2. Did you fill in the right value in `.env` for that specific feature?
3. Did you restart the trigger service after editing `.env`? (Changes to `.env` only take effect after a restart.)
