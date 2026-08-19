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
3. Open the extension, enter the exact practice name and ODS ID, and click **Start**. The extension opens a separate worker window automatically.
4. Keep the dedicated worker window open, not minimized, and partly visible. Continue your work in the original Chrome window; do not reuse the worker window.
5. Supervise the first completion. Click **Stop** immediately if BetterLetter behaves unexpectedly.

The separate worker window keeps BetterLetter's automation page visible while you use other Chrome tabs. If that window is minimized or hidden, the extension waits without consuming a completion attempt and resumes after it is restored.

If Chrome freezes or discards the worker for resource management, the extension briefly focuses that worker to wake it, resumes the same verified job state, and returns focus to the window you were using.

Before either completion control is used, the extension now waits for the owning Phoenix LiveView socket to be connected. A server completion attempt is counted only after Phoenix exposes its `phx-click-loading` delivery signal (or the page has already reached an authoritative completed/navigation result). A disconnected or locally handled no-op click is reloaded and retried without consuming one of the two server attempts. If Phoenix accepts two submissions and the exact fresh job page still reports `paused`, the extension stops because that indicates a BetterLetter job/server issue rather than an unsafe reason to keep clicking.

If a reconnecting job page temporarily loses its Document ID or Status fields, the extension waits and performs at most two fresh exact-page reloads without clicking anything. A stable, connected page that displays a different numeric Document ID still stops immediately before any action.

After returning to the dashboard, the extension also waits for a connected LiveView and an authoritative row count. A blank or partially hydrated dashboard is never treated as an empty queue; it is reloaded at most twice before the run stops safely for inspection.

The extension is limited to `https://app.betterletter.ai/admin_panel/bots/*`, stores run state only in Chrome local extension storage, and contains no analytics or external network code.
