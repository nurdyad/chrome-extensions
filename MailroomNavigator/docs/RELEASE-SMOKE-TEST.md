# Colleague release smoke test

Record tester, date, OS/browser, extension version, Git commit and service commit/start method. Use an approved test environment with synthetic or explicitly approved test IDs. Do not paste production document contents into screenshots or issue reports. Mark every check **Pass / Fail / Not tested**; absence of an error is not a pass if the action was not exercised.

## Preparation

- [ ] Run `npm --prefix MailroomNavigator/automation run check` from the repository root and record the result.
- [ ] Follow [Upgrading](UPGRADING.md), reload the unpacked extension and refresh the test page. Confirm Chrome's version matches the manifest.
- [ ] Use MailroomNavigator alone initially; record any additional enabled extensions.
- [ ] Confirm the local `/health` endpoint responds. Do not infer database success from health alone.

## Short functional pass

| Check | Expected result |
| --- | --- |
| Open Navigator, Job Panel, UUID Picker and Others | Correct surface opens; headings/inputs align and content remains scrollable. |
| Collapse then expand the side panel | The full panel/rail hides as configured; the expand control restores access. No stuck overlay blocks the page. |
| Press Option/Alt+Shift+H twice, then Option/Alt+Shift+J | Both toolbars hide in every Chrome tab/window and remain hidden after the second H. J restores them globally. Test from a different tab, including a restricted Chrome page; new/refreshed pages inherit hidden state. If a command is unassigned/conflicted, configure it in Chrome's extension shortcut settings. |
| Use popup Show page toolbars recovery | Toolbars reappear across all tabs/windows. |
| Switch light/dark mode | Open surfaces are readable, with visible focus indicators and no unreadable status/reason text. Test switching between surfaces, not just the theme icon. |
| Look up one approved known UUID | Expected document/job ID and status appear; copy the ID and UUID into a private scratch field to verify exact values. A not-found response is not success for a fixture expected to exist. |
| Run a small mixed batch using approved fixtures | Progress is visible without hovering the row. Found/not-found/failed counts add up to the valid unique input count; invalid/duplicate skips are reported. Simulate failures only in a controlled test setup. |
| Copy a card UUID and reopen/reload the picker | Copied mark remains for that UUID. Document ID/status/reason copying works without a separate copy icon. |
| Search by document ID/reason; select outcome/status; change sort | Visible counts, Copy Visible and export use the same filtered rows. Not-found differs from failed; ties/missing values have stable order. |
| Export test outcomes | CSV contains expected IDs/status/reason/errors with intact multiline/quoted values. No credentials or raw page contents appear. |
| Reset marks, then Clear a completed test list | Reset retains rows and removes marks; Clear removes current rows/results. Finish the batch first: Clear currently does not cancel running work. |

## Layout and accessibility pass

- [ ] At the narrowest panel size used by colleagues and at 125%/150% browser zoom, document IDs, UUIDs, actions and filter controls are reachable; long reasons wrap without hiding controls.
- [ ] Tab through search, filters, card actions, clear/reset and rail controls. Focus is visible and icon-only actions have meaningful accessible labels/tooltips.
- [ ] With OS reduced motion enabled, interactions work without unnecessary animation. Check both themes and a long result list.
- [ ] Check `chrome://extensions` and the service-worker/page console for new errors. Capture only sanitized relevant details.

## Actions that require separate opt-in

Reconcile, Restart Service, creating issues, saving assignment rules, document actions and onboarding can affect service or external state. Do not click them merely to complete the read-only smoke pass. For an approved test environment, record the requested action and expected result before running it. Reconcile preview/dry-run must be selected explicitly if that is the intended check; verify no update was performed.

Automated assignment tests cover concurrency and weighted fairness without creating Linear issues. Do not create real tickets to reproduce those tests.

## Report

Include the version/commit pair, checks run, pass/fail/not-tested counts, sanitized reproduction steps and any browser checks that could not be performed. Link the relevant PR/issue. A release with untested layout or integrations should say so explicitly rather than being described as fully verified.

Use [UUID troubleshooting](UUID-TROUBLESHOOTING.md) for lookup failures and [extension overlap guidance](EXTENSION-COMPATIBILITY.md) for duplicate controls.
