# Settings permissions

Settings → Permissions shows Manor's own macOS Accessibility and Screen Recording grants for computer use, each with its state (Granted, Not granted, Pending) and one `Open System Settings` button for that pane. The state follows a grant without a restart. In a browser tab without the desktop shell the page only says that permissions apply in the desktop app.

## Sub-features

- `permissions-states`: the two rows and their states.
- `permissions-live`: `Open System Settings` makes a missing grant Pending, and the row turns Granted once it arrives, without a reload.
- `permissions-browser`: the plain sentence a browser tab shows instead.

## How to get to it (user POV)

- Press ⌘, (or open Settings from the account menu), then `Permissions` under System.

## Driving it with control-manor

- Launch with the stub for the desktop rows: `MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/desktop-permissions.js node .cursor/skills/verify-manor/control-manor.mjs launch`. Accessibility starts Granted, Screen Recording Not granted.
- `press --key "Meta+,"`, `click --role button --name Permissions --exact`. Expect group `Computer use` with rows `Accessibility` and `Screen Recording`.
- **Live.** `click --role button --name "Open System Settings" --nth 1`. Screen Recording reads `Pending` with `Waiting for System Settings. …`; about four seconds later it reads `Granted`. `window.__manorOpenedPanes` lists the panes the page asked for.
- **Browser.** `launch` without `MANOR_VERIFY_INIT_SCRIPT`, open the page again. Expect `Permissions only apply in the Manor desktop app on your Mac.` and no button.
- `scheme --value dark` before a screenshot for the dark theme.

## Gotchas

- The stub stands in for the preload and main process. The real states come from a fresh `cua-driver --cua-internal-permission-probe` child of Manor.app, which only a release build carries; a checkout falls back to Electron's own answer. Neither runs here.
- The page polls every 1.5 seconds while it is open, so wait at least that long after a state change before a snapshot.
