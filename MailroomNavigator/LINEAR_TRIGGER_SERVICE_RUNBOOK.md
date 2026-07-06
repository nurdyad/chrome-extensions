# Linear Trigger Service Runbook

The Mailroom Navigator panel talks to a local service at `http://127.0.0.1:4817`.
That service powers `Trigger Linear`, `Reconcile Linear`, `Create Linear Issue`, Slack sync, and some access-management checks.

## What The Panel Status Means

- `Local trigger ready.` means the service is running and waiting. This is healthy.
- `Running...` means a Trigger or Reconcile job is currently active.
- A success/failure message means the last run finished and the panel is showing the result.
- `Local trigger service is unavailable` means Chrome cannot reach `127.0.0.1:4817`.
- `Local trigger service timed out` means the service did not answer quickly enough.

## One-Command Health Check

```bash
cd /Users/nur/chrome-extensions/MailroomNavigator/automation
./check-linear-trigger-service.sh
```

Healthy output should show:

- LaunchAgent state is `running`
- something is listening on `127.0.0.1:4817`
- `/health` returns JSON with `"ok":true`

In the JSON, `"running":false` is normal. It means no Linear job is active.

## Start Or Install The Always-On Service

```bash
cd /Users/nur/chrome-extensions/MailroomNavigator/automation
npm install
chmod +x *.sh
./install-linear-trigger-launchagent.sh
```

This installs a macOS LaunchAgent:

```text
ai.betterletter.mailroomnavigator.linear-trigger-server
```

It is configured with `RunAtLoad` and `KeepAlive`, so macOS starts it at login and relaunches it if it exits.

## Restart The Service

First try the panel button: `Restart Trigger Service`.

If the panel cannot reach the service, restart it from Terminal:

```bash
launchctl kickstart -k "gui/$(id -u)/ai.betterletter.mailroomnavigator.linear-trigger-server"
```

Then check it:

```bash
curl http://127.0.0.1:4817/health
```

## Reinstall The Service

Use this when restart does not fix it, or after changing paths/config:

```bash
cd /Users/nur/chrome-extensions/MailroomNavigator/automation
./uninstall-linear-trigger-launchagent.sh
./install-linear-trigger-launchagent.sh
./check-linear-trigger-service.sh
```

## Manual Foreground Run

Use this only for debugging. Stop the LaunchAgent first so port `4817` is free:

```bash
cd /Users/nur/chrome-extensions/MailroomNavigator/automation
./uninstall-linear-trigger-launchagent.sh
./start-linear-trigger-server.sh
```

Leave that Terminal window open while testing. Press `Ctrl+C` to stop it, then reinstall the LaunchAgent.

## Logs

Main service log:

```bash
tail -n 120 /Users/nur/chrome-extensions/MailroomNavigator/logs/linear-trigger-server.log
```

LaunchAgent stdout/stderr:

```bash
tail -n 120 /Users/nur/chrome-extensions/MailroomNavigator/logs/linear-trigger-server-launchd.out.log
tail -n 120 /Users/nur/chrome-extensions/MailroomNavigator/logs/linear-trigger-server-launchd.err.log
```

## Common Failures

Missing `.env`:

```text
Missing env file: /Users/nur/chrome-extensions/MailroomNavigator/.env
```

Fix: restore `MailroomNavigator/.env`, then reinstall or restart the service.

Port already in use:

```bash
lsof -nP -iTCP:4817 -sTCP:LISTEN
```

Fix: stop the duplicate process or restart the LaunchAgent with `kickstart -k`.

Missing bot-jobs checkout:

```text
bot-jobs-linear directory not found
```

Fix: make sure `/Users/nur/bot-jobs-linear` exists, or set `LINEAR_TRIGGER_BOT_JOBS_DIR` before reinstalling.

Old service version:

```text
Local trigger service is running an older version
```

Fix:

```bash
cd /Users/nur/chrome-extensions/MailroomNavigator/automation
./install-linear-trigger-launchagent.sh
```

Chrome still shows unavailable after Terminal health is OK:

1. Reload the unpacked Mailroom Navigator extension in `chrome://extensions`.
2. Refresh the tab with the sidebar.
3. Reopen the sidebar and press `Restart Trigger Service` only if needed.

## Daily Use

You do not need to keep a Terminal open. The LaunchAgent keeps the service alive in the background.
When the panel says `Local trigger ready.`, press `Trigger Linear` or `Reconcile Linear`.
Use dry-run checkboxes when you want to preview without creating or closing Linear issues.
