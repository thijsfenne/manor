---
name: verify-manor-mobile
description: Verify Manor phone behavior in the isolated Expo iOS Simulator fixture after mobile interaction changes or an explicit mobile verification request.
---

# Verify Manor mobile

Primary surface is the **native Expo custom dev client** (`apps/mobile`, bundle `com.thijsfenne.manor`). Proof is the **iOS Simulator**, not Expo web, not a browser, not Electron, not the desktop spike on 43180.

This skill is separate from `.cursor/skills/verify-manor` (desktop/web). Do not overwrite, extend, or reuse that skill as the mobile driver.

## Working cheaply

Every image you read stays in context and is paid again on every later call, so a verification run is mostly screenshot cost. Three rules:

1. **Check state through text while you build.** `snapshot` without `--path` prints the screen as one line per labelled element (`"label" text="…" [selected] [x1,y1][x2,y2]`, points), about 1 KB instead of the 150 KB dump; pipe it to `grep`. A `tap`/`fill` whose label is not on screen fails non-zero, so a passing command already proves the handle exists.
2. **Screenshots only for the final evidence round**, or where only pixels can answer (layout, colour, clipping, keyboard overlap). One per state you claim, not one per step.
3. **Read the preview, never the original.** `screenshot` writes the full-size Simulator PNG at `--path` (that file is the evidence for a result card) and a 400px-wide `<name>.preview.png` beside it, about one pixel per point and still legible. It prints both paths; open only `preview` with your image reader.

This file, `features/` and the fixture map below list every command, flag, handle and seeded record you need. Do not read `control-manor-mobile.mjs`, `fixture-server.mjs` or the Maestro flows to work out how to drive them; if something is missing here, that is a bug in this file.

## Isolation

- **Never** `ws://127.0.0.1:43179/ws` or `localhost:43179`. That is live Manor.
- **Never** the maintainer's real phone, TestFlight install, or Tailscale `wss://…tailnet.ts.net/ws`.
- **Never** the live household roster. The fixture seeds Marlow / Sage / Smith.
- **Never** treat Expo web (`pnpm --filter @manor/mobile web`) or a Chromium screenshot as mobile proof.
- Auth is **off**: launch clears `EXPO_PUBLIC_SUPABASE_*` and sets `EXPO_NO_DOTENV=1` so `apps/mobile/.env.local` cannot pull the live house.
- Fixture WebSocket is **`ws://127.0.0.1:43182/ws`**. Port 43180 is the desktop spike; do not steal it.

If this machine is not macOS with Xcode, stop. Report proof as blocked: need a Mac cloud worker / private Mac worker. Do not invent a web substitute.

## Launch

From the Manor repo root, in the plain checkout or in a per-chat worktree:

```bash
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs launch
```

`launch` needs no manual setup. In order, it:

1. Installs missing dependencies from the lockfile, never changing it: the mobile app and its workspace packages (`pnpm install --frozen-lockfile --filter @manor/mobile...`, which also gives the fixture its `tsx`) and the skill-local `ws` (`npm ci`). Idle worktrees have every `node_modules` stripped, so this runs on the first launch there. A checkout that has them skips it.
2. Starts the skill-local fixture on **43182**.
3. Boots an iOS Simulator, or reuses one that is already booted. It uses `MANOR_MOBILE_VERIFY_SIMULATOR` when this Mac has a device of that name; otherwise it picks an available iPhone, preferring one that already carries the dev client, then a "Pro".
4. Makes sure the dev client is on that simulator (see below).
5. Starts Metro on **8088** with fixture env (`--host lan` so the Simulator can reach `127.0.0.1`; Expo `--localhost` binds IPv6 only on this Mac) and waits until it answers.
6. Launches `com.thijsfenne.manor`, restarting a running app (it would otherwise keep the JavaScript it loaded before and show stale client code), and **waits until the app has rendered**: Metro reports `iOS Bundled`, then Maestro sees the `Open menu` label (`Welcome home` with auth on) twice in one Maestro flow. On a fresh simulator each pass first dismisses the notification permission alert (`Allow`) and the dev client's onboarding sheet and dev menu (`Continue`, `Close`), so evidence screenshots show the Agents list. A cold bundle takes about 35s. On a timeout it exits non-zero and names the Metro log; budgets are `MANOR_MOBILE_VERIFY_BUNDLE_TIMEOUT_MS` (240000) and `MANOR_MOBILE_VERIFY_RENDER_TIMEOUT_MS` (180000).

