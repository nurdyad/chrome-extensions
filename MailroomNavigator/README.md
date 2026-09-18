# MailroomNavigator

MailroomNavigator is a single BetterLetter extension that combines three workspaces:

1. `Navigator` for practice lookup/navigation
2. `Job Panel` for document/job triage and link actions
3. `Others` for utility workflows (email formatter, workflow bulk create, Linear issue, bookmarklet tools)

Use `SETUP.md` for installation on a new machine.

## Feature Map

### Global Navigation

- A floating shortcut toolbar sits at the top of the webpage, below Chrome's browser UI. Drag its left-hand grip to reposition it; the position is saved per website. Focus the grip and use arrow keys to move (Shift for 1-pixel steps), or press Home/double-click the grip to reset to the top centre. Its position adjusts to stay within the window.
- The right-side rail opens Navigator, Job Panel, UUID Picker, Bookmarklet Tools and Others.
- Reconcile and Restart Service rail icons run actions; their full controls remain in Others.
- The theme icon sits above the collapse/expand icon. Collapse hides the rail/panels while retaining an expand control.
- `Option/Alt+Shift+H` hides the top toolbar and right rail across all tabs/windows; `Option/Alt+Shift+J` shows them again. Repeating Hide keeps them hidden. The setting is saved for this Chrome profile, and new/refreshed tabs inherit it. Chrome must be focused; these are not system-wide desktop shortcuts. Customize both commands in `chrome://extensions/shortcuts`; the popup recovery control also shows toolbars globally.
- Toast/status indicators report action progress. Refresh a page after reloading the extension.

### Navigator Tab (Practice Navigator)

- Practice search:
  - `practiceInput` with suggestions (`Practice Name / ODS / CDB`)
  - `Reset` button to clear/reload selection
  - Header quick actions:
    - `+` new practice
    - users
    - all practices
- Practice quick-open buttons (enabled after a valid practice is selected):
  - `Collection`
  - `Preparing`
  - `Rejected`
  - `Settings`
  - `Task Recipients`
- Docman + EMIS job checklist filters:
  - multi-select checkboxes
  - `Open Selected` buttons for both groups
  - supports `All practices` plus specific practice ODS URLs
- Practice status card fields:
  - `ODS Code`
  - `EHR Type`
  - `Quota`
  - `Collected`
  - `Service Level`
  - `CDB`
  - `EMIS API Username`
  - `EMIS API Password`
  - `EMIS Web Username`
  - `EMIS Web Password`
  - `Docman Username`
  - `Docman Password`
  - `Preparing`
  - `Edit`
  - `Review`
  - `Coding`
  - `Rejected`

### Job Panel Tab

#### Quick Document Search

- Input: `Paste or type ID...`
- Dashboard suggestions are shown from paused job pages.
- Validation badge indicates ID state.
- Copy link buttons:
  - `Copy Jobs URL`
  - `Copy Oban URL`
  - `Copy Log URL`
  - `Copy Admin URL`
- Quick open buttons:
  - `Jobs`
  - `Oban`
  - `Log`
  - `Admin`

#### Single ID Status Check

- Input: `jobStatusInput` (UUID or numeric, including parsed IDs from URLs)
- Suggestion dropdown for recent/known job IDs
- Buttons:
  - `Open Status`
  - `Clear`
  - `Copy Job ID`
  - `Copy Job Link`
  - `Open Problem Review` (opens `/admin_panel/error_fixer/problem_linked_to_problem_review/<job_id>`)

#### UUID Lookup

- Input: `uuidLookupInput`
- Status badge: `uuidLookupStatus`
- Looks up a full UUID or 6+ character UUID fragment through the local trigger service
- Uses Cloud SQL/read-replica config through the local trigger service
- Requires local trigger service plus `MAILROOMNAV_SQL_*` database config

#### Unified UUID Picker

Open **UUID Picker** from the right rail. **Check a UUID** performs an individual lookup; **Check N UUIDs** on a dashboard row runs a batch. One list combines the most recent batch with UUIDs extracted from the current page, deduplicated by UUID. Batch result cards come first in source order. A compact result card shows document ID and UUID together, an Open link and status/reason below; there is no separate copy-icon requirement.

