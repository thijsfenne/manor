# Manor mobile verification map

This directory is the maintained source for verifying user-facing Manor **phone** behavior on the isolated iOS Simulator fixture. Read the index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Drive the custom Expo dev client on a **booted iOS Simulator** only.
- Fixture websocket `ws://127.0.0.1:43182/ws`. Live Manor is `43179`. Desktop spike is `43180`.
- Launch with `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs launch`.
- Run `control-manor-mobile.mjs doctor` and require `fixtureOpen: true`, a Simulator UDID, and `appInstalled: true`.
- Auth off. Fixture roster is Marlow (CoS), Sage, Smith. Fixture inbox includes `Mobiele inbox voor Manor`.
- Never drive the maintainer's phone, Expo web, or an instance you did not health-check. Never kill 43179.

## Driving conventions

- Start every recipe from the Work inbox unless its preconditions say otherwise.
- Prefer accessibility labels over coordinates. UI copy is Dutch.
- Treat every command as literal.
- Close the house menu (`Sluit menu` or pick a room) before the next feature so the next recipe starts from a closed drawer.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting Simulator state, not only the final screen.
- UI proof is a Simulator PNG plus a Maestro hierarchy dump. Expo web and desktop-spike screenshots are invalid.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- If doctor exits 2 (no Mac / no Xcode), write `PROOF-BLOCKED.md` under that feature and stop.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with control-manor-mobile`
4. `Gotchas`

## Features

- [Project inbox](./project-inbox.md) covers Work, search, and opening a fixture thread.
- [New project chat](./new-project-chat.md) covers Compose through the project picker.
- [House menu](./house-menu.md) covers the drawer rooms.
- [Direct chats](./direct-chats.md) covers the Agents room (direct chats) and opening Marlow.
