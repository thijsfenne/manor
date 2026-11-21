---
name: verify-manor
description: Verify Manor desktop or web behavior using its isolated fixture and feature map. Use for a requested UI verification pass or after changes to desktop or web interactions.
---

# Verify Manor

Primary surface is the desktop-first Electron + Vite React SPA. Phone/Expo exists and is out of scope for this skill. Drive the **spike** only. Live Manor on `localhost:43179` and ordinary `pnpm dev` on `5173` are shared with the maintainer; do not open, click, or kill them.

Spike roster is the memory-store fixture (Marlow, Sage, Smith), not the live household. Mock driver. Auth off. Data in `/tmp/manor-electron-spike[-<port>]`.

## Working cheaply

Every image you read stays in context and is paid again on every later call, so a verification run is mostly screenshot cost. Three rules:

1. **Check state through text while you build.** `snapshot` prints the page text, `snapshot --aria` the ARIA tree; scope either to one element with `--role/--name/--within` and pipe to `grep`. A failed `click`/`fill` exits non-zero with the reason, so a passing command already proves the handle exists.
2. **Screenshots only for the final evidence round**, or where only pixels can answer (layout, colour, motion end state, clipping). One per state you claim, not one per step.
3. **Read the preview, never the original.** `screenshot` writes the full-size PNG at `--path` (that file is the evidence for a result card) and an 800px-wide `<name>.preview.png` beside it. It prints both paths; open only `preview` with your image reader. A crop already 800px wide or less is its own preview.

This file and `features/` list every command, flag and handle you need. Do not read `control-manor.mjs`, `session-daemon.mjs` or the stubs to work out how to drive them; if something is missing here, that is a bug in this file.

## Launch

From the Manor repo root:

```bash
node .cursor/skills/verify-manor/control-manor.mjs launch
```

This Session gets its own spike on the first free port from **43180** (43182 stays free for verify-manor-mobile): a private SPA built from the current tree into `.cursor/skills/verify-manor/.run/<port>/web-dist` with `VITE_MANOR_AUTH=off` and Supabase env cleared (so the spike has no login door), the memory-store mock server on that port serving that folder, and a headless Chromium pointed at that origin. It never writes `apps/web/dist` (that folder is what live 43179 serves), and the server's `start` compiles its MCPs into `apps/server/.mcp-build/<port>`, never the folder a running live server spawns them from. Ready when `launch` exits 0 and the page shows the `Destinations` rail. `launch` prints the origin; every later command finds this Session's spike by itself. Do not run `pnpm desktop:spike-server` for this skill; that script overwrites the shared dist and keeps live credentials.

The spike stays warm for the whole Session. **Run `launch` again before each verification round**: it rebuilds the SPA only when web code changed, restarts the server only when server code or launch settings changed, and reloads the page. Unchanged it returns in well under a second, and it prints what it did (`"web": "unchanged"`, `"server": "restarted 1.1s"`, …). A drive command refuses to run against code that changed since the last `launch`, so a stale build never becomes evidence. A reused server keeps the chats the previous round made; `launch --fresh` restarts server and browser for an empty fixture.

Two isolation rules live in `launch`, do not bypass them with a hand-started server:

- The server runs with `HOME=/tmp/manor-electron-spike/home`. The memory store sweeps `~/.manor/scratch` under its HOME at startup; on the real HOME that deletes every live chat's scratch folder.
- Every key named in `apps/server/.env` is passed in empty, which wins over the file. Mail, calendar, Composio, Supabase and the vault path never reach the spike, so a drafted mail's Submit cannot send from the maintainer's account.

Do not also start `pnpm desktop:spike` (Electron) unless the proof is specifically about the native shell. The web origin is enough for sidebar, composer, search, and agents.

There is no teardown step at the end of a round. Manor stops the spike when the Session settles or is archived, or after 15 minutes without a spike command while the Session runs no turn; it never stops one while the Session or a subagent it started runs a turn. The live server (the one with `MANOR_ROUTINES=on`) does this sweep. `cleanup` below stops it at once.

## Doctor

```bash
node .cursor/skills/verify-manor/control-manor.mjs doctor
```

Must report `spikeHttp: 200` on this Session's origin, plus `webCurrent` and `serverCurrent` (false means: run `launch`). Refuses 43179 and 5173. `live43179Http: 200` is normal and not a reason to drive that port. Run doctor after `launch` and after any failed drive.

## Drive

All actions go through the control CLI. Prefer ARIA names over coordinates.

```bash
node .cursor/skills/verify-manor/control-manor.mjs home
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name Sessions --exact --within navigation
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name "New session"
node .cursor/skills/verify-manor/control-manor.mjs fill --composer --value "ping"
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name Send --exact
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name Search --exact
node .cursor/skills/verify-manor/control-manor.mjs press --key Escape
node .cursor/skills/verify-manor/control-manor.mjs wait-settle
```

