# Desktop shell

The Electron shell shows the Vite app and hosts the native parts: the in-app browser,
the menus and the window. A packaged app carries its own server (`bundledServer.ts`)
and starts it when no Manor server answers on port 43179. In development the shell
connects to the server and the Vite app that are already running, and starts neither.

For the isolated check, run `pnpm desktop:spike-server` in one terminal and
`pnpm desktop:spike` in another. The first command serves the build from a memory-only
backend with the mock driver and isolated scratch data on port 43180. It cannot touch
your own Manor data or a provider subscription. The desktop-only **Browser** item in
the right rail opens the shared page.

The browser is one live surface that the user and the agents share. The panel measures
its own frame every animation frame and the main process keeps the active tab's
`WebContentsView` over it; while one agent action runs, the host raises a transparent
shield view over the page and moves keyboard focus back to Manor. `show`, `hide` and
`close` are three different things: closing the panel parks the session, only the
chat's own end destroys it.

**`src/preload.ts` must stay self-contained.** It runs sandboxed, so its `require`
resolves `electron` and a few Node built-ins and nothing else. One import of a sibling
module throws before `exposeInMainWorld` runs, and the failure is silent: the renderer
finds no `window.manorDesktop`, decides there is no desktop host, and hides the browser
rail item with no error anywhere on screen. Type-only imports are erased and are fine.
`pnpm --filter @manor/desktop smoke:preload` loads the real preload in a hidden window
and fails on both that and a drifted `manor:browser:state` channel name.

Imports from `@manor/contracts` in the desktop runtime must stay type-only. That
workspace package points at TypeScript source for Vite and `tsx`, while packaged
Electron cannot strip types from a package below `node_modules`. The desktop build
runs `runtimeImportsSmoke` after compilation and fails before packaging if a runtime
`require` slips back in.

`BrowserTab` is one page, `BrowserHost` is one chat's tabs, and `BrowserManager` owns
the chats plus their shared persistent storage profile. Only the active tab of the
visible chat hangs in the Manor window; every other live page keeps rendering in that
host's hidden parking window, because Electron suspends a hidden `WebContentsView` and
a suspended one makes CDP screenshots hang. A user-owned CDP selection mode returns a
bounded text or element quote to the composer without turning it into an agent action.
The tab strip is pushed to the renderer over
`manor:browser:state`, so a page an agent moved shows up without the panel polling.
Closing a chat destroys its tabs but keeps remembered website logins. A direct
message also remembers its tab URLs and active tab across idle teardown and restart,
and restores that list when the DM is opened again. The browser panel's explicit
clear action closes every tab, forgets those remembered strips, then clears the
shared profile.

The phase-two provider check deliberately has a separate command. Stop the mock
server, then run `pnpm desktop:agent-test-server` and restart `pnpm desktop:spike`.
This still uses memory-only state and isolated scratch data, but it does run the real
Claude or Codex subscription selected by the test persona.

For ordinary development, run the existing server and Vite app first, then run
`pnpm desktop:dev`. That script points the shell at `http://localhost:5173` and may be
overridden when another local origin is allowed by the backend.

`pnpm desktop:start` and the packaged app load the Manor server's own origin: the
server already running on `http://localhost:43179`, or the bundled server the app
started itself. The shell deliberately does not load the SPA over `file://`.
The renderer and WebSocket therefore share one auth origin, and root web assets resolve
against the server rather than against the Mac filesystem.

## Local macOS app

`pnpm desktop:package` builds the SPA for the stable server and creates
`apps/desktop/release/mac-arm64/Manor.app`. The bundle carries Manor's product name,
app id and icon, and is ad-hoc signed only. It is a local build, not a
distribution artifact. The app uses a Manor server that already runs on
`localhost:43179`, and starts its bundled one when there is none.

`pnpm desktop:install` does the whole update: it packages, quits the running
Manor, replaces `/Applications/Manor.app` and opens it again. A failed build leaves
the installed app alone. Use it after preload or main-process changes; renderer
changes only need `pnpm stable:restart`, which restarts the server, not the app.

## Release DMG

`pnpm desktop:release` builds `apps/desktop/release/Manor-<version>-arm64.dmg` for
Apple Silicon. It reads two environment variables:

- `MANOR_SIGN_IDENTITY`, a "Developer ID Application" identity in your login keychain,
  by its SHA-1 hash, or by its name without the `Developer ID Application: ` prefix.
  `security find-identity -v -p codesigning` lists them.
- `MANOR_NOTARY_PROFILE`, a notarytool keychain profile made once with
  `xcrun notarytool store-credentials <profile>`.

```bash
MANOR_SIGN_IDENTITY='<hash>' MANOR_NOTARY_PROFILE='<profile>' pnpm desktop:release
```

With both set, the app is signed with the hardened runtime and the entitlements in
`assets/entitlements.mac.plist` (helpers get `assets/entitlements.mac.inherit.plist`),
notarized and stapled. The DMG is then signed, notarized and stapled as well, and the
script ends by checking both signatures and tickets, and the app with `spctl`. Keep the
entitlements to what runs today: JIT for V8, Reminders through EventKit for the
`remindctl` fallback, and Apple Events for scripts agents run. A child process
such as a provider CLI counts as Manor for these checks. The usage descriptions in
`build.mac.extendInfo` follow the same rule.

Both paths need Rust (`rustup`, installed with `--no-modify-path`): the script first
builds Manor's patched Cua driver (`apps/server/scripts/build-computer-driver.sh
--embed`) and electron-builder puts it in `Resources/cua-driver`, where it is signed
with the app. The signed path checks that the driver carries the app's team. When the
app runs its bundled server, main starts that driver's daemon as its own child
(`src/embeddedDriver.ts`) and the server points the `computer` connector at it, so
macOS asks for Accessibility and Screen Recording for Manor itself. Grants are meant
to survive an update signed with the same Developer ID; that is not yet checked on a
real upgrade. On its first start with the driver the
server adds the `computer` connector once. A window on another server, and a checkout,
keep using `/Applications/CuaDriver.app`. Settings → Permissions shows the
two grants, read through a fresh probe child of the driver.

When either variable is missing, the script logs which one and builds a DMG that holds
an ad hoc signed app, the same app `pnpm desktop:package` makes plus the driver. That path is for
contributors without a certificate; the DMG is not notarized and is not for handing
out. Neither path touches `/Applications`; `pnpm desktop:install` stays the local
ad hoc install.

## Restarting the stable server

`pnpm stable:restart` installs, builds the web app and only then swaps the launch
agent, so the build runs while the old server still serves and a tree that does not
build leaves Manor up. It waits for the old process to release its database claim
before starting the new one, and returns once `/health` answers, reporting how long
the server was offline. `pnpm stable:install` rewrites the agent itself; it runs
`stable:serve`, which serves without building, so a broken build can never put the
agent in a restart loop. An open Manor window reconnects by itself once the server
answers again.

The development command uses the same name and Dock icon without packaging. macOS
may keep the previous Dock artwork until Electron has been quit completely and
started again.
