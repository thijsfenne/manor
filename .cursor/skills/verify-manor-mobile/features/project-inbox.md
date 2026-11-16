# Project inbox

The Sessions tab lists the user's Work. The user sees open project threads, can reveal Settled history, search titles and previews, and open a conversation with one tap.

## Sub-features

- `inbox-work` shows the Work title and fixture host status.
- `inbox-open-active` opens an unsettled project thread from its row.
- `inbox-settled` expands or collapses Settled and opens a settled row.
- `inbox-search` filters rows from the `Zoek gesprekken` field.

## How to get to it (user POV)

- Launch the app and choose the `Sessions` tab (`/sessions`). The app opens on Agents.
- Choose a row named `Open Mobiele inbox voor Manor`.
- Choose the Settled disclosure, then `Open settled gesprek PWA navigatie afmaken`.
- Focus `Zoek gesprekken`, type a word from a title or preview.

## Driving it with control-manor-mobile

Preconditions:

- Fixture is healthy at `ws://127.0.0.1:43182/ws`.
- `control-manor-mobile.mjs doctor` reports `fixtureOpen: true` and `appInstalled: true`.
- House menu is closed.

- **Confirm Work.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs home`, then `tap --name "Sessions"`, since the app opens on Agents. The screen title is `Sessions` and a row `Open Mobiele inbox voor Manor` is present.
- **Search.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs fill --name "Zoek gesprekken" --value "inbox"`. The matching row remains; unrelated titles leave the list.
- **Cancel search.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Zoeken annuleren"`. The full inbox returns.
- **Open thread.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Open Mobiele inbox voor Manor"`. The chat route shows a back control named `Terug`.
- **Proof.** Capture Work with the fixture thread visible. Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs screenshot --path .cursor/skills/verify-manor-mobile/evidence/project-inbox/work.png` and `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs snapshot --path .cursor/skills/verify-manor-mobile/evidence/project-inbox/work.hierarchy.xml`. Artifacts must show `Work` and `Mobiele inbox voor Manor`, not a live-house thread list.
- **Inline steering history.** Open `Bijsturen in de stream` from search or the Manor project's Sessions. The saved fixture has one completed turn. Its user addition `Waar kijk je allemaal naar?` stays visible with the trace closed. Open Worked and check that `Ik bekijk de bestanden.` precedes it and `Ik controleer ook de berichtvolgorde.` follows it. This is a saved-history rendering check, not live delivery proof.

## Project threads

Sessions lists `Project threads` first, then `Standalone sessions`, as the Mac's sidebar does. The Manor project has a thread (`chat-thread-manor`); its row shows the project icon, `Manor`, and a small yellow dot (label `Open project thread Manor, needs you`, no text) because the thread-started Session `Exportknop` asks `Ronde of vierkante hoeken?`. The dot stands for a proposal, a question, a result to Confirm or a blocked commit, never for a Session that is only `Done` or reopened. `Exportknop` is not in the Sessions list; it lives behind the project. Search still finds it. Swiping settles Sessions rows only, never a project row.

- **Open the thread.** Tap `Open project thread Manor`. The header has `Terug naar Sessions` on the left, the pill `Manor, projectinstellingen` in the middle and `Sessions van dit project` on the right. The chat shows the forwarded question as the answer card (header `Exportknop asks Manor`, the thread's advice under the first question as `Manor raadt aan Ik zou de eerste optie kiezen…`, and no reply bubble for it) and no Session row in the bar above the composer (only Accept and Confirm rows live there). The Sessions button wears a yellow dot, because `Exportknop` waits on an answer. Answering goes to the session's chat id.
- **Project settings.** Tap `Manor, projectinstellingen`. The sheet `Instellingen` holds the name, `Icoon en kleur`, the folders with `Map toevoegen`, `Bestanden`, `Knowledge work memory` and `Delete project thread`. The tick `Bewaar` (or return in the name field) saves; the fixture answers `update_project` with a new directory and an ack.
- **Project Sessions.** Tap `Sessions van dit project`. The screen `Sessions` shows `Needs you 1`, `Working 0` and `Settled 0`. `Open Exportknop` opens the Session; `Terug` returns to this screen, and `Terug naar de thread` (or the edge swipe) to the thread.
- **Check project identity.** The thread composer reads `Reply…`. Its reply header keeps `GPT-6.1 Sol` and status without a project icon, name or leading dot. The fixture write receipt keeps `Export is in progress.` Capture its native screenshot and hierarchy.
- **Open the session.** Tap `Open Exportknop` on the project's Sessions screen. Instead of the answer card it shows `Waiting for a choice in the project thread` with the button `Open project thread`, which returns to the thread.

Handles: `Open project thread Manor`, `Terug naar Sessions`, `Manor, projectinstellingen`, `Bewaar`, `Sessions van dit project`, `Terug naar de thread`, `Open Exportknop`, `Open project thread`.

The Expo dev client's floating tools gear sits over the header's right control. Turn it off once in the dev menu (`Tools button`) before tapping `Bewaar` or `Sessions van dit project`, or Maestro's tap opens the dev menu instead.

The button's label carries the dot's state after a comma (`, heeft jou nodig`, `, nieuw resultaat`, `, bezig`), so match it with a prefix. The dot on it is yellow while a Session waits on the user, green while one finished unopened, and a pulsing neutral while one runs; yellow beats green beats neutral. Manor's thread is yellow from the start. For the other two, open the Punt thread (no dot) and run `kill -USR1 $(lsof -tiTCP:43182 -sTCP:LISTEN)`: the first signal starts a turn in its Session `Stipproef` (neutral pulse), the second ends it (green, until `Stipproef` is opened). The `Wekken` Session shows two Subagent cards, `Count the files` done and `Read the logs` running.

The Notities thread sent one of the user's messages on to its Session `Weekmenu` (`send_to_session`).

- **Open the thread.** Tap `Open project thread Notities`. Under `Zet ook pasta op het weekmenu.` the line `Sent to` carries a `Weekmenu` chip; under the reply `Doorgestuurd naar Weekmenu…` a second `Weekmenu` chip links the Session.
- **Follow the chip.** Tap `Open Session Weekmenu`. The Session shows the same message as the user's own with `Sent from Notities` above it.

The Notities thread ends in a running turn (`Werk de notities bij.` with a Read call). The phone shows only the working face under it; no status line, tool row, copy, memory, trace or time appears on any thread reply.

Handles: `Open project thread Notities`, `Open Session Weekmenu`, `Open Weekmenu`.

## Gotchas

- Empty copy `Geen verbinding met je Mac` means the fixture socket is down or the app still has `.env.local` pointing at 43179 / Tailscale.
- `Welkom thuis` means auth leaked on. Stop; do not type a real password.
- Settled rows use a different label prefix (`Open settled gesprek …`).
- Search cancel only exists while the field is focused.
