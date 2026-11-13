# Workspace navigation

A permanent left rail (`Destinations`) switches between places: Agents, Sessions, Reminders, Artifacts, Scheduled tasks, Plugins, plus host-dependent Browser and Knowledge. Agents, Sessions, Knowledge and Reminders open a sidebar named `<Title> navigation`. A fresh browser lands on Agents. A new Session starts from the Sessions sidebar.

## Sub-features

- `nav-rail` exposes the rail as navigation `Destinations`; the current door carries `aria-current="page"`.
- `nav-agents` opens `Agents navigation` with the roster (spike: Marlow, Sage, Smith).
- `nav-sessions` opens `Sessions navigation` with `New session`.
- `nav-new-session` opens the draft stage in project `Manor`.
- `nav-doors` covers the doors without a sidebar (Artifacts, Scheduled tasks, Plugins) and the `Usage` modal.
- `nav-shortcuts` covers ⌘1 to ⌘9 (Nth visible door), ⌘N new session, ⌘S fold sidebar, ⌘K search, ⌘[ / ⌘] back and forward.

## How to get to it (user POV)

- Click a rail icon. Hover shows `Label (⌘N)`.
- In Sessions, the `+` in the sidebar header (`New session`, tooltip `New session in Manor (⌘N)`) opens a stage asking `What are we working on in Manor?`.

## Driving it with control-manor

Preconditions: spike healthy (`doctor` reports `spikeHttp: 200`), start from `home`.

- **Rail and default.** Run `home`, then `snapshot --aria`. Expect `navigation "Destinations"`, `navigation "Agents navigation"` and `heading "Agents"` (level 2) with `New group` and `New agent`.
- **Sessions.** `click --role button --name Sessions --exact`. Expect `navigation "Sessions navigation"`, `heading "Sessions"` and an enabled `New session`.
- **New session.** `click --role button --name "New session"`, then `wait-settle`. Expect in `main` an h1 `What are we working on in … ?` containing `button "Project for this chat"` with text `Manor`, a `tablist "Chat mode"` with `Single` selected, no `switch "Auto mode"` (the spike has no classifier key, so the host has no Auto and the model picker shows instead), and `Send` disabled.
- **Doors without a sidebar.** One click each on `Artifacts`, `Scheduled tasks`, `Plugins`: no `… navigation` sidebar appears. `Usage` opens a modal titled `Usage`; close it with `press --key Escape`.
- **Split view.** Needs two Sessions; the row on stage offers no split. Send in a `New session`, then `click --role button --name "Open <other title>" --exact --button right` and `click --role menuitem --name "Open right" --exact`. Expect two `Close pane` buttons.
- **Proof.** `snapshot --aria` and `screenshot` after the Sessions click and after New session.

## Gotchas

- `Sessions` also matches `Sessions, a session is done` when a door needs attention; pass `--exact` for the plain name, drop it when attention is expected.
- Reminders, Browser and Knowledge appear only when their host is present, so ⌘N numbering shifts with the visible doors. The headless spike shows Reminders.
- "Workspace navigation" is only the sidebar name when no destination panel is open. Do not wait on it.
- New Sessions open as Single with a manual Opus 5.5 High pick and no Auto switch, because the spike host has no Auto; the mock driver still answers, nothing reaches a provider.