Stable handles from this repo:

- Rail landmark `navigation "Destinations"` with doors `Agents`, `Sessions`, `Reminders`, `Artifacts`, `Scheduled tasks`, `Plugins`, `Usage`. A fresh browser lands on Agents.
- The window's top bar is `banner "Top bar"`: `Hide sidebar` / `Show sidebar`, `Back`, `Forward`, `Search`, then each pane's breadcrumb, its `navigation "Panels"` doors and, in a split, `Close pane`. The rail stays the first navigation landmark in the page, so `--within navigation` still hits it.
- Sidebars are `navigation "<Title> navigation"` (Agents, Sessions, Reminders, Knowledge), with the destination's creation buttons in their title row. Search sits in the top bar: `click --role button --name Search --exact --within banner`.
- Headless Chromium has no desktop bridge, so it shows the full-screen arrangement (lead controls over the rail, no traffic-light corner). Real lights only come from the Electron shell.
- `New session` in the Sessions sidebar (seeded project `Manor`); new Sessions open as Single. The spike has no classifier key, so no Auto switch or label shows anywhere; Auto's own UI cannot be proven here.
- In a split both panes carry a `navigation "Panels"` with same-named doors; `--nth 1` after `--role button --name Session --exact` takes the right pane's.
- The message box is `--composer` (`[data-composer-editor]`); it has no accessible name.
- `Send` (pass `--exact`); `Stop` only while a turn runs with an empty draft.
- Search dialog `Search`, combobox `Search chats, messages, notes and reminders`; Scheduled page tablist `Scheduled task kind`.

Read the `features/README.md` index and only the feature files relevant to the requested verification. Drive the entry points the map lists.

## Evidence

Write under `.cursor/skills/verify-manor/evidence/<feature>/`. Capture the action and the resulting state, not only the last screen.

```bash
node .cursor/skills/verify-manor/control-manor.mjs snapshot --aria --path .cursor/skills/verify-manor/evidence/workspace-navigation/after-chats.aria.txt
node .cursor/skills/verify-manor/control-manor.mjs screenshot --path .cursor/skills/verify-manor/evidence/workspace-navigation/after-chats.png
# {"ok":true,"path":".../after-chats.png","size":"1280x800","preview":".../after-chats.preview.png","previewSize":"800x500"}
```

Look at `preview`; hand `path` (the full-size file) to `goal_reached` screenshots, never a `.preview.png`.

Proof standards: real user path, no internal setters, no hitting 43179. Spike uses the mock driver, so a sent message must show a mock reply in the thread, not a live model call. Side effect for send is the new row in the Chats list plus the user bubble. Evidence stays after cleanup.

## Cleanup

```bash
node .cursor/skills/verify-manor/control-manor.mjs cleanup
```

Stops this Session's server, session daemon and Chromium, and frees its port. Only processes carrying this spike's marker are signalled. Never kill by process name. Never touch 43179. Evidence is not deleted.

Optional: Manor stops the spike itself (see Launch). Use it when a launch went sideways, then `launch` again.

## Helpers

Install once (skill-local, not a product dependency):

```bash
cd .cursor/skills/verify-manor && npm install && npx playwright install chromium
chmod +x control-manor.mjs
```

Shared locator flags (for `click`, `hover`, `fill`, `snapshot`, `screenshot`, `wheel`, `drag`):

- `--role <aria role> --name <accessible name>`; add `--exact` for a whole-name match (default is substring, case-insensitive). `--exact` works only with `--role` plus `--name`.
- `--role` alone takes the first element of that role. `--name` alone means a button with that name (substring, never exact).
- `--nth <i>` picks the i-th (0-based) of several matches with `--role` (alone or with `--name`), `--name` alone or `--placeholder`; it is ignored with `--composer`.
- `--within <landmark role>` scopes to the first landmark of that role; `--within-name <name>` picks the landmark with that exact name instead.
- `--frame "<iframe title>[>…]"` looks inside that iframe, `>` descending into nested ones.
- `--composer` is the message box (it ignores every other locator flag); `--placeholder <text>` finds a field by placeholder.

`snapshot` and `screenshot` read the whole page unless a locator (`--role`, `--name`, `--composer` or `--placeholder`) is given; `--frame` alone makes `snapshot` read that frame's page.

Drive commands print one JSON line (`{"ok":true,…}`), `launch`, `doctor` and `cleanup` print a JSON object, and any failure exits 1 with the error. `snapshot` without `--path` prints the text itself.

