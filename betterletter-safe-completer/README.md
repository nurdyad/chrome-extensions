# BetterLetter Safe Job Completer

This local Chrome extension processes one paused `docman_delete_original` job at a time. It is fail-closed: a URL, practice, job type, status, job ID, or result mismatch stops the run.

## Install or restore

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `betterletter-safe-completer` folder. If it is already listed, click **Reload** instead.
4. Pin **BetterLetter Safe Job Completer**.

## Safe use

1. Open the BetterLetter bots dashboard while signed in.
2. Check the intended practice, job type, and paused status.
3. Open the extension, enter the exact practice name and ODS ID, and click **Start**.
4. Supervise the first completion. Click **Stop** immediately if BetterLetter behaves unexpectedly.

The extension is limited to `https://app.betterletter.ai/admin_panel/bots/*`, stores run state only in Chrome local extension storage, and contains no analytics or external network code.
