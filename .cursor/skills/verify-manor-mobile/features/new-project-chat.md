# New project chat

Compose starts a project conversation: pick a host project (or add a folder), then write the first message. The Mac remains the filesystem host; there is no iPhone document picker.

## Sub-features

- `compose-open` opens `/new-chat` from the inbox control.
- `compose-pick-project` chooses a fixture project.
- `compose-draft` shows the first-message composer for that project.
- `compose-close` returns to Sessions without creating a chat.

## How to get to it (user POV)

- On Sessions, choose `Nieuwe sessie`.
- Choose `Start een sessie in Manor`.
- Type in the field whose placeholder is `Ask anything…`.
- Choose `Sluit` on the project picker to leave without sending.

## Driving it with control-manor-mobile

Preconditions:

- Sessions inbox is showing and the fixture directory includes project `Manor`.
- `control-manor-mobile.mjs doctor` is green.

- **Open compose.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Nieuwe sessie"`. The header title is `Kies project`.
- **Pick Manor.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Start een sessie in Manor"`. The header becomes `Nieuwe sessie` and the composer placeholder is `Ask anything…`.
- **Leave.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Terug"` then `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Sluit"`. Sessions is visible again.
- **Proof.** Capture the project picker before leaving. Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs screenshot --path .cursor/skills/verify-manor-mobile/evidence/new-project-chat/picker.png` and `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs snapshot --path .cursor/skills/verify-manor-mobile/evidence/new-project-chat/picker.hierarchy.xml`. Artifacts show `Kies project` and `Manor`.

## Gotchas

- Sending a first message needs a fixture `create_chat` ack. This map's first proof stops at the picker so a mute fixture cannot fake a live send.
- `Voeg een project toe` opens folder browse against the fixture listing under `/tmp/manor-mobile-verify`. Do not browse real home paths.
- The inbox compose control disappears while search is focused; cancel search first.
