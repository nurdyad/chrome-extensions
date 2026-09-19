# Desktop release gates — issue #237

No final 2.0 release until both required platforms pass. Record OS/build, CPU, monitors/scaling, Chrome and extension versions, tester, date and evidence for each manual result.

## Automated preview evidence

- Bridge tests cover mutual authentication, untrusted origins/keys/protocol, stale context, malformed messages, second-profile rejection, command timeout and disconnect without replay.
- Extension integration tests use the actual background bridge with a local WebSocket server, testing context/action routing, navigation invalidation and settings sender authorization.
- Bounds tests cover negative coordinates, unavailable monitors, screen edges and scope allowlisting.
- Native renderer smoke uses an isolated profile and synthetic context; real pairing and production main-process lifecycle remain manual gates.

## Local preview run — 19 September 2026

- macOS ARM64: unsigned `.app` packaging passed with Electron 44.4.3; unpacked bundle approximately 288 MiB.
- Native isolated renderer smoke passed: ten enabled actions, explicit target, no Node in renderer, content fits the 540×132 window, native move/hide/show, always-on-top flag, dark theme and settings render. Screenshot inspected.
- Desktop automated tests: 20 passed. Existing extension suite: 85 passed.
- No real Chrome pairing, Windows installation, Intel macOS installation, physical multi-monitor or signing/notarization validation has been completed in this run. Cold-start and idle resource measurements are still pending.

## Required manual matrix

| Gate | macOS ARM64 | macOS Intel | Windows x64 |
| --- | --- | --- | --- |
| Signed installer, fresh install and first launch | Pending | Pending | Pending |
| Pair real Chrome, select target and invoke all ten shortcuts | Pending | Pending | Pending |
| Two tabs/windows/profiles; practice changes; no wrong target | Pending | Pending | Pending |
| Mouse drag outside Chrome and across monitors | Pending | Pending | Pending |
| Mixed scaling, negative origins and unplug/reconnect displays | Pending | Pending | Pending |
| Pin, normal/full-screen apps and Spaces/virtual desktops | Pending | Pending | Pending |
| Keyboard movement/focus, screen reader and reduced motion | Pending | Pending | Pending |
| Global shortcut with Chrome unfocused and collision recovery | Pending | Pending | Pending |
| Hide/close/tray restore, single instance, quit and login startup | Pending | Pending | Pending |
| Chrome quit/restart, extension reload, offline service, port conflict | Pending | Pending | Pending |
| Sleep/wake and reconnect without repeated actions | Pending | Pending | Pending |
| Colleague upgrade, rollback, key rotation and complete uninstall | Pending | Pending | Pending |
| Cold-start time, idle CPU/RSS and packaged size baseline | Pending | Pending | Pending |

## Ship decision

- [ ] UX accepted by the user and a colleague on both Windows and macOS.
- [ ] Independent review of IPC validation, pairing and local threat model.
- [ ] Signed/notarized macOS and signed Windows distribution; release ownership/channel agreed.
- [ ] Manual matrix completed, including real multi-monitor and assistive-technology checks.
- [ ] Resource measurements accepted; revisit framework if idle cost is unsuitable.
- [ ] Compatibility/upgrade/rollback documentation verified with installed builds.
- [ ] Existing extension-only flows remain usable and tested.
- [ ] Versioning policy explicitly permits the 2.0 product milestone or documents a necessary incompatible contract.

Do not close #237 simply because the preview PR merges.
