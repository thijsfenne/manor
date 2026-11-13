# Agents and scheduled tasks

The household roster and the routines page are separate rail destinations. `Agents` opens a sidebar listing each persona; `Scheduled tasks` (formerly Routines) is a full page with Recurring and Once tabs. The old foldable `Show agents` / `Show routines` rails no longer exist.

## Sub-features

- `agents-roster` lists the spike fixture Marlow, Sage and Smith in `Agents navigation`, with `New group` and `New agent`.
- `agents-open-dm` opens an agent's DM stage from its row.
- `scheduled-page` shows heading `Scheduled tasks`, tablist `Scheduled task kind` (`Recurring`, `Once`) and `New task`.
- `scheduled-empty` shows `Nothing recurring yet` (or `Nothing coming up` on Once) on the empty spike.

## How to get to it (user POV)

- Rail: the first icon (`Agents`, ⌘1) and the clock icon (`Scheduled tasks`).

## Driving it with control-manor

Preconditions: spike healthy, start from `home`.

- **Roster.** `click --role button --name Agents --exact --within navigation`. Expect `heading "Agents"` (level 2) and rows `Marlow Chief of staff`, `Sage Generalist`, `Smith Engineer`.
- **DM.** `click --role button --name "Sage Generalist"`. Expect `heading "Message Sage"` in `main`.
- **Scheduled.** `click --role button --name "Scheduled tasks" --exact --within navigation`, `wait-settle`. Expect `heading "Scheduled tasks"` (level 1), `tablist "Scheduled task kind"` with `Recurring` selected, `New task`, and `Nothing recurring yet`.
- **Proof.** `snapshot --aria` and `screenshot` on the Scheduled page and the roster.

## Gotchas

- An open DM's header also has a `Scheduled tasks` button, so the rail click needs `--within navigation` (the first navigation landmark is the rail).
- After a message, a roster row's accessible name grows with its time and preview (`Marlow Chief of staff now Marlow here…`); match the row without `--exact`.
- The live household (Smith, Wren, Argus) is never on the spike.
