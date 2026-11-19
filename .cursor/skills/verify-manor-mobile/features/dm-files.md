# DM files

A DM's header has a Files button, and its agent overview a Files row. Both open a screen with every file of that DM, newest first, under `This week` and `Older`. A tap opens the viewer, a long press opens a menu.

## Sub-features

- `files-door` is the `Files` button at the right of a DM's header, and the `Files` row of its agent overview.
- `files-library` shows the chips `All`, `Media`, `Files`, five rows per group and `Show more`.
- `files-unavailable` is the dimmed row `contract.pdf`, which reads `Unavailable`.
- `files-menu` is the long-press sheet with `Open`, `Download` and `Show in chat`.
- `files-viewer` shows the file, its name with `<n> / <total>`, a strip of the filter's files, `Download` and `Close`.
- `files-empty` reads `No files yet` in a DM without files.

## How to get to it (user POV)

- Open a DM and tap `Files` at the right of the header, or tap the agent's pill and then the `Files` row.

## Driving it with control-manor-mobile

Preconditions: `doctor` is green. The fixture answers `get_dm_files` with ten files for Marlow's DM and none for any other DM. The commands below leave out `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs`.

- **Open.** `tap --name "Open menu"`, `tap --name "Agents"`, `tap --name "Marlow, Chief of staff.*"`, `tap --name "Files"`. Expect `This week` with five rows and `Show more`, and `Older` with three.
- **Filter.** `tap --name "Media"` leaves the five pictures.
- **Viewer.** `tap --name "splash-icon.png"` shows the picture and `3 / 10`. A strip thumbnail steps: `tap --name "release-note.md"` shows the rendered markdown, `tap --name "planning.pdf"` the card with `Open` and `Download`. `tap --name "Close"` goes back.
- **Unavailable.** `tap --name "contract.pdf"` opens the card with `This file is no longer available in Manor.`, both actions disabled and no `Download` in the header.
- **Menu.** `long-press --name "icon.png"`, then `tap --name "Show in chat"` returns to the DM at that message.
- **Empty.** Back to Agents, `tap --name "Sage.*"`, then the same door.
- **Delivered pictures.** At the foot of Marlow's DM, two turns handed files over: two pictures without rows, then a picture and `planning.pdf`, which keeps its row. `tap --name "Open icon-dark.png"` opens the viewer over that message's pictures, `1 / 2`, with `Download`.

## Gotchas

- `Files` is both the screen title and a chip. On the screen `tap --name "Files"` reaches the chip; in the DM it is the header button.
- The CLI has no swipe, so stepping in the viewer goes through the strip. A horizontal swipe needs a Maestro flow.
- `Download` opens the system share sheet, which Maestro cannot dismiss by label. Prove it by hand.
- The fixture's PDF is a stub, so `Open` on it shows an empty document.
