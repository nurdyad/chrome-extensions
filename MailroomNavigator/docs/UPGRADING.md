# Updating a colleague's installation

These steps apply to a Git checkout loaded unpacked in Chrome. A GitHub merge does not automatically update another computer. Pulling changes also does not reload an already running extension or Node service.

## Before updating

1. Finish active batches/automation and note the extension version in `chrome://extensions`.
2. In the repository directory, run `git status --short` and `git rev-parse HEAD`. Save the commit as the known-good rollback point.
3. If Git shows local changes, preserve them on a branch/commit before switching branches. Do not discard them to make the pull succeed.
4. Keep `.env` and `.automation-state` local. If the release changes stored-data formats, make a private backup before upgrading; never attach that backup to an issue.
5. Read the PR's compatibility notes. UI-only changes require Chrome reload/page refresh; service changes additionally require a service restart. Dependency changes require `npm ci`.

## Pull and reload

With a clean checkout, from the repository root:

```sh
git switch main
git pull --ff-only
npm --prefix MailroomNavigator/automation run check
```

If the pull cannot fast-forward, stop and resolve the branch divergence with the maintainer rather than force-resetting local work.

Open `chrome://extensions`, find **BetterLetter All-in-One**, and click **Reload**. Confirm its version matches `MailroomNavigator/manifest.json`. Refresh each open BetterLetter tab so it receives the new content scripts. Close/reopen any detached extension panel. If there are duplicate controls, check which overlapping extensions are enabled.

## Service or dependency changes

For dependency changes, run from the repository root:

```sh
npm --prefix MailroomNavigator/automation ci
```

Restart using the method already managing this installation; do not start a second server on the same port.

- **macOS LaunchAgent:** `launchctl kickstart -k "gui/$(id -u)/ai.betterletter.mailroomnavigator.linear-trigger-server"`. If the agent is not installed, follow [Setup](../SETUP.md); a failed kickstart is not a successful restart.
- **Manual macOS/Linux:** stop the server in its own terminal with Ctrl+C, then run `bash MailroomNavigator/automation/start-linear-trigger-server.sh` from the repository root.
- **Manual Windows:** stop that server with Ctrl+C, then run `MailroomNavigator\automation\start-linear-trigger-server.cmd` from the repository root in Command Prompt.
- **Another process manager:** restart the existing configured service through that manager. Do not terminate unrelated Node processes.

Check `http://127.0.0.1:4817/health` (or the locally configured host/port), then perform one approved UUID lookup. Health reachability alone does not prove the database works. Check the toolbar, theme and a copy action before resuming normal work.

## Rollback

A source rollback must keep the extension and service compatible. Check the release notes for irreversible migrations before proceeding; restoring code does not reverse stored-data changes.

1. Preserve any new local changes and stop active automation.
2. With a clean checkout, run `git switch --detach <known-good-commit>` using the commit recorded before the update. This is a temporary local checkout; it does not rewrite main or GitHub history.
3. If dependencies changed, rerun `npm --prefix MailroomNavigator/automation ci`.
4. Reload the extension, refresh BetterLetter tabs, and restart the service from the same checkout if it changed. Repeat health and an approved lookup.
5. Report the failed and working versions/commits with sanitized errors. Do not publish secrets or real document contents.
6. After the repair is merged, return to `main`, pull with `--ff-only`, and repeat the update steps.

See [release/version policy](RELEASES.md) for compatibility expectations. ZIP installations need the equivalent replacement from a trusted release, keeping the folder Chrome loads and the service installation aligned; Git commands do not update an unrelated ZIP directory.
