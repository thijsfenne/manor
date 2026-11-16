# DM files

A DM's Agent settings panel has a Files row. It opens a library of every file in that DM, what the user attached and what the agent made, newest first. A row opens a full-screen viewer over the files of the filter it is listed under.

## Sub-features

- `library` groups rows under `This week` and `Older`, five per group, then `Show more`.
- `filter` is the tablist `Files shown` with `All`, `Media` (pictures and video) and `Files`.
- `hover` shows the row's age and an `Actions for <name>` button, and a card above the row with a preview, the type, the name, and who it is from and when.
- `menu` holds `Open`, `Download` and `Show in chat`. Show in chat scrolls the DM to the message and flashes it.
- `viewer` is the dialog `<name>, <n> of <total>`: `Download`, `Close`, `Previous file`, `Next file`, the name with its position below the file, and a strip of every file in the filter.
- `empty` reads `No files yet` in a DM without files.

## How to get to it (user POV)

- Open a DM, press `Agent settings for <name>` in the top bar, then `Files`.

## Driving it with control-manor

Preconditions: a fresh spike (`launch --fresh`) and the sample files, `node .cursor/skills/verify-manor/stubs/dm-files-fixture.mjs /tmp/manor-dm-files`. The commands below leave out `node .cursor/skills/verify-manor/control-manor.mjs`.

- **Older files.** `clock --days-ago 12`, then in Marlow's DM `attach --file /tmp/manor-dm-files/moodboard.png,/tmp/manor-dm-files/invoice-kitchen.pdf,/tmp/manor-dm-files/trip-notes.md`, `fill --composer --value "Three for the file"`, `press --key Enter`, `wait-settle`. A delivery is one message each: `fill --composer --value "mock deliver: /tmp/manor-dm-files/contract-draft.pdf"`, `press --key Enter`. End with `clock --days-ago 0`.
- **This week.** Attach and deliver the rest the same way, more than five so `Show more` appears: the other pictures, `measurements.csv`, `budget-overview.html`, `walkthrough.mp4`.
- **Library.** `click --role button --name "Agent settings for Marlow"`, `click --role button --name Files --exact`. Expect regions `This week` and `Older`.
- **Filter.** `click --role tab --name Media --exact` leaves pictures and the video; `Files` leaves the rest.
- **Hover and menu.** `hover --role button --name moodboard.png --exact` shows the card, then `click --role button --name "Actions for moodboard.png"` opens the menu. `click --role menuitem --name "Show in chat"` scrolls the transcript.
- **Viewer.** `click --role button --name moodboard.png --exact`, expect dialog `moodboard.png, <n> of <total>`. `press --key ArrowRight` steps, `press --key Escape` closes. Open `invoice-kitchen.pdf` for two drawn pages, `budget-overview.html` for the sandboxed page, `walkthrough.mp4` for the player.
- **Keys inside a page.** With `budget-overview.html` open, `click --frame "Preview of budget-overview.html>budget-overview.html" --role heading --name "Budget overview"` puts focus in the page; `press --key ArrowLeft` still steps and `press --key Escape` still closes.
- **Empty.** Send Sage one message, open her Agent settings and `Files`.
- **Dark.** `scheme --value dark` and repeat the screenshots; `scheme --value light` to go back.

## Gotchas

- A DM that holds no message yet has no docked panel: the top bar button opens Settings → Agents, which has no Files row. Send one message first.
- The mock driver delivers one file per message, and only from an absolute path.
- `attach` reaches the first file input on the page, so keep one pane open.
- The memory store keeps every file's bytes, so an unavailable row cannot be made here. `apps/server/test/dmFiles.test.ts` and `apps/web/test/fileViewer.test.tsx` cover it.
- A menu or hover card left open covers the next click; `press --key Escape` first.
