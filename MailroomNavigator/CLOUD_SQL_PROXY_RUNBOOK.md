# Cloud SQL Proxy Runbook

Audience: non-technical BetterLetter operators who need to connect safely to the production read replica for stuck-letter investigation.

This guide documents what we set up on Nur's Mac on 16 July 2026 and how to repeat it without guessing commands each time.

## What This Is

Cloud SQL Proxy is a local tunnel.

Think of it like this:

```text
Your terminal -> Cloud SQL Proxy -> BetterLetter production read replica
```

The proxy does not log you into the database by itself. It only opens a secure local door on your Mac.

After the proxy is running, you use `psql` to log into the database through that local door.

## What We Are Connecting To

Database instance:

```text
betterletter:europe-west2:betterletter-production-read-replica
```

Local proxy address:

```text
127.0.0.1:15432
```

Database name:

```text
mailroom_prod
```

Database user:

```text
reporting
```

Password location:

```text
Bitwarden item: betterletter-production reporting user
```

Important: do not paste the database password into Slack, GitHub, Linear, or ChatGPT/Codex.

## One-Time Setup

### 1. Check Cloud SQL Proxy Exists

Run:

```bash
ls -l /Users/nur/cloud-sql-proxy
```

Expected:

```text
/Users/nur/cloud-sql-proxy
```

If you see:

```text
not a directory: cloud-sql-proxy
```

that is okay if you tried `cd cloud-sql-proxy`. On this Mac, `cloud-sql-proxy` is a program, not a folder.

### 2. Check Google Credentials

Cloud SQL Proxy uses your Google Application Default Credentials.

Run:

```bash
ls -l /Users/nur/.config/gcloud/application_default_credentials.json
```

If that file exists, continue.

If it does not exist, run:

```bash
gcloud auth application-default login
```

Then follow the browser login flow.

### 3. Check `psql` Exists

Run:

```bash
command -v psql
```

On Nur's Mac this returned:

```text
/opt/homebrew/opt/libpq/bin/psql
```

If it says `psql not found`, install PostgreSQL/libpq tools or ask SRE for help.

## Daily Connection Steps

You need two terminal windows.

### Terminal 1: Start The Proxy

Run this and keep the terminal open:

```bash
/Users/nur/cloud-sql-proxy \
  --address 127.0.0.1 \
  --port 15432 \
  betterletter:europe-west2:betterletter-production-read-replica
```

Expected successful output:

```text
Authorizing with Application Default Credentials
[betterletter:europe-west2:betterletter-production-read-replica] Listening on 127.0.0.1:15432
The proxy has started successfully and is ready for new connections!
```

Do not close this terminal while you are using the database.

### Terminal 2: Connect To The Database

Open a second terminal and run:

```bash
psql -h 127.0.0.1 \
  -p 15432 \
  -U reporting \
  -W mailroom_prod
```

It will ask:

```text
Password:
```

Get the password from Bitwarden:

```text
betterletter-production reporting user
```

When typing the password, you will not see dots or stars. That is normal.

If login works, you will see:

```text
mailroom_prod=>
```

That means you are inside the database.

## Safe First Commands

These commands only read information.

Check where you are:

```sql
select current_database(), current_user;
```

List tables:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;
```

If the output is long and you see a pager, press:

```text
q
```

to return to the database prompt.

Exit the database:

```sql
\q
```

Stop the proxy:

Go back to Terminal 1 and press:

```text
Control + C
```

## What The Proxy Status Means

Good status:

```text
Listening on 127.0.0.1:15432
The proxy has started successfully and is ready for new connections!
```

Meaning: the tunnel is open.

Connection log:

```text
Accepted connection from 127.0.0.1:52611
client closed the connection
```

Meaning: something tried to connect, then closed. This is normal when testing or when a password was not supplied.

## Common Errors

### `zsh: parse error near '>>'`

Cause: you copied a placeholder like this:

```text
<<path to cloud config json>>>>
```

Fix: do not type placeholders. Use the simple Application Default Credentials command:

```bash
/Users/nur/cloud-sql-proxy \
  --address 127.0.0.1 \
  --port 15432 \
  betterletter:europe-west2:betterletter-production-read-replica
