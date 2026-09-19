# MailroomNavigator Desktop preview

An **optional native desktop toolbar** for issue #237. It can move outside Chrome and onto another monitor. The extension remains usable without it. This is `2.0.0-alpha.1`, paired with extension `1.127.0`; it is not the final 2.0 release.

## Preview platform targets

- macOS 13 or later, Apple silicon and Intel build targets.
- Windows 10/11 x64 build targets. The pilot should use a supported, patched Windows installation.
- Chrome 116 or later, one paired normal Chrome profile per running companion. Incognito and multiple simultaneous paired profiles are not supported.
- Linux, Windows ARM64 and other browsers are outside this preview.

Windows and macOS must **both** pass the release checklist before 2.0. Build configuration is not evidence of a successful installation on a platform.

## Run from source

Use Node 22.12 or later. From `MailroomNavigator`:

```sh
npm --prefix desktop ci
npm --prefix desktop start
```

Load/reload this folder as an unpacked Chrome extension. In its **Others** panel, choose **Desktop companion**.

1. Copy the extension ID shown on that page.
2. In desktop Settings, paste that ID and save. Changing the approved ID replaces the pairing key.
3. Choose **Copy pairing key** in desktop Settings. Paste it into the extension's desktop settings, give the Chrome profile a recognizable label, and connect. Do not share the key; clear it from your clipboard after pairing.
4. Open Navigator on the BetterLetter tab you want to use and choose a practice.
5. In the desktop toolbar's target selector, choose that window/tab/practice explicitly. Buttons stay disabled until a valid target is selected.

The companion invokes the extension's existing navigation handlers. It does not duplicate login credentials, SQL access, UUID lookup or service controls. `Sent to the selected Chrome tab` acknowledges handler dispatch, not successful completion of the remote page load. Existing extension/service errors are still shown by the extension.

## Controls and recovery

- Drag the grip or brand area. Position is saved; missing-monitor positions are clamped back onto an available display.
- Tab to the grip and use arrow keys to move by 10 logical pixels; Home resets the position.
- The pin toggles always-on-top. This does not promise overlaying secure OS screens or every full-screen application/Space.
- Minus hides the toolbar. **Option/Alt+Shift+Space** toggles this desktop window even when Chrome is not focused. Change or disable it in Settings. A collision is reported rather than replacing another application's shortcut.
- The tray/menu-bar menu restores the toolbar, resets position, opens Settings or quits. Closing the toolbar hides it; Quit terminates it.
- Chrome's existing **Option/Alt+Shift+H** still controls the browser toolbars separately.
- Startup at login is off by default and applies only to an installed/packaged companion.
- On disconnect, navigation, practice change or target closure, selection is invalidated. Reopen Navigator and select the target again. Commands are never replayed after reconnect.
- Port 4818 already in use: quit the other companion and restart. Port 4817 belongs to the optional existing local service and is independent.
- To permanently disconnect, use Disconnect on the extension pairing page or replace the key in desktop Settings. Tray Disconnect drops the current connection; a still-enabled paired extension will reconnect.

## Build and test

```sh
npm --prefix automation run check
npm --prefix desktop test
npm --prefix desktop run test:native
npm --prefix desktop run dist:mac
npm --prefix desktop run dist:win
```

Run native tests and platform builds on their respective OS. The native smoke test uses a temporary profile and synthetic context: it checks the actual sandboxed renderer, native visibility, movement, theme and layout without connecting to a colleague's Chrome session. It does not validate the real pairing UI or multi-monitor mouse dragging. It saves a screenshot under the OS temporary directory.

Build output is in `desktop/dist`, excluded from git. macOS produces DMG/ZIP for ARM64 and x64; Windows produces a per-user NSIS installer and ZIP for x64. Preview builds without configured signing credentials are **unsigned**; do not distribute them as a trusted production release or instruct colleagues to bypass OS protections. Final distribution requires signed Windows binaries and signed/notarized macOS binaries from the agreed release channel.

## Updates, rollback and uninstall

This preview has no automatic updater. Quit the app, install a newer compatible build, reload/update the extension, then reselect the target. The pairing key and preferences are retained in OS application data. Back up settings before pilot upgrade/rollback; encrypted pairing keys are tied to the OS credential store and are not portable to another machine/user.

Rollback: quit, reinstall the previous compatible desktop build and extension revision, and re-pair if necessary. Protocol 1 is explicitly negotiated; an incompatible companion is rejected rather than executing actions. The optional SQL/Linear service's versions and configuration are unchanged.

Uninstall: first disable **Launch at login** and disconnect in the extension pairing page. Quit the companion. On Windows, use Settings → Apps → MailroomNavigator Desktop → Uninstall. On macOS, remove the app from Applications. To remove retained settings, delete its `MailroomNavigator Desktop` application-data folder (Electron's `userData` location: `~/Library/Application Support` on macOS or `%APPDATA%` on Windows; source development may use the package name). This deletes position, preferences and the encrypted key. Extension-only use continues; uninstalling the optional local service is a separate operation.

See [architecture and trust boundary](ARCHITECTURE.md) and [release validation](RELEASE-CHECKLIST.md).
