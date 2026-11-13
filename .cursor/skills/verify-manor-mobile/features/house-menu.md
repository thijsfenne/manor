# House menu

The house menu is the phone's room list. It sits behind the page in a drawer and replaces the current room rather than stacking a history of rooms.

## Sub-features

- `menu-open` opens the drawer from `Open het menu`.
- `menu-rooms` lists Agents, Sessions, Knowledge, Artifacts, Scheduled tasks and Plugins in the Mac rail's order, with Usage at the foot. The current room wears its solid glyph.
- `menu-replace` navigates by replacing the current room.
- `menu-close` dismisses the drawer with `Sluit menu`.

## How to get to it (user POV)

- On any room (Sessions by default), choose `Open het menu`.
- Choose a room label (`Agents`, `Knowledge`, …).
- Tap the dimmed page (`Sluit menu`) to stay on the current room.

## Driving it with control-manor-mobile

Preconditions:

- App is on Sessions with the drawer closed.
- `control-manor-mobile.mjs doctor` is green.

- **Open drawer.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Open het menu"`. The menu title `Manor` is visible with room labels including `Agents`.
- **Go to Agents.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Agents"`. The room title is `Agents` and the direct chats with `Marlow`, `Sage`, and `Smith` are listed.
- **Return to Sessions.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Open het menu"` then `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Sessions"`. The inbox is showing again.
- **Usage.** Tap `Usage.*` (the row reads the fullest window's quota left, `29% left` in the fixture). Claude, Codex and Grok cards show one bar per window that drains as quota is used, `N% left` beside it, warn and critical in their heat colour, Grok as `Niet beschikbaar`. The fixture limits equal the desktop spike's mock limits.
- **Plugins.** Tap `Plugins`, then the `Connectors` / `Skills` / `Suggestions` tabs. The fixture serves Linear and an unavailable Figma, Humanizer (12 uses) and Retro, and one suggestion per group (Needs a decision, Watching, History).
- **Knowledge and Artifacts follow the Mac.** The fixture starts with a vault and mymind, so both rows are listed. Run `kill -USR2 $(lsof -tiTCP:43182 -sTCP:LISTEN)` with the drawer open; both rows leave. Send `USR2` again and they come back. `fixture.log` prints `Vault and mymind absent` / `available` per flip.
- **Proof.** Capture Agents after the replace. Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs screenshot --path .cursor/skills/verify-manor-mobile/evidence/house-menu/after-agents.png` and `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs snapshot --path .cursor/skills/verify-manor-mobile/evidence/house-menu/after-agents.hierarchy.xml`. Artifacts show `Agents` and `Marlow`, not the live household.

## Gotchas

- The Expo dev-menu gear floats over the top-right corner and can swallow a tap on `Open het menu` while the drawer is open; the dev menu then opens instead. Close it and tap again.
- `home` does not reload changed JavaScript once Fast Refresh has missed an edit. Run `cleanup` and `launch` again before trusting a screenshot of new code.
- Rooms `replace` each other. There is no back-swipe through visited rooms; the way out is the menu again.
- Chat (`/chat/[id]`) and new-chat use `Terug` / `Sluit`, not `Open het menu`.
- Signal the fixture's listener, not `fixturePid` in `.run/state.json`. That pid is the `tsx` wrapper, which `USR2` kills while the real server keeps running and `cleanup` then misses it.
- `Log uit` appears only when auth is enabled. On the fixture it must be absent.
- A host label of the maintainer's Tailscale name means the wrong websocket.
