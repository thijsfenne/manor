# Desktop lease card

The first Mac action of a turn on a computer connector asks the user once for that connector: `Let this agent use your Mac for the rest of this turn? Press Escape to stop it.` with `Allow once` and `Deny`. Cua's Allow says apps may come to the front; the Codex engine's (`codex-computer`) says its scripts can also read files and run commands. On the spike the mock raises the real card through the production effect broker and stops at consent, so nothing touches the Mac.

## Sub-features

- `lease-card-codex` shows the Codex engine's card and its files-and-commands warning.
- `lease-card-cua` shows Cua's card and its front-window warning.
- `lease-allow` and `lease-deny` end the mock turn with `Allowed: …` or `Not allowed: … was denied before it ran.`

## How to get to it (user POV)

- In a real turn, an agent's first click or script on `computer` or `codex-computer`. On the spike, send `mock lease card codex-computer` or `mock lease card computer` in the Marlow DM.

## Driving it with control-manor

Preconditions: spike launched as `MANOR_EFFECT_MODE=confirm node .cursor/skills/verify-manor/control-manor.mjs launch` (see Gotchas), Marlow DM from `home`.

- **Card.** `fill --composer --value "mock lease card codex-computer"`, `click --role button --name Send --exact`, `wait-settle`. Expect a group named after the question and `radio "Allow once Approves its scripts … run commands on this Mac."`.
- **Allow.** `click --role radio --name "Allow once"`, `wait-settle`. Expect the paragraph `Allowed: codex-computer may use the Mac for the rest of this turn. …`.
- **Deny.** Send the phrase again, `click --role radio --name Deny`. Expect `Not allowed: codex-computer.js was denied before it ran. …`.
- **Proof.** `snapshot --aria` and `screenshot` with the card open and after each answer.

## Gotchas

- The spike launches with Full access (the server's own default is Auto), which grants the lease without a card. Launch with `MANOR_EFFECT_MODE=confirm`; a warm spike in another mode restarts its server on that launch.
- Choosing an option submits the card at once; there is no Send to press.
- This proves the card and the broker's answer only. Escape arming needs the Electron host, and the real lease path is covered by `apps/server/test/computerUse.test.ts`.
