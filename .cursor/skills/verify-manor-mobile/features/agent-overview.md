# Agent overview

A DM's header shows the agent's face, name and role in a glass pill in the middle, with Back on the left and `Files` on the right. The pill opens the agent overview: a large face, the name and role, the `Name` and `Title` fields, the `Model` row, then `Files`, `Scheduled tasks`, `Skills` and `Connectors`.

## Sub-features

- `dm-header` is the pill `Marlow, Chief of staff, overview` and the `Files` button.
- `overview` lists the rows above. `Scheduled tasks` reads `1 on`, `Skills` and `Connectors` read `1 on` for Marlow and `0 on` for Sage.
- `identity-edit` saves Name and Title when a field is left. The fixture stores the edit and broadcasts the roster, so the header and the overview show the new value.
- `model` opens the same Model sheet as the composer's chip. A pick is this DM's pin, and the row and the composer chip both follow it.
- `lists` are read-only: `Ochtendbriefing` under Scheduled tasks, `Humanizer` under Skills, `Linear` under Connectors. Sage's lists show their empty cards.

## How to get to it (user POV)

- Open a DM and tap the agent's pill in the header.

## Driving it with control-manor-mobile

The commands below leave out `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs`.

- **Open.** `tap --name "Open menu"`, `tap --name "Agents"`, `tap --name "Marlow, Chief of staff.*"`, `tap --name "Marlow, Chief of staff, overview"`.
- **Rename.** `fill --name "Title" --value "Planner"`, then `tap --name "Model.*"` to leave the field (the tap opens the Model sheet; close it with its close control). The overview then reads `Marlow` and `Planner`.
- **Refusal.** `fill --name "Name" --value "Sage"` and leave the field: the fixture refuses a name another agent has, the field goes back to `Marlow` and the refusal shows under the fields.
- **Model.** `tap --name "Model.*"`, then a model row such as `tap --name "Sonnet.*"`. The row reads the new model.
- **Lists.** `tap --name "Scheduled tasks.*"`, `tap --name "Back"`, `tap --name "Skills.*"`, `tap --name "Back"`, `tap --name "Connectors.*"`.

## Gotchas

- A row's label carries its value (`Skills, 1 on`), so match it with a wildcard.
- A name left empty goes back to the stored name and sends nothing.