Ready when `launch` exits 0: screenshots taken now show the Agents tab, not the splash. Its title is `Agents`.

Fixture 43182 and Metro 8088 are fixed ports shared by every checkout. If another checkout's run holds one, `launch` looks at that run before it refuses:

- **Stale** (over a day old, or its owning chat has no running turn and left it alone for 15 minutes; never while that chat has a turn running): `launch` runs that checkout's own `cleanup`, prints `Stopped the stale verify run …` on stderr and lists it as `stoppedStale` in its JSON, then goes on. Only the process groups that run recorded and claimed are signalled, and a run with a `MANOR_VERIFY_MOBILE` marker only while a group member still carries it. No asking the maintainer first; this is a standing rule for stale runs, never for live Manor (43179).
- **Checkout gone** (the worktree was removed under the run, so its state file and its `cleanup` went with it): the run is stale at any age, unless the chat it names in `MANOR_VERIFY_MOBILE_CHAT` has a turn running. `launch` stops the listener's own process group and reports it the same way. It does so only when every process in that group carries this skill's variables, never for its own group, and it checks all of that again before each signal. A group that also holds anything else is refused like an unidentified run.
- **Not stale, or not a run Manor can identify** (no state file in a checkout that still exists, or the listener is not in a group that state names): `launch` refuses and names the owner (chat, checkout, age) instead of serving that run's code, or the pid when it cannot tell.

The stale rule lives in `../verify-manor/stale-run.mjs`; `node --test .cursor/skills/verify-manor/stale-run.test.mjs` covers it.

Keep `apps/mobile/.env.local` in place. `EXPO_NO_DOTENV=1` alone does not keep it out: Expo's development bundle reads `.env*` files at runtime and lets them win, which ships the live Tailscale socket. `apps/mobile/metro.config.js` drops the dotenv watcher extensions under that flag, and `launch` starts Metro with `--clear` because the file map cache is shared with ordinary dev runs. The fixture also needs `EXPO_PUBLIC_MANOR_AUTH=off`, which `launch` sets. Run `doctor` before driving. If the app reaches live Manor or shows the auth gate, stop the drive and check the served bundle for `ts.net` before retrying.

### Dev client and the Xcode 27 SIGTRAP

The native binary is installed once per simulator, not per checkout; Metro supplies the JavaScript. An Xcode 27 build without a scene manifest stops at launch with SIGTRAP ("UIScene life cycle is required for apps built with this SDK"). `apps/mobile` now adopts the scene lifecycle through `ios.enableSceneSupport`, so a new dev client runs unpatched. Only an older dev client (SDK 27 or newer, no `UIApplicationSceneManifest`) still gets the workaround, a copy whose recorded SDK is lowered and re-signed. `launch` decides per build:

- Dev client already on the simulator: used as is, patched only when it is such an older build.
- On another simulator on this Mac: copied over, with the same check.
- Nowhere: built with `expo run:ios --no-bundler` against the fixture env (log `.run/build.log`, several minutes, and a worktree without `apps/mobile/ios` is prebuilt first).

`launch` never rebuilds a dev client that exists, so after a native change uninstall it from every simulator first.

The patch is `xcrun vtool -set-build-version iossim 16.4 26.4 -replace -output …` on `Manor` and `Manor.debug.dylib`, then `codesign --force --sign -` on the dylib and the app. The copy lives in `.run/devclient` and `cleanup` removes it.

Teardown is `cleanup` below. If a Simulator was already booted, launch will not claim it and cleanup will not shut it down.

## Doctor

```bash
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs doctor
```

Must report `fixtureOpen: true` on `ws://127.0.0.1:43182/ws`, a booted Simulator UDID, and `appInstalled: true`. It also reports the dependency state, the Maestro path and the JDK it will use. Refuses 43179 and Tailscale WSS. `live43179Http: 200` is normal and is not a reason to drive that port.

