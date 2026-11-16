# Direct chats

Chats is the messaging inbox: the chief of staff is the way into the house, and every other DM or group sits in recency order. Tapping a persona without a DM asks the fixture to create one.

## Sub-features

- `direct-open` opens the Chats room from the house menu.
- `direct-cos` shows Marlow as the fixture chief.
- `direct-open-dm` opens `Open gesprek met Marlow`.

## How to get to it (user POV)

- Open the house menu, choose `Chats`.
- Choose `Open gesprek met Marlow`.

## Driving it with control-manor-mobile

Preconditions:

- Fixture roster marks Marlow `isCos` and includes `chat-dm-marlow`.
- `control-manor-mobile.mjs doctor` is green.

- **Open Chats.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Open het menu"` and `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Chats"`. The room title is `Chats`.
- **Open Marlow.** Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs tap --name "Open gesprek met Marlow"`. A thread with `Terug` is showing.
- **Proof.** Capture the Chats list before opening. Run `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs screenshot --path .cursor/skills/verify-manor-mobile/evidence/direct-chats/list.png` and `node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs snapshot --path .cursor/skills/verify-manor-mobile/evidence/direct-chats/list.hierarchy.xml`. Artifacts show `Chats` and `Marlow`.

- **Memory in a consultation.** Marlow's last seeded turn asks Sage and wrote a memory line. The thread shows `Messaged Smith` (no reply yet), then `2 messages with Sage` (one line for the send and its reply, opening the view-only pair `Marlow and Sage`) and no memory row. `long-press --name "Ik vraag het Sage; haar antwoord volgt."` opens the action sheet with `Geheugen bijgewerkt`, which opens the added line.

- **Result cards in Smith's DM.** `tap --name "Open het menu"`, `tap --name "Agents"`, `tap --name "Smith.*"`, then `tap --name "Ready, Export a chat as Markdown"` in the bar to bring the cards in. The Ready card has three screenshots (`Open icon.png`, …) served by the fixture under `/media/evidence/`; a tap opens the viewer at `1 / 3` and a horizontal swipe (a Maestro `swipe` flow; the CLI has none) steps on. `Sluit afbeelding` closes it. Above it a confirmed result reads `Merge blocked` with its reason and `Open Session`.

## Gotchas

- The dev client can open on its launcher instead of the app; `tap --name "http://127.0.0.1:8088"` under Recently opened loads the bundle (about 25s on a cold Metro).
- Since the 2026-10 nav the menu row is `Agents` and Marlow's row label starts `Marlow, Chief of staff`; `tap --name "Marlow, Chief of staff.*"` opens it. The first taps right after `launch` can fail while the bundle loads; retry after a few seconds.

- Creating a missing DM is a write. Prefer the seeded Marlow DM so the fixture only has to list, not persist.
- Work and Chats are different rooms (`/` vs `/direct`). Do not treat a project inbox row as a DM proof.