- Click the document ID or UUID to copy it. Click the status/reason text to copy that value. A successful card copy marks its UUID; a row Lookup action marks it checked. Saved marks gray completed rows and display Copied/Checked feedback.
- **UUID / SQL / RAW** chooses UUID copying format: plain UUID, single-quoted UUID, or source row text (falling back to UUID). Clicking a document ID still copies just the document ID. **Copy Visible** copies the filtered list in that format, separated by commas.
- **Search** matches UUID/source text, document ID, document/bot-job status and reason, or lookup error. The date filter matches available source date text; rows without a date do not gain one from lookup results.
- **Lookup outcomes** separates failed requests from successful queries with no match. **Result statuses** includes actual result statuses plus Pending and Unchecked. Filters combine; counts and Copy Visible follow the filtered list.
- **Sort** defaults to source order. Document ID sorts numerically; status sorts alphabetically. Ties retain source order and missing values appear last. Marks stay attached to UUIDs.
- **Export** downloads visible outcomes as CSV (UUID, date, outcome, document ID, status, reason, error). It does not export arbitrary result fields or raw page text. Copy format does not change export columns.
- The **trash icon (Clear)** removes current UUIDs/results from this workspace and clears the latest saved batch. A later batch may show those UUIDs again. Clear does not cancel a batch already running, so incoming results can reappear. There is currently no Undo.
- The **circular-arrow icon (Reset marks)** removes copied/checked marks without removing rows. Clear and Reset are different actions; hover or focus the icons for their labels.

Marks are stored locally in the Chrome profile (up to 1,000 copied and 1,000 checked UUIDs; up to 2,000 cleared IDs). They survive extension reloads but are not shared across colleagues. Live synchronization between separate picker instances is not guaranteed yet.

Only the latest batch is retained. Saved batches older than 15 minutes are considered stale when loaded/rendered and are not shown as fresh results. Rerun a lookup for current status; copied marks can remain after results expire. Page UUIDs may still appear as unchecked rows. Progress on the page shows completed/total counts, failures and elapsed seconds; completion separates found, not-found and failed totals. A storage failure explicitly warns that sidebar results could not be saved.

Lookups require the local service and its database connection. Use approved test data when checking behavior; copying a UUID is not proof that its lookup succeeded.

#### Bulk ID Actions

- Multi-ID textarea parser (comma/space/new line)
- Target select:
  - `Jobs`
  - `Oban`
  - `Log`
  - `Admin`
- Buttons:
  - `Open All`
  - `Copy all links`

#### Recent IDs

- Chips for recent document IDs and recent job IDs
- Metadata block per ID (when available):
  - document/job identifiers
  - job type
  - practice
  - latest status/error
  - attempts

### Others Tab

#### Email Formatter

- Input textarea -> formatted output textarea
- Buttons:
  - `Convert` (Name `<email>` list)
  - `Name` (name-only extraction)
  - `Copy`

#### Custom Workflow Groups

- Bulk paste workflow names
- Options:
  - `Skip existing workflow names`
  - `Convert names to Title Case`
- Buttons:
  - `Run Bulk Create`
  - `Test Parse`
- Includes progress and status badges.

#### Linear Issue

- Creates a Linear issue using local `.env` credentials (no key/team inputs in panel).
- Input flow:
  - paste Document ID or full stuck-letter detail block
  - click `Generate Details` to build title + description
  - in `Serverless Lite`, use `Copy Title` / `Copy Description` to paste the draft into Linear manually
  - optional Slack sync:
    - click `Sync Slack` to load workspace channels/users into suggestions
    - enable `Notify Slack`
    - choose target type: `Channel` or `User (DM)`
    - pick/paste target ID (`C.../G...` for channel, `U...` for user)
  - review/edit and click `Create Linear Issue`
- Buttons:
  - `Generate Details`
  - `Copy Title` / `Copy Description` in `Serverless Lite`
  - `Create Linear Issue`
  - `Trigger Linear` (calls local trigger service)
- Status badges:
  - `linearSlackStatus` (issue generation/create status)
  - `linearTriggerStatus`

#### Bookmarklet Tools

- `UUID Picker`
- `Get Docman Group Names`
- Tools render inside extension modal so they stay layered over the main panel.

## File Structure

### High-Level Layout

```text
MailroomNavigator/
├── manifest.json
├── panel.html / panel.js
├── background.js
├── navigator.js / jobs.js
├── bot_dashboard_navigator.js / mailroom_page_integrator.js / password_content.js
├── bulk_workflow_groups.js
├── offscreen.html / offscreen.js
├── state.js / utils.js
├── css/
├── icons/
└── automation/
```

### Root Files

