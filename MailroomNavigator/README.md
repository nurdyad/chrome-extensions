# MailroomNavigator

MailroomNavigator is a single BetterLetter extension that combines three workspaces:

1. `Navigator` for practice lookup/navigation
2. `Job Panel` for document/job triage and link actions
3. `Others` for utility workflows (email formatter, workflow bulk create, Linear + Slack, bookmarklet tools)

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
  - `practiceInput` with suggestions (`Practice Name / ODS`)
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
- Practice CDB search:
  - `Search by Practice CDB` input with suggestion list
- Practice status card fields:
  - `ODS Code`
  - `EHR Type`
  - `Quota`
  - `Collected`
  - `Service Level`
  - `CDB`
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

#### Linear Issue + Slack

- Creates a Linear issue and posts to Slack.
- Inputs:
  - Linear API key
  - Team key
  - title
  - description
  - priority
  - Slack delivery mode (bot token/channel or webhook)
- Buttons:
  - `Create + Post`
  - `Save Config`
  - `Trigger Linear` (calls local trigger service)
  - `Clear Saved Config`
- Status badges:
  - `linearSlackStatus`
  - `linearTriggerStatus`

#### Bookmarklet Tools

- `UUID Picker`
- `Get Docman Group Names`
- Tools render inside extension modal so they stay layered over the main panel.

## Keyboard Shortcuts

- Chrome command (`manifest.json`):
  - macOS: `Command+Shift+M`
  - others: `Ctrl+Shift+M`
  - action: show live summary tooltip in the active Chrome tab
- Optional macOS global hotkeys (automation):
  - `Cmd+Shift+9` (primary)
  - `Cmd+Ctrl+9` (fallback)
  - action: trigger live BetterLetter summary from any app

## Automation Components (Optional)

`MailroomNavigator/automation` provides:

- morning login/session refresh with OTP
- dashboard summary notifications
- local trigger server for `Trigger Linear`
- global hotkey daemon with menu-bar heartbeat

See:

- `SETUP.md` (cross-platform install)
- `automation/README-morning-login.md` (macOS automation detail)

## Security Notes

- `.env` is ignored by git. Use `.env.example` as template.
- Runtime artifacts are ignored:
  - `.automation-state/`
  - `logs/`
- Do not commit real API tokens (Linear/Slack) or auth state files.

