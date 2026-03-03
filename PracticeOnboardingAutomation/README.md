# Practice Onboarding Automation (v0.1.0)

Automates BetterLetter practice onboarding from Airtable:

1. Reads one Airtable onboarding record.
2. Creates a practice at `/admin_panel/practices/new`.
3. Enables Self Service in Service Settings when subscription type is self-service.
4. Opens EHR Settings and fills:
   - Practice CDB (from EMIS Site Code / Emis Site code field)
   - EMIS API username/password
   - EMIS Web username/password
   - Docman username/password
5. Pulls credentials from the Google Doc URL in the Airtable `EMR Access Details` field.

## Required Airtable fields

This extension looks for these fields (case/spacing tolerant):

- `ODS` (or `ODS code`)
- `Practice Name` (or `Practice Name (must match EMIS)`)
- `EMR`
- `subscription type`
- `Emis Site code` (or `EMIS Site Code`)
- `EMR Access Details` (Google Doc URL)

## Setup

1. Open `chrome://extensions/`
2. Enable Developer Mode.
3. Click **Load unpacked**.
4. Select the `PracticeOnboardingAutomation` folder.
5. Pin the extension.

## Usage

1. Click extension icon.
2. Enter:
   - Airtable token
   - Base ID
   - Table name/id
   - Optional view
   - Optional record ID
3. Click **Run Onboarding**.
4. Keep your BetterLetter and Google sessions logged in.

## Notes

- If `record ID` is empty, the extension pulls the first record from the specified view (or first record in table).
- EMR type mapping currently maps anything containing `EMIS` to BetterLetter `docman_emis`.
- If the Google Doc export is blocked, it falls back to reading text from the open doc page.
