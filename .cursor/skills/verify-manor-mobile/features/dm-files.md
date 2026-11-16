# DM files

A DM's agents sheet has a Files row. It opens a screen with every file of that DM, newest first, under `This week` and `Older`. A tap opens the viewer, a long press opens a menu.

## Sub-features

- `files-door` is the `Files` row in the sheet behind `Agents in this chat`, in a DM only.
- `files-library` shows the chips `All`, `Media`, `Files`, five rows per group and `Show more`.
- `files-unavailable` is the dimmed row `contract.pdf`, which reads `Unavailable`.
- `files-menu` is the long-press sheet with `Open`, `Download` and `Show in chat`.
- `files-viewer` shows the file, its name with `<n> / <total>`, a strip of the filter's files, `Download` and `Close`.
- `files-empty` reads `No files yet` in a DM without files.

## How to get to it (user POV)

- Open a DM, tap the agent face in the header, then `Files`.

## Driving it with control-manor-mobile

Preconditions: `doctor` is green. The fixture answers `get_dm_files` with ten files for Marlow's DM and none for any other DM. The commands below leave out `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs`.

- **Open.** `tap --name "Open menu"`, `tap --name "Agents"`, `tap --name "Marlow, Chief of staff.*"`, `tap --name "Agents in this chat"`, `tap --name "Files"`. Expect `This week` with five rows and `Show more`, and `Older` with three.
- **Filter.** `tap --name "Media"` leaves the five pictures.
- **Viewer.** `tap --name "splash-icon.png"` shows the picture and `3 / 10`. A strip thumbnail steps: `tap --name "release-note.md"` shows the rendered markdown, `tap --name "planning.pdf"` the card with `Open` and `Download`. `tap --name "Close"` goes back.
- **Unavailable.** `tap --name "contract.pdf"` opens the card with `This file is no longer available in Manor.`, both actions disabled and no `Download` in the header.
- **Menu.** `long-press --name "icon.png"`, then `tap --name "Show in chat"` returns to the DM at that message.
- **Empty.** Back to Agents, `tap --name "Sage.*"`, then the same door.

## Gotchas

- `Files` is both the screen title and a chip. On the screen `tap --name "Files"` reaches the chip; the sheet row is the only match while the sheet is open.
- The CLI has no swipe, so stepping in the viewer goes through the strip. A horizontal swipe needs a Maestro flow.
- `Download` opens the system share sheet, which Maestro cannot dismiss by label. Prove it by hand.
- The fixture's PDF is a stub, so `Open` on it shows an empty document.
