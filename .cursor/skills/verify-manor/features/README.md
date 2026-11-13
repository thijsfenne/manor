# Manor verification map

This directory is the maintained source for verifying user-facing Manor desktop/web behavior on the isolated spike. Read the index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Drive only the origin `launch` prints (43180 or the next free port). Live Manor is `43179`. Ordinary Vite is `5173`.
- Launch with `node .cursor/skills/verify-manor/control-manor.mjs launch`, and again before every verification round. It rebuilds the private dist only when the tree changed, starts the server with its own HOME, and blanks every key in `apps/server/.env`.
- Run `control-manor.mjs doctor` and require `spikeHttp: 200`.
- Spike uses `MANOR_STORE=memory`, `MANOR_AUTH=off`, `MANOR_DRIVER=mock`, data in `/tmp/manor-electron-spike[-<port>]`.
- Memory store seeds project `Manor` and personas Marlow (CoS), Sage, Smith. Do not expect the live roster.
- A fresh browser lands on the Agents destination with the Marlow DM stage open.
- Never drive an instance you did not health-check. Never kill 43179.

## Driving conventions

- Start every recipe from the spike home unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or coordinates.
- Treat every command as literal.
- Run `home` before each feature so it starts from the fresh-browser default.
- Rail clicks take `--within navigation`; several names (`Scheduled tasks`, `Sessions`) also exist elsewhere.
- The message box is `--composer`, never a role lookup.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the Manor sidebar visible.
- A mock-driver reply is the expected send side effect. A live model call means you are on the wrong instance.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with control-manor`
4. `Gotchas`

## Features

- [Workspace navigation](./workspace-navigation.md) covers the Destinations rail, sidebars, New session, Usage and shortcuts.
- [Composer send](./composer-send.md) covers sending in a DM and in a Single Session, Send and Enter.
- [Search](./search-chats.md) covers the ⌘K palette: chats, messages, notes and reminders, opened from the top bar or ⌘K.
- [Agents and scheduled tasks](./agents-routines.md) covers the roster and the Scheduled tasks page.
- [Outbound drafts](./outbound-drafts.md) covers the Gmail draft dock: create, edit, Copy. Never Submit.
- [Subagents](./subagents.md) covers helper rows and wake notices, sidebar rows, the helper's own view, the Agents list, nesting and provider-run helpers.
- [Desktop lease card](./desktop-lease-card.md) covers the Mac approval card for Cua and the Codex engine, Allow and Deny.
- [Session changes](./session-changes.md) covers the Session panel's Changes and Branch, the diff pane, Commit and Push against a local bare remote.
- [Browser tabs](./browser-tabs.md) covers the Browser tab strip (pins, resize, drag reorder) through the desktop-browser stub.
- [Browser saved passwords](./browser-passwords.md) covers the address-field key, the save offer and the saved-passwords list through the same stub.
- [Browser saved-login fill](./browser-fill-login.md) covers an agent's `browser_fill_login` card, Fill, Don't fill and no saved login, in a DM and a group.
- [Secret requests](./secret-requests.md) covers an agent's `request_secret` card: command and browser targets, Use once, Decline, Stop and the posted shape Codex and Cursor use.
- [Browser find and page zoom](./browser-find-zoom.md) covers the find bar and the address-field zoom magnifier through the same stub.
- [Connectors marketplace](./connectors-marketplace.md) covers Plugins → Connectors: search, the Composio catalogue, connect with an alias, Failed, and disconnect with confirmation, against the mock Composio.
- [Project threads](./project-threads.md) covers the Projects section, the thread's file writes, its sessions in the split, question routing, Confirm in the thread, DM briefs, the Context panel and removal.