| Command | What it does |
|---|---|
| `launch [--fresh]` | This Session's spike: rebuild or restart only what changed, then Chromium on its origin (1280×800 viewport); `--fresh` starts over with an empty fixture |
| `doctor` | Read-only health of the spike origin |
| `home` | Navigate to the spike origin and wait for the rail |
| `open --url <path or URL>` | Navigate on the spike origin only, e.g. a delivered file's `?view=1` page |
| `snapshot [--aria] [locator] [--path <file>]` | Page text, or the ARIA tree with `--aria`; a locator reads one element instead of the page. Without `--path` it prints to stdout |
| `screenshot --path <file.png> [locator]` | Viewport PNG, or cropped to that element (e.g. `--role navigation --name "Agents navigation"`), plus `<file>.preview.png` at 800px wide |
| `click <locator> [--button right]` | Click, or a right-click for a row menu. A delivered HTML preview is `--frame "Preview of <name>><name>"` (outer frame, then the page's own sandboxed frame); the same page opened top-level is `--frame <name>` |
| `fill <locator> --value <text>` | Replace field text; `fill --composer --value` for the message box |
| `type --text <text>` | Type into whatever has focus |
| `press --key <key>` | One key or chord in Playwright form: `Enter`, `Escape`, `Meta+k`, `Shift+Tab` |
| `hover <locator>` | Rest the mouse on that element and wait 600ms, for a hover card or controls that show on hover |
| `attach --file <abs path>[,<abs path>…]` | Put files on the page's first file input, which is the composer's attach field |
| `scheme --value light\|dark` | The colour scheme the page sees; it stays until the next `scheme` or `launch` |
| `clock --days-ago <n>` | Set the server's clock back `n` days, so what is sent next is stamped then; `0` puts it back. `launch --fresh` resets it |
| `wheel <locator> [--dy -600]` | Real mouse wheel over that element; negative scrolls up |
| `drag <locator> --dx <px> [--dy <px>] [--steps 20]` | Press, move by `dx` (and `dy`) in steps, release: a panel's resize grip, a Browser tab, a note picture |
| `resize --width <px> [--height 800]` | Viewport size, for narrow-window layouts |
| `wait-settle` | Quiet network + 400ms |
| `cleanup` | Stop this Session's spike now |

Environment, set on `launch` (a changed value restarts the server or browser on the next `launch`):

| Variable | Effect |
|---|---|
| `MANOR_VERIFY_PORT=<port>` | Pin the port (43180 to 43199, never 43182) instead of the first free one; then set it on every command |
| `MANOR_VERIFY_VAULT_DIR=/tmp/<fixture>` | Fixture vault for Knowledge and search; must live under `/tmp` |
| `MANOR_VERIFY_INIT_SCRIPT=<abs path>` | Script injected before page load, e.g. `stubs/desktop-browser.js` |

Headless Chromium has no real clipboard. For a picture pasted or dropped into a Knowledge note, launch with `MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/paste-image.js`: with the caret in a note, `press --key Control+Alt+Shift+V` pastes a generated PNG; after `hover` on a spot in the note, `press --key Control+Alt+Shift+D` drops one there. Both go through the editor's own paste and drop handlers.

Headless Chromium has no Electron preload, so the Browser shows no tabs. For the tab strip, launch with `MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/desktop-browser.js`; see `features/browser-tabs.md`.

The spike's server finds `stubs/bin/tailscale` first on its PATH, a stand-in CLI for a signed-in tailnet named `manor-spike.example.ts.net`, so Settings → Phone shows and flips Tailscale HTTPS without touching the Mac's real Tailscale. Pair a device for the Paired devices list with `curl -X POST <origin>/pair -H 'Content-Type: application/json' -d '{"code":"<code from a link>","name":"Test phone"}'`.

`clock` works through `stubs/server-clock.mjs`, which `launch` loads into the spike's server only. The page keeps the real time, so a message sent under `clock --days-ago 12` reads as twelve days old.

`node .cursor/skills/verify-manor/stubs/dm-files-fixture.mjs /tmp/<folder>` writes sample pictures, PDFs, markdown, a data file, an HTML page and (with ffmpeg) a short video to attach or deliver; see `features/dm-files.md`.

`session-daemon.mjs` is started by `launch` and holds one Playwright page. Do not start it by hand.

Each Session's spike is registered in `~/.manor/spikes/<port>.json` with the chat it belongs to; another Session's spike is never reused or driven, even in the same checkout. A spike that blocks `launch` (every port taken, or the pinned `MANOR_VERIFY_PORT`) is looked at first: when it is stale (over a day old, its checkout no longer exists, or its owning chat has no running turn and left it alone for 15 minutes; never while that chat has a turn running) `launch` stops it through its own marker, prints `Stopped the stale spike on <port> …` on stderr and lists it as `stoppedStale` in its JSON. A spike that is not stale is refused with its owner named (chat, checkout, age). The rule is `stale-run.mjs`; `node --test .cursor/skills/verify-manor/stale-run.test.mjs` covers it. `MANOR_VERIFY_VAULT_DIR=/tmp/<fixture>` on `launch` gives the spike a fixture vault for Knowledge and search; see `features/search-chats.md` for that and a fixture RemCTL.
