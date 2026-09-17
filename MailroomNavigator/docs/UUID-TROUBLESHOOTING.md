# UUID lookup: symptom-to-check guide

A lookup follows this path: dashboard/picker → extension background worker → local trigger service → configured SQL connection → saved result → picker. A copied/checked mark records a UI interaction, not database success.

## Start with the visible symptom

| Symptom | Check next | Meaning / safe next step |
| --- | --- | --- |
| No UUID rows | Confirm the active BetterLetter page contains UUIDs. Clear search/date/outcome/status filters. | The picker combines page rows and the latest fresh batch. Paste one approved full UUID into Check a UUID to isolate page extraction. |
| All controls disappeared | Press Alt+Shift+H, check `chrome://extensions/shortcuts`, or use the popup's Show page toolbars recovery control. | Visibility can be hidden per tab. Reloading is not the only recovery path. |
| No valid UUIDs / skipped inputs | Use a complete hyphenated UUID for batches. | Invalid values and duplicates are skipped. Individual lookup accepts a supported fragment, but a fragment can be ambiguous. |
| Pending / elapsed time increases | Wait for the current request and watch completed/total counts. | Batches run two requests at a time. Pending is not a successful match and elapsed time is not an ETA. |
| Found, with document or bot-job status | Read the result's ID/status. | A found job may have no document ID. Rejected is a document outcome, not a network failure. |
| Not found | Verify the full UUID, intended environment and database configuration with the maintainer. | The request completed without a match. This does not prove a document was deleted, nor is it the same as a failed connection. |
| Failed lookup / timeout | Check local-service reachability below, then inspect the sanitized error. | Do not treat failed lookups as absent documents. Use Failed lookups only to isolate them. |
| Checked batch but list is empty | Remove filters; confirm the extension/page were refreshed together; check for a storage warning or expired batch. | Only the latest batch is retained. Results older than 15 minutes are excluded when loaded/rendered; rerun for fresh status. |
| Could not save UUID results | Record the storage warning; reload the extension/page, then retry a small approved batch. | Chrome storage failed. A completed database request does not guarantee a saved sidebar result. |
| Rows return after Clear | Check whether a batch is still running. | Clear removes saved/displayed rows; it currently does not cancel active requests. Later batch updates can repopulate the list. |

## Read-only checks

From the repository root, these commands do not modify service or issue state:

```sh
git status --short
git rev-parse HEAD
node --version
curl --max-time 5 http://127.0.0.1:4817/health
```

In Windows PowerShell, use `curl.exe --max-time 5 http://127.0.0.1:4817/health` to avoid the older PowerShell `curl` alias. Substitute the configured local host/port if changed.

- **Connection refused / no listener:** inspect whether the existing service manager is running. Follow [Setup](../SETUP.md) or [Upgrading](UPGRADING.md) to start/restart that service; do not run a second copy.
- **HTTP health response:** the service is reachable. Health does not execute a representative UUID query or certify database credentials, proxy access, table permissions or compatible service code.
- **Database/configuration error on lookup:** have the maintainer check the local `.env` variable names against `.env.example` and the SQL proxy/network configuration. Do not print passwords or send `.env` in a bug report.
- **Only some UUIDs fail:** retain found/not-found/failed totals and an approved synthetic example. Avoid repeated whole-batch retries while diagnosing a timeout.
- **Works after reload but old tabs fail:** refresh those tabs to replace their content scripts. Check extension errors via `chrome://extensions` and the extension service-worker inspector.

On macOS, `bash MailroomNavigator/automation/check-linear-trigger-service.sh` reads LaunchAgent, socket, health and recent-log information. Its output can include internal configuration, names or error data; review and redact it before sharing. Inspect relevant log lines locally rather than uploading whole logs.

## What to share

Report extension version, Git commit, operating system, browser version, approximate time/time zone, the affected surface, whether health was reachable, outcome totals and a short sanitized error. Include precise reproduction steps using synthetic or approved IDs. Remove tokens, credentials, real document/patient data and internal URLs from screenshots or logs. A screenshot of a copied mark alone cannot establish lookup success.

Do not use Reconcile, Restart Service, issue creation or assignment changes as diagnostic probes. Those perform actions; this guide's checks are read-only apart from an explicitly chosen test lookup.
