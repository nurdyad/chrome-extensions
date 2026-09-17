# Release versioning and compatibility

The extension release identifier is `MailroomNavigator/manifest.json` → `version`.
Use three numeric components, each within Chrome's 0–65535 limit, with no leading zeroes.
The automation package's `1.0.0` is a dependency-package identifier, not proof of extension/service compatibility.

## Version allocation

- Every release PR gets a unique extension version, including documentation-only PRs in a versioned release series.
- Continue the existing `1.N.0` sequence for compatible feature/fix PRs. Allocate the next N from the latest main and any earlier stacked releases; do not reuse another PR's number.
- Reserve a major increment for a deliberately incompatible service contract or storage migration. Describe migration and rollback limits in the PR before release.
- A patch component may identify an urgent correction to an already released version. Rebase later release branches to keep versions increasing.

This is the repository's release-number convention; a minor increment does not certify compatibility with every historic service build.

## Compatibility contract

Treat extension and local service from the same repository commit as the tested pair. State the tested extension version and commit in the PR. The service currently has no negotiated capability/version contract; `/health` success confirms reachability, not compatibility or a successful database query.

Every PR must say whether it changes only documentation/UI or also service behavior, environment configuration, dependencies or persisted data. Keep existing stored values readable for compatible releases. Introduce explicit schema/version and migration steps before incompatible persistence changes. Never remove colleagues' local `.env` files or assignment state as part of an update.

- UI/content script changes: reload the unpacked extension, then refresh affected BetterLetter pages.
- Service changes: update both components to the same commit and restart the service using its existing launch method.
- Dependency changes: run `npm ci` in `MailroomNavigator/automation` before restarting.
- Documentation-only changes: no runtime restart is needed; Chrome shows the new manifest version after reload.

## Release checklist

1. Start from current main, review local changes and confirm the intended issue/PR scope.
2. Set a unique manifest version and describe visible changes, compatibility impact, tests and known limitations in the PR.
3. Run `npm --prefix MailroomNavigator/automation run check` from the repository root.
4. Check affected flows in Chrome with approved test data; record any browser checks that were unavailable.
5. Merge only after required checks/review. For a stack, merge the first PR to main, retarget the next PR to main, verify its diff and version, then merge it. Repeat in order. Do not merge later PRs into an unmerged feature branch as a substitute for merging to main.
6. Pull main with `git pull --ff-only`, reload Chrome, refresh pages, and restart the service when indicated above.
7. Record the released commit and the previously working commit. Roll back extension and service together when contracts changed; preserve local configuration and inspect migration reversibility before rollback.

Do not delete stack branches until dependent PRs have been retargeted. A successful source/test check does not prove live UI layout or production integrations work.
