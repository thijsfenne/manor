# Usage pill

Every tab root (Agents, Sessions, Knowledge at the vault root, Search) carries a Liquid Glass pill at the top right of its header: Claude's ring, then Codex's, each filled to what is left of that provider's fullest window, and `+N` for every other provider that reports. Tapping it opens the `Usage` sheet with one card per connected provider, a bar per window with `N% left`, the reset time and a pace mark where even spending would put the bar.

## Sub-features

- `usage-pill` shows the rings in the order Claude, Codex, then `+N`. A provider that is signed out or has no window does not count. Before any provider reports, the gauge glyph holds the place.
- `usage-sheet` lists the provider cards in the Mac's card order (Claude, Cursor, Grok, Codex), with Grok as `Unavailable`.
- `usage-pace` draws a thin text-coloured tick on each bar that has window timing (`usage-pace-mark` in the hierarchy).
- `usage-close` closes the sheet with `Close` or a swipe down.

## How to get to it (user POV)

- On any tab root, tap the pill to the right of the title.
- Swipe the sheet down, or tap `Close`, to return.

## Driving it with control-manor-mobile

Preconditions:

- App is on a tab root with the drawer closed.
- `control-manor-mobile.mjs doctor` is green.

- **Pill.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs snapshot | grep "Usage, "`. The fixture reads `Usage, Claude 38% left, Codex 29% left, 1 more`.
- **Every tab root.** Tap each tab by point from a hand-written Maestro flow (see the handle table in `SKILL.md`) and check the same label. On Knowledge it is gone once a folder is open.
- **Sheet.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Usage, .*"`. The sheet title `Usage` and the cards `Claude`, `Cursor`, `Grok` (`Unavailable`) and `Codex` are listed in that order; the snapshot holds one `usage-pace-mark` per bar.
- **Close.** Tap `Close`; the pill is visible again. A hand-written Maestro flow with `swipe: { start: "50%, 10%", end: "50%, 95%", duration: 250 }` also dismisses the page sheet, since it goes by distance.
- **Proof.** Screenshot a tab root and the open sheet under `evidence/usage/`.

## Gotchas

- The Expo dev-menu gear floats over the pill and covers it in screenshots. Drag it away with a hand-written Maestro flow, `swipe: { start: "90%, 12%", end: "90%, 55%" }`; the dev menu's `Tools button` switch did not hide it on this run.
- The pill's label changes with every usage broadcast, so match it with `Usage, .*`.
