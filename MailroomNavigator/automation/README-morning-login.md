# macOS local-service runbook

This tracked document preserves the path referenced by the repository README. The historical filename does not imply a scheduled morning login: the current installer creates a per-user LaunchAgent for the local trigger HTTP service. It uses `RunAtLoad` and `KeepAlive`; it does not schedule a daily Docman login.

For complete configuration and cross-platform installation, use [MailroomNavigator Setup](../SETUP.md). For existing installations, use [the upgrade guide](../docs/UPGRADING.md).

## Initial installation

Install Git and Node.js 18+, clone the repository, and create the private `MailroomNavigator/.env` from `.env.example` as described in Setup. Configure only integrations you intend to use. Then, from the repository root:

```sh
npm --prefix MailroomNavigator/automation ci
bash MailroomNavigator/automation/install-linear-trigger-launchagent.sh
```

Installation writes `~/Library/LaunchAgents/ai.betterletter.mailroomnavigator.linear-trigger-server.plist` and loads it into the current user's GUI domain. The plist points to this checkout, so moving/deleting the checkout breaks that installation. Reinstall after an intentional path change. Do not use the macOS installer on Windows or Linux.

The service wrapper reads `.env` (or `LINEAR_TRIGGER_ENV_FILE`), creates local log/state directories and starts `linear-trigger-server.mjs`. The default endpoint is `http://127.0.0.1:4817`; retain localhost binding for a normal single-machine installation. Database-dependent features additionally need the configured SQL connection/proxy.

## Read-only checks

```sh
bash MailroomNavigator/automation/check-linear-trigger-service.sh
curl --max-time 5 http://127.0.0.1:4817/health
```

The checker inspects the LaunchAgent, listener, health response and recent logs. Health success does not prove a UUID query succeeds. See [UUID troubleshooting](../docs/UUID-TROUBLESHOOTING.md) when the UI reports lookup errors. Review/redact diagnostics before sharing them.

Logs live under `MailroomNavigator/logs/`, including `linear-trigger-server.log`, `linear-trigger-server-launchd.out.log` and `linear-trigger-server-launchd.err.log`. Do not commit logs or `.automation-state`.

## Restart and removal

After an authorized service update, restart the existing agent:

```sh
launchctl kickstart -k "gui/$(id -u)/ai.betterletter.mailroomnavigator.linear-trigger-server"
```

Do not use restart as a read-only health probe, and finish active automation first. If the service was started manually, restart it in its own terminal instead of starting another instance.

To intentionally remove the LaunchAgent:

```sh
bash MailroomNavigator/automation/uninstall-linear-trigger-launchagent.sh
```

The uninstall script unloads the agent and removes its plist. It does not remove the Chrome extension, `.env`, logs or saved assignment data. Reload/refresh requirements for extension updates are covered in [the release policy](../docs/RELEASES.md).
