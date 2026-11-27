# Subagents

A persona can start helpers on other models. Each one shows as a full-width card in a Session's turn (round provider face with a status dot, brief over its live step or answer, status, time, chevron; model and effort on hover), as a one-line row under its parent in the Sessions and Agents sidebars while it runs (provider mark, title, spinner, on a dotted rail), and in its own view on the stage. A DM shows no card outside its open trace, and its wake draws no row, so the agent's answer follows without a grey line or gap; the sidebar and `Agents` reach its helpers. A child of a child nests one step further in.

## Sub-features

- `sub-card` is the turn row, named `Open <task>`; a click opens that helper's view on the stage. A folded turn keeps a batch of rows (launches with no narration between them, as T3 groups them) while the turn runs or while any helper in that batch still works, then folds it.
- `sub-notice` is a wake's row for each helper it reports on: `Finished`, `Failed` or `Stopped` with the wake's time, opening that helper. Work without a launch row keeps the compact `Background task finished: x` line (a raw command shortens to its program and first argument; three or more read `3 background tasks finished`).
- `sub-row` is the sidebar row; it leaves the sidebar once the helper is done.
- `sub-view` is the helper on the stage in place of its parent: two badges (a clock with its start time, the provider mark with model and effort), its task as a handoff card, its own conversation, and a bar with `Open parent` where the composer stood. Nothing of the parent (its Tasks card included) shows through. A helper's question waits in the parent.
- `sub-agents` is the Agents section at the foot of the Session panel (its `Session` or `Agents` door in `Panels`, dotted while a helper runs; no separate top-bar button): one folded summary line (`button "Agents 1 running 1 done"`, `1 failed` in the danger colour) that unfolds to the rows, running first with Stop. A No project Session holds only this section and has no door without helpers.
- `sub-nested` is a child that starts its own child.
- `sub-native` is a helper the provider starts itself (Codex `spawn_agent`, Claude Task, Cursor task, Grok `spawn_subagent`), with the parent's provider and no model.

## How to get to it (user POV)

- Ask a persona to delegate; its row appears in that turn and under the chat in the sidebar.
- Click a turn row, a notice row or a sidebar row to open that helper's view; `Open parent` or the breadcrumb goes back to the same scroll position. The Session panel's Agents section lists them all.
- Nesting needs Settings: account menu, `Settings`, `Subagents`, `Allow subagents to delegate`.

## Driving it with control-manor

Preconditions: spike healthy, start from `home` (Marlow DM on stage). The turn cards and notice cards need a Session: `click --role button --name Sessions --exact`, `click --role button --name "New session"`, `wait-settle`, then send with `press --key Enter`. The same sends in the DM prove the DM shows none.

- **One child.** `fill --composer --value "subagent gpt-6-luna medium: read the notes slowly"`, then `click --role button --name Send --exact`. Within 3s the sidebar has `list "Subagents"` with `button "read the notes slowly, GPT-6 Luna · Medium, Running. Show in Subagents"`, and the turn has a button `Open read the notes slowly` (`--nth -1` once the chat holds an earlier one). About 12s later the row is gone and the panel's Agents line counts it as done.
- **Child with a grandchild.** Turn nesting on first: `click --role button --name "<profile name>, account" --exact`, `click --role button --name "Settings ⌘," --exact`, `click --role button --name Subagents --exact --within navigation --within-name Settings`, `click --role switch --name "Allow subagents to delegate" --exact` (saves on change), `click --role button --name "Back to app" --exact`. Then send `subagent claude-sonnet-5-5 high: subagent gpt-6.1-sol low: count the files slowly`. Both rows run in the sidebar, the grandchild `count the files slowly` one step in.
- **Child with a role.** `subagent gpt-6.1-sol high role "You are a skeptical, read-only code reviewer. Do not edit files, do not start subagents.": <a task that wraps past five lines>` (the mock's `role "…"` goes before the colon). Its view has no `Role` label; the task card opens on the muted role, a divider, then the task, and folds them together past eight lines (`Show more` opens it, `Show less` folds it again).
- **Parallel children, one wake.** Send three lines in one message, one child each: `background subagent gpt-6.1-sol high: simplicity review for 4 seconds`, then the same form with `for 10 seconds` and `for 18 seconds`. The turn ends with `Waiting on 3 background agents…` and its three rows stay while any child works; the persona wakes once, about 18s later, with three `Finished` rows above its reply, and the turn's own rows fold.
- **Provider-run helper.** Send `Run a native helper, please.` for a `spawn_subagent` inside the turn that runs about 12s, with the persona's own provider mark.
- **A failed child.** A task saying `mock crash` ends in an error, for a failed row and the `Why it failed` fact.
- **Proof.** Crop the sidebar with `screenshot --role navigation --name "Agents navigation" --path …`; keep the full screenshot for the rows and the view.

## Gotchas

- The mock form is `subagent <model id> <effort>: <task>` with a full model id (`claude-sonnet-5-5`, `gpt-6-luna`, `gpt-6.1-sol`, `grok-4.7`); `sonnet-5.5` is refused with the allowed list in the reply.
- `for N seconds` in a task makes that child answer after roughly N seconds; `background` before `subagent` starts it without waiting, so its end wakes the persona.
- `slowly` in a task keeps a child working about 12s after its own child answered, which is the only way to see a finished grandchild leave while its parent still runs.
- Stopping a child also stops its children, so a finished child with a running grandchild cannot be produced on the spike.
- A row's Stop is named `Stop subagent <task>`, so it never clashes with the composer's `Stop`.
- A settled turn folds its rows once every helper ended, so a finished helper is reached through its wake's notice row or the panel's Agents section.
