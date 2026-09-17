# Extension support and overlap

**MailroomNavigator / BetterLetter All-in-One is the primary maintained package for this release series.** Its integrated Navigator, Job Panel, UUID Picker, password tools and utilities are the supported starting point for colleagues following this repository's current setup guide.

The table inventories tracked manifests and their declared purposes. “Legacy overlap” means a separate package duplicates part of the integrated product; it does **not** establish that its code is broken, formally retired or never maintained. No repository-wide archival declaration or comprehensive pairwise compatibility test exists. Do not interpret different folder names as proof that extensions cannot interfere.

| Folder | Declared role / overlap | Installation guidance |
| --- | --- | --- |
| `MailroomNavigator` | Current integrated navigation, jobs, UUID lookup, password and utility workflows | Primary maintained installation; use its Setup and release checks. |
| `BL-Mailroom` | Legacy overlap: practice/mailroom navigation, email formatting and passwords | Prefer the integrated package for those features; disable while diagnosing duplicate UI. |
| `PracticeNavigator` | Legacy overlap: practice/ODS navigation | Standalone alternative; generally unnecessary alongside the integrated Navigator. |
| `BetterLetterJobManager` | Legacy overlap: jobs dashboard and rejected/preparing triage | Standalone alternative; may act on pages also used by MailroomNavigator. |
| `BetterletterPasswordExtension` | Legacy overlap: practice password tools | Standalone alternative; both packages inject into practice pages. |
| `EmailFormatter` | Legacy overlap: formatting email lists | Standalone utility alternative to Others; manifest has no automatic content script. |
| `PracticeSettingsOpener` | Legacy overlap: opening practice settings | Standalone utility alternative to Navigator. |
| `betterletter-bulk-workflows` | Legacy overlap: creating custom workflow groups | Standalone alternative to the integrated workflow utility; mutations require deliberate user action. |
| `oban-doc-navigator` | Legacy overlap: opening Oban jobs by document ID | Standalone utility alternative to Job Panel links. |
| `Tabs-Manager` | Separate tab/link management tool | Optional standalone tool; combined behavior is not certified by MailroomNavigator tests. |
| `PracticeOnboardingAutomation` | Separate Airtable-driven practice creation/configuration; some onboarding tasks overlap | Optional specialist workflow; review its own instructions and page injections before combining. |
| `betterletter-safe-completer` | Separate filtered Docman job-completion workflow on bot pages | Optional specialist workflow; job mutations are outside a passive compatibility check. |
| `job-notes` | Separate sticky notes for dashboard rows; broad content-script match | Optional adjunct; inspect its own scope and test on an approved page. |

## Supported baseline and combinations

- **MailroomNavigator alone:** the supported baseline for this guide and this release's automated tests. Live Chrome smoke testing is still required for a release.
- **MailroomNavigator plus a legacy overlapping package:** not part of the default supported setup. Disable the redundant package first when controls duplicate or behavior is confusing. Shared page matches indicate potential interaction, not a proven conflict.
- **MailroomNavigator plus a specialist/adjunct package:** no blanket compatibility claim. Enable one at a time, follow each package's README and verify only read-only behavior on approved test pages before any intended mutations.
- **Legacy packages without MailroomNavigator:** remain separately loadable based on their manifests, but this release's tests and version number do not certify them. Their maintenance/support status must be confirmed with the maintainer.

To isolate an overlap, note enabled extensions in `chrome://extensions`, disable only the suspect package, and refresh the affected page to remove its existing content script. Compare with the MailroomNavigator-only baseline. Record package versions and exact symptoms; do not uninstall packages or delete their saved data merely to test compatibility.

Install and update MailroomNavigator using [Setup](../SETUP.md) and [Upgrading](UPGRADING.md). This matrix describes source-level overlap, not measured runtime conflicts.
