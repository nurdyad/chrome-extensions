# MailroomNavigator

MailroomNavigator is a single BetterLetter extension that combines three workspaces:

1. `Navigator` for practice lookup/navigation
2. `Job Panel` for document/job triage and link actions
3. `Others` for utility workflows (email formatter, workflow bulk create, Linear issue, bookmarklet tools)

Use `SETUP.md` for installation on a new machine.

## Feature Map

### Global Navigation

- Top buttons:
  - `Navigator`
  - `Job Panel`
  - `Others`
- The panel can be opened on any Chrome tab (`host_permissions: <all_urls>`).
- Toast/status indicators are shown inline in the panel.

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
