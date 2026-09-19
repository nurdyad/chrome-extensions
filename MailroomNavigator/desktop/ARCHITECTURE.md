# Desktop preview architecture

## Decision

Use Electron for this prototype: the existing UI and bridge are JavaScript, and native window, tray, global shortcut, credential-store and display APIs are available on both required platforms. The cost is a bundled Chromium runtime and higher distribution/resource cost. Tauri would reduce the runtime footprint but add Rust/toolchains and platform WebView variation; separate Swift and Windows UI implementations would add two UI/IPC maintenance paths. This choice remains subject to measured pilot resource use and platform validation, not a claim that Electron is lightweight.

Electron 44 requires macOS 13 or later. Dependencies are pinned and locked. Sources: [Electron 44 release](https://www.electronjs.org/blog/electron-44-0), [security guidance](https://www.electronjs.org/docs/latest/tutorial/security), [sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox), [window drag regions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions), [global shortcuts](https://www.electronjs.org/docs/latest/api/global-shortcut), [display APIs](https://www.electronjs.org/docs/latest/api/screen).

The frameless transparent BrowserWindow uses native drag regions, saved logical-pixel bounds and available-display clamping. It stays a normal desktop window: no accessibility/screen-recording permission or synthetic OS input is required. Always-on-top, full-screen and virtual-desktop behavior must be recorded separately on each OS.

## Bridge

An authenticated WebSocket on **127.0.0.1:4818** avoids installing Chrome Native Messaging manifests/Windows registry entries during the prototype. Native Messaging offers a browser-managed launch and identity boundary but requires per-OS host installation and lifecycle management. The local transport instead requires explicit pairing and a separately running companion; it must never become an unauthenticated command server.

- Reject upgrades unless Host, path and exact approved `chrome-extension://<id>` Origin match. Origin alone is not authentication: local processes can forge it.
- Generate a 256-bit random pairing key and encrypt it with Electron safeStorage at rest. Keep the extension copy in local storage, never sync storage. Never send the raw key over the transport or expose it to the toolbar renderer.
- Use fresh server challenge and client nonce plus HMAC-SHA256 for client authentication. The client verifies a separate server proof before sending contexts or accepting commands.
- Require protocol version 1 on both ends. Bound handshake duration, payload size and connections. Heartbeats detect stale sessions. Chrome 116+ supports [WebSocket service-worker lifetime extension](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets); reconnect alarms handle worker restarts.
- Allow a single authenticated profile. A second profile cannot silently replace it. The profile label is user supplied; tab/window IDs and practice scope come from the extension, not arbitrary page titles.
- Only the catalog of ten navigation action IDs is accepted. No arbitrary URL, JavaScript, shell command, SQL, document text or credential is transmitted. No reconcile/restart/destructive operations are bridged.
- Require an explicit selected context and current revision. Validate the real Chrome tab origin, non-incognito status, current practice and button availability before invoking the existing handler. Navigation, practice changes and disconnects invalidate selection. Pending requests time out and are not replayed.
- The pairing mutation endpoint accepts only the extension's own settings page. Panel ports accept only extension panel pages. The web page cannot submit commands directly.

Loopback encryption is not provided by `ws://`; HMAC authenticates pairing and challenges, not each subsequent frame. The threat model trusts the local OS/user session and TCP transport after handshake. It does not protect against malware with access to browser storage, process memory or local packet interception. Native Messaging or authenticated encrypted transport should be reassessed if that threat is in scope.

## Desktop security boundary

Both local renderers have Node disabled, context isolation and sandbox enabled, a restrictive CSP, denied navigation/new windows/webviews and denied permission requests. A small preload exposes fixed IPC methods. Main-process handlers verify the owning window, top frame and exact file URL; pairing key copying and configuration mutation require the settings window. UI data is rendered as text; SVG paths come from a fixed local icon map.

No telemetry or remote UI is loaded. Routine state exposes only profile label, Chrome IDs, practice code, connection state and preferences. A pairing key is copied only on explicit request. OS credential-store failure stops startup instead of saving plaintext.

## Release boundary

This is the first runnable preview for #237, not completion of its epic acceptance criteria. The extension remains 1.x (1.127.0); the optional companion is labeled 2.0.0-alpha.1. Final 2.0 requires a version-policy decision and the Windows/macOS pilot checklist. No artificial breaking migration is introduced.