| File | What it does |
|---|---|
| `manifest.json` | Chrome extension manifest (permissions, scripts, commands, resources). |
| `panel.html` | Main extension UI layout for all tabs and controls. |
| `panel.js` | Main controller wiring UI events to modules and background actions. |
| `background.js` | Service worker: orchestration, caching, tab operations, Linear issue actions, summary jobs. |
| `state.js` | Shared in-memory state used by panel modules. |
| `utils.js` | Shared helpers (toasts, debounce, safe DOM writes, small utilities). |
| `README.md` | Feature and architecture overview (this file). |
| `SETUP.md` | Install guide for new machines/OS. |
| `.env.example` | Safe environment template (copy to `.env`). |

### Feature Modules

| File | What it does |
|---|---|
| `navigator.js` | Practice Navigator behavior: suggestions, practice selection, status rendering, action buttons. |
| `jobs.js` | Job Panel behavior: ID parsing, autocomplete lists, link generation, bulk actions, recent IDs. |
| `bulk_workflow_groups.js` | In-page automation helper for bulk workflow group creation. |

### Content / In-Page Scripts

| File | What it does |
|---|---|
| `bot_dashboard_navigator.js` | Adds floating quick actions and row metadata extraction on dashboard/mailroom pages. |
| `mailroom_page_integrator.js` | Integrates extra row-level helpers on mailroom table pages. |
| `password_content.js` | Password tools helper script for practice admin pages. |
| `offscreen.html` | Offscreen document host required by Chrome offscreen API. |
| `offscreen.js` | Offscreen worker logic for hidden-page scraping tasks. |

### Styling and Assets

| Path | What it does |
|---|---|
| `css/utilities.css` | Shared utility classes used across views. |
| `css/layout.css` | Main layout structure and spacing. |
| `css/buttons.css` | Button styles and variants. |
| `css/inputs.css` | Input/textarea/select styling. |
| `css/status.css` | Badge/status/validation styling. |
| `icons/` | Extension icons used by browser toolbar/manager pages. |

### Automation (Optional)

| File | What it does |
|---|---|
| `automation/package.json` | Local Node dependencies for automation scripts. |
| `automation/linear-trigger-server.mjs` | Local HTTP service used by `Trigger Linear` button. |
| `automation/start-linear-trigger-server.sh` | Runner wrapper for trigger server. |
| `automation/start-linear-trigger-server.cmd` | Windows runner wrapper for trigger server. |
| `automation/install-linear-trigger-launchagent.sh` | Installs trigger server LaunchAgent. |
| `automation/uninstall-linear-trigger-launchagent.sh` | Removes trigger server LaunchAgent. |
| `automation/check-linear-trigger-service.sh` | Diagnostic status/log helper for trigger service. |

### Generated Local-Only Paths (Not Committed)

| Path | Purpose |
|---|---|
| `.env` | Local secrets and machine-specific configuration. |
| `.automation-state/` | Runtime state/session files (storage state, run markers). |
| `logs/` | Runtime logs for the trigger server and Docman helper runs. |
| `automation/node_modules/` | Installed local dependencies. |

## Keyboard Shortcuts

- Chrome command (`manifest.json`):
  - macOS: `Command+Shift+M`
  - others: `Ctrl+Shift+M`
  - action: show live summary tooltip in the active Chrome tab
## Automation Components (Optional)

`MailroomNavigator/automation` provides:

- local trigger server for `Trigger Linear`
- Docman helper runners used by the Practice Navigator buttons

See:

- `SETUP.md` (cross-platform install)

## Security Notes

- `.env` is ignored by git. Use `.env.example` as template.
- Runtime artifacts are ignored:
  - `.automation-state/`
  - `logs/`
- Do not commit real API tokens (Linear) or auth state files.

## Repeatable checks

From the repository root, run `npm --prefix MailroomNavigator/automation run check` (Node.js 18+).
This checks the extension manifest, referenced assets and JavaScript syntax, then runs isolated regression tests.
No service credentials, running database or installed automation dependencies are needed for these checks.
Use `npm --prefix MailroomNavigator/automation run check:syntax` for syntax/manifest checks alone.
Failures return a nonzero exit code and identify the file. These checks do not replace browser smoke testing.

Release process: [versioning and compatibility policy](docs/RELEASES.md).

Lookup problems: [UUID troubleshooting decision tree](docs/UUID-TROUBLESHOOTING.md).

Before sharing a release: [colleague smoke-test checklist](docs/RELEASE-SMOKE-TEST.md).