```

### `no such file or directory: /REAL/PATH/TO/service-account-key.json`

Cause: `/REAL/PATH/TO/...` is a placeholder, not a real file.

Fix: on this Mac, you do not need that file if Application Default Credentials are working. Use the proxy command without `--credentials-file`.

### `cd: not a directory: cloud-sql-proxy`

Cause: `cloud-sql-proxy` is an executable file, not a folder.

Fix: run it directly:

```bash
/Users/nur/cloud-sql-proxy --version
```

### `127.0.0.1:15432 - no response`

Cause: the proxy is not running, or it has not finished starting.

Fix:

1. Check Terminal 1 is still open.
2. Confirm it says `Listening on 127.0.0.1:15432`.
3. Try again.

### `fe_sendauth: no password supplied`

Cause: the database asked for a password and none was supplied.

Fix: connect using `-W` and type the password from Bitwarden:

```bash
psql -h 127.0.0.1 -p 15432 -U reporting -W mailroom_prod
```

### `Operation not permitted`

Cause: this can happen when Codex tries to connect from a sandboxed terminal.

Fix: run the command in your normal terminal, or allow Codex to run the local TCP test outside the sandbox.

## Why We Are Doing This

The MailroomNavigator extension currently gets some information by reading BetterLetter web pages in your signed-in Chrome session.

Examples:

- practice ODS
- CDB
- practice status
- Docman settings
- bot job dashboard rows
- stuck/preparing letters
- Oban error details

Using Cloud SQL may let us get some of this data more directly and reliably.

The likely future architecture is:

```text
Chrome extension
  -> local trigger service
  -> Cloud SQL Proxy
  -> production read replica
```

The Chrome extension should not connect directly to the database.

## Optional: Enable MailroomNavigator SQL Lookup

After the proxy works, MailroomNavigator can ask its local service to read practice settings from SQL instead of scraping the BetterLetter practice page.

Open:

```text
/Users/nur/chrome-extensions/MailroomNavigator/.env
```

Add or update these lines:

```bash
MAILROOMNAV_SQL_ENABLED=1
MAILROOMNAV_SQL_HOST=127.0.0.1
MAILROOMNAV_SQL_PORT=15432
MAILROOMNAV_SQL_DATABASE=mailroom_prod
MAILROOMNAV_SQL_USER=reporting
MAILROOMNAV_SQL_PASSWORD=<password from Bitwarden>
```

Use the password from:

```text
Bitwarden item: betterletter-production reporting user
```

Then restart the local MailroomNavigator service.

On macOS:

```bash
cd /Users/nur/chrome-extensions/MailroomNavigator/automation
launchctl kickstart -k "gui/$(id -u)/ai.betterletter.mailroomnavigator.linear-trigger-server"
./check-linear-trigger-service.sh
```

Check the health output includes:

```text
"database":{"enabled":true,"configured":true
```

If SQL lookup is not configured or the proxy is not running, MailroomNavigator falls back to the existing BetterLetter page scraping.

## Safety Rules

- Use the read replica only.
- Use the `reporting` user only.
- Prefer `select` queries.
- Do not run `update`, `delete`, `insert`, `truncate`, `drop`, or `alter`.
- Do not paste database passwords into chat tools.
- Close the proxy when finished.

## Useful Official Docs

Cloud SQL Auth Proxy install/setup:

```text
https://docs.cloud.google.com/sql/docs/postgres/connect-auth-proxy
```

Run via Docker:

```text
https://docs.cloud.google.com/sql/docs/postgres/connect-auth-proxy#start-proxy
```

Credentials from authenticated gcloud CLI:

```text
https://docs.cloud.google.com/sql/docs/postgres/connect-auth-proxy#credentials-from-an-authenticated-gcloud-cli-client
```

## Screenshot Checklist

When adding this to Notion, useful screenshots are:

1. Terminal 1 showing:

```text
The proxy has started successfully and is ready for new connections!
```

2. Terminal 2 showing:

```text
mailroom_prod=>
```

3. Bitwarden item title only:

```text
betterletter-production reporting user
```

Do not screenshot or share the password value.