On Linux or a Mac without Xcode, doctor exits **2** and prints `blocker` with the Mac-worker reason. That is the honest proof outcome here, not a green fake.

Run doctor before the first drive, after any failed drive, and before cleanup if the run went sideways.

## Drive

All actions go through the control CLI. Prefer accessibility labels from `apps/mobile` (Dutch UI copy) over coordinates.

```bash
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs home
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Open menu"
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Agents"
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Sessions"
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "New session"
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs wait-settle
```

Stable handles from this repo:

| Handle | Where |
|---|---|
| `Open menu` | House chrome on every room |
| `Sluit menu` | Drawer backdrop |
| `Agents` / `Sessions` / `Knowledge` / `Search` / `Artifacts` / `Scheduled tasks` / `Plugins` / `Usage, NN%` | House menu rows (`HouseMenu.tsx`); the Usage row reads its peak percent into its label |
| Tab bar `Agents` / `Sessions` / `Knowledge` / `Search` | The native tab bar shares its labels with the menu rows, and `Search` also matches a search field's hint. Tap a tab by point instead, from a hand-written Maestro flow: `point: "18%,94%"`, `"39%,94%"`, `"61%,94%"`, `"82%,94%"` on the iPhone 18 Pro |
| `Search chats, messages and notes` | Search tab field; submit with `pressKey: Enter`, because `hideKeyboard` may tap a result |
| `New session` | Sessions compose button; Sessions has no search field of its own, the Search tab covers it |
| `Start een sessie in Manor` | New-chat project picker |
| `Open ${title}` / `Open settled gesprek ${title}` | Inbox rows |
| `Open gesprek met ${name}` | Direct list |
| `Stuur bericht` / `Stop antwoord` | Composer |
| `Welcome home` + `Log in` | Auth gate — **must not appear** on an ordinary fixture run (auth off). If it does, `.env.local` leaked. To prove the gate itself, `cleanup` and launch with `MANOR_MOBILE_VERIFY_AUTH=on`, then `cleanup` and launch again without it. |

`tap` / `fill` / `snapshot` need **Maestro** and a JDK. The CLI finds Maestro itself (`PATH`, then `~/.maestro/bin`) and the keg-only JDK (`JAVA_HOME`, then `/opt/homebrew/opt/openjdk@21`), so nothing needs exporting in a Session shell. It pins Maestro to the booted simulator, because it refuses to guess while a phone is also connected. Screenshots use `xcrun simctl io booted screenshot` and do not go through a browser.

`tap`, `long-press` and `fill` hand `--name` to Maestro, which matches the accessibility label **or** the visible text as a whole-string regular expression: `--name "Smith.*"` matches `Smith, Reviewer`, and a literal `.`, `(`, `?` or `+` in a label must be escaped or wildcarded (`--name "Usage.*"`).

Read `features/` before inventing a path.

### What the fixture serves

The fixture is a static house plus a few reactions. Most rooms never answer a sent message: `Stuur bericht` gets an ack and nothing else, so prove a send by the user bubble, not by a reply. Four rooms answer like a real turn: Marlow's DM, the group `Huishouden`, the thread `Stilte` and the Session `Losse notities`. The message lands within 40ms, with any pictures it carried, queued (`dispatchState: 'pending'`) and `started` at 100ms as the server marks it, and the turn starts at 120ms, as fast as the real server. A tool row follows, then the reply streams at about 12s and settles at 14.5s. A screenshot right after the send tap catches the working state.

- **Projects.** `Manor` (thread `chat-thread-manor`), `Notities` (a quiet thread whose composer is on screen) and `Stilte` (a thread whose Session notes fold into one line per stretch: `1 answer · 1 update` (the question row opens to `Suggested · Ik zou kiezen voor “Rond”…`), an Accept card, then `2 Sessions done` opening to two Confirmed rows). The fixture's thread cards are written as the Single voice like real ones, so they show no mode; `Instellingen opruimen` carries one image and a linked folder, so its closed line reads `Opus 5.5, High, 1 image`, it opens to `Model` and `Prompt` rows, and `Worktree` shows beside Reject.
- **Roster.** Marlow (Chief of staff), Sage (Specialist), Smith (Reviewer), Wren (Engineer, DM history only, no composer).
- **Manor project chats.** `Mobiele inbox voor Manor`, `PWA navigatie afmaken` (settled), `Export a chat as Markdown` (Wren's Session with a Ready result, two choices of which `Keep it as is` needs no change, and three screenshots), `Achtergrondwerk` (turn still running with two helpers and a build), `Wekken`, `Live sessie`, `Codex live sessie`, `Losse notities` (Single, context ring 88k of 400k; a sent message climbs it to 150k and 230k, shows Compacting the session from about 5.5s, drops to 40k at 9.5s and ends at 52k), `Exportknop` (started by the thread, running, asks three questions on one stepped card: `Ronde of vierkante hoeken?`, a format with three options, `Waar komt de knop?`).
- **Secret card.** `Token nodig` in Manor is a Single Session blocked on a `request_secret` card for `Vercel token`. Reach the field with `fill --name "Enter the value"`, because the label also names the card title. `Use once` records `Used once`, `Decline` records `Declined`, and neither keeps the value; relaunch the fixture to get the card back.
- **Notities.** `Weekmenu` (the thread forwarded one of the user's messages to it) plus seven Sessions, one per card shape: a proposal, Working (a build left running), Working without a streamed word (`Run the test suite`, a turn on tool calls that only the directory's `runningTurns` lists), Needs you, Ready, Done and Confirmed. The Ready one, `Ship the PDF export` (reach it through `Sessions of this project`), changed three files and scrolls, so its footer shows the changes pill and, scrolled up, `Jump to latest` in one row above the result card.
- **DMs.** Marlow (two proposals waiting for Accept: `Fix the date labels`, `Draft the release note with the changelog`; scrolled up, a day-old exchange, a `Message from Sage` line and `Marlow stopped.` with one time line above the first bubble and one above today's), Smith (result cards), Sage (a turn still running), Wren (history). The group `Huishouden` holds Marlow and Sage; Sage answers there.
- **DM files.** Marlow's DM lists ten files behind `Agents in this chat` → `Files`: seven this week (so `Show more` shows), three older, the oldest (`contract.pdf`) without bytes. Pictures and text are served under `/media/dm-files/`. Every other DM lists none. See `features/dm-files.md`.
- **Other rooms.** One routine `Ochtendbriefing`; Plugins with a working (`Linear`) and an unavailable (`Figma`) server, two skills and three suggestions; Usage with one provider per heat plus an unavailable one; a folder picker rooted at `/tmp/manor-mobile-verify`.
- **Tasks card.** `Takenkaart` is a Session whose first turn ended with a fully done plan (`Find the date labels`, 3 of 3, header mark is a check), then an ended turn whose plan stopped early (`Ruim de exportcode op.`: one `Done`, two `Skipped` lines), a Confirm request that shows as a done `Commit this Session’s changes` card, then a running turn whose four-line plan stands at its foot (`Plan` card, one spinner line).
- **Subagents.** `Wekken` (`chat-background-wake`) has `Count the files` done, `Read the logs` running with a question that waits in the parent, and under that one `Search the errors`, failed. Its settled turn keeps both rows because `Read the logs` still works, and the wake shows `Count the files` as a `Finished` row with two background commands below it as two quiet `Background task finished: …` lines; a child's screen opens on its task as a handoff card, and `Read the logs` has a role and a long task, so its card shows the muted role, a divider and the task folded (`Count the files` has no role). `Live sessie` (`chat-live-session`) has `Audit the repo`, which its provider ran itself, so its screen is the record rather than a thread. Answering the question on `chat-background-wake` clears it.
- **Changed files.** `Wijzigingen bekijken` (`chat-diff-files`, Manor) is a finished Single Session that changed four files: `DiffSheet.tsx` with two hunks and a long line, a new file on a long home path, a deleted file and a one-line edit. Its pill above the composer (`View everything this chat changed.*`) opens the changed-files sheet as a closed list; a file row (`Edited file .*DiffSheet.tsx.*`) opens its diff.
- **Trace thumbnails.** `Schermafbeeldingen` (`chat-trace-images`, Manor) is a finished Single Session, first under Standalone sessions on the Sessions tab; tap `Worked for 9s` to see its runs. Its first turn has two runs: one read of a picture (one thumbnail on the run and its row), then four (two thumbnails and `+2`, on the run and on the grouped reads). Its second turn reads the picture the user attached, which shows no thumbnail, beside one that does. The links stand in for what the Mac signs; the exclusion itself is proved on the server.
- **Mail cards.** `Mail klaarzetten` (`chat-mail-drafts`, Manor) is a Single Session with three outbound Gmail cards, one per turn: an open card (scrolled above the first screen) with `Draft subject`, `Draft Cc`, `Draft body`, `Discard draft` and `Send`, then `Sent · info@example.com` with the reply `Sent to info@example.com.` below it, then `Discarded · info@example.com`. `Open mail card` on a fold reopens it read-only. Send and Discard are only acked.
- **Inline steering.** `Bijsturen in de stream` is a Single Session with a saved steer halfway through an assistant message. Its completed trace checks the text before and after the addition and its visibility with the trace closed. No live provider is involved.
- **Reactions.** Accept on a proposal creates its Session and opens on a markdown kickoff. Accept on the Ready result goes pending, then lands as committed three seconds later; a stale version is refused with a notice. Project settings save, broadcast and ack. Request changes (`revise_work_goal`) is only acked, and logs `revise_work_goal <handoff> textLength=<n> images=<name>:<data URL length>,…` to the fixture log. A `/compact`, `/clear` or `/goal` send adds its line in any room, no bubble and no turn. A reply in the thread `Stilte` ends with a new proposal card, `Datumlabels nalopen`, about 15s after the send, so a card lands while the thread sits at its end; Accept works on it and on `Instellingen opruimen`. `kill -HUP $(lsof -tiTCP:43182 -sTCP:LISTEN)` turns the newest accepted one into a Ready result, whose Confirm commits three seconds later. Everything else is acked.
- **Vault and mymind.** Two notes, `Projects/Manor.md` and `Daily/2026-11-16.md`; Knowledge lists them and Search finds them (`inbox` hits both). `kill -USR2 $(lsof -tiTCP:43182 -sTCP:LISTEN)` flips both hosts off (Artifacts leaves the menu, Knowledge stays and says there is no vault) and back on.
- **Search.** The fixture answers `search` with every user or assistant message whose text contains the query, plus matching vault notes. `weekmenu` gives a chat, four messages and no notes.

## Evidence

Write under `.cursor/skills/verify-manor-mobile/evidence/<feature>/`. Capture the action and the resulting native screen, not only the last frame.

```bash
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs snapshot --path .cursor/skills/verify-manor-mobile/evidence/house-menu/after-agents.hierarchy.xml
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs screenshot --path .cursor/skills/verify-manor-mobile/evidence/house-menu/after-agents.png
# {"path":".../after-agents.png","size":"1206x2622","preview":".../after-agents.preview.png","previewSize":"400x869"}
```

Look at `preview`; hand `path` (the full-size file) to `goal_reached` screenshots, never a `.preview.png`. The hierarchy dump is evidence for a reviewer; do not read it yourself, use `snapshot` without `--path`.

Proof standards: real user path on the Simulator; no internal setters; no 43179; no Expo web. Fixture chats include `Mobiele inbox voor Manor`. A live-house thread title means the wrong socket. Evidence stays after cleanup.

If doctor exits 2, write `evidence/<feature>/PROOF-BLOCKED.md` with the doctor JSON and the Mac-worker reason. That file is the proof, not a browser PNG.

## Cleanup

```bash
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs cleanup
```

Kills only the fixture and Metro **this run started**. Shuts down a Simulator only if this run booted it. Never kill by process name. Never touch 43179. Evidence is not deleted.

After a failed iteration, run cleanup before the next launch so 43182 and Metro 8088 are not stranded. Then confirm the evidence files still exist.

**After every code change, `cleanup` and then `launch`.** `launch` starts Metro with `CI=1`, and Metro in CI mode does not pick up file changes: a Metro that is still running keeps serving the bundle it built first, whatever you edit afterwards, and a screenshot of it proves the old code. Restarting the app does not help; only a fresh Metro does.

## Helpers

The CLI is executable. The fixture runs under `tsx`, which `launch` and `deps` install through `packages/contracts` (an existing `apps/server` install is used too). Maestro and a JDK are required; `launch` stops with an install hint when either is missing instead of skipping the render check.

### Mobile typecheck in a worktree

A worktree usually has no `apps/mobile/node_modules`. Install them from the lockfile without launching anything, then typecheck:

```bash
node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs deps && pnpm --filter @manor/mobile typecheck
```

Do not report "no mobile dependencies installed" as a skipped check. The worktree cleanup strips `node_modules` again when the chat is idle.

On a Mac without Maestro, install it once (skill driver, not a Manor package) plus a JDK:

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
brew install openjdk@21
```

| Command | What it does |
|---|---|
| `launch` | Deps, fixture 43182, Simulator, dev client, Metro 8088, launch app and wait for first render |
| `deps` | Install missing mobile and skill dependencies from the lockfile, nothing else |
| `doctor` | Read-only health as JSON; exit 2 on non-Mac |
| `home` | Relaunch the Manor bundle on the booted sim and wait for first render (same JavaScript; it does not pick up edits Fast Refresh missed) |
| `tap --name <label regex>` | Maestro tap by accessibility label or visible text |
| `long-press --name <label regex>` | Maestro long-press, e.g. a bubble's action sheet |
| `fill --name <label regex> --value <text>` | Tap the field, erase it, type the value |
| `snapshot` | Compact text of the current screen to stdout |
| `snapshot --path <file>` | Full Maestro hierarchy dump (JSON) to that file, prints the path |
| `screenshot --path <file.png>` | `simctl` PNG plus `<file>.preview.png` at 400px wide; prints both as JSON |
| `wait-settle [--ms 800]` | Plain pause |
| `cleanup` | Tear down what launch claimed |

There is no scroll, swipe or back-gesture command; go back through a visible control such as `Terug`. Quote values with spaces.

Environment: set the same variables on `launch` and on every later command of that run (`doctor` checks the fixture port it is given, and `home` waits for `Welcome home` only under `MANOR_MOBILE_VERIFY_AUTH=on`). With another fixture port, signal that port: `kill -USR2 $(lsof -tiTCP:43183 -sTCP:LISTEN)`.

| Variable | Effect |
|---|---|
| `MANOR_MOBILE_VERIFY_PORT=43183` | A second isolated fixture socket, never 43179 (Metro stays on 8088) |
| `MANOR_MOBILE_VERIFY_SIMULATOR=<device name>` | Simulator to prefer |
| `MANOR_MOBILE_VERIFY_AUTH=on` | Keep the auth gate, to prove `Welcome home` itself |
| `MANOR_MOBILE_VERIFY_EVIDENCE=1..5` | Screenshots on the Ready `Export a chat as Markdown` result (default 3), for the thumbnail row. The fixture reads it at start, so `cleanup` and `launch` to change it |
| `MANOR_MOBILE_VERIFY_DATA=worst` | Same house with worst-case strings for UI stress (long, one-character, CJK, emoji, unbreakable-compound and empty names, titles, previews, paths, mail and file names) and extra rows: 30 more Manor Sessions, more changed files, a long MCP server and skill. Set on `launch`; the fixture reads it at start, so `cleanup` and `launch` to change it |
| `MANOR_MOBILE_VERIFY_DATA=empty` | A house with no projects, chats, agents, routines, DM files, plugins or skills, so the empty states render. Set on `launch` like `worst`; unset keeps the default house |
| `MANOR_MOBILE_VERIFY_BUNDLE_TIMEOUT_MS` / `MANOR_MOBILE_VERIFY_RENDER_TIMEOUT_MS` | Wait budgets, 240000 / 180000 |
