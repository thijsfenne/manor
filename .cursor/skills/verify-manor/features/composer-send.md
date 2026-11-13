# Composer send

The composer is a Lexical editor at the foot of every chat. Send (or Enter) delivers the draft; on the spike the mock driver answers with a fixed sentence, so a send must produce a user bubble and that reply without touching a provider.

## Sub-features

- `composer-empty` keeps `Send` disabled while the editor is empty.
- `composer-send` delivers the draft with the `Send` button.
- `composer-enter` delivers with Enter; Shift+Enter adds a line; Enter picks the highlighted row when the @ or $ menu is open.
- `composer-dm` sends to one agent in its DM.
- `composer-single` sends in a new Single Session, which also creates the Session row.

## How to get to it (user POV)

- DM: click an agent in `Agents navigation` (e.g. `Marlow Chief of staff`). Placeholder `Ask anything…`
- Session: Sessions door, `New session`. Placeholder `Ask anything…` (Multiple too; a project thread says `Reply…`).

## Driving it with control-manor

Preconditions: spike healthy, start from `home` (lands on the Marlow DM stage).

- **Empty.** `snapshot --aria`: `button "Send" [disabled]`.
- **DM send.** `fill --composer --value "verify-manor ping"`, then `click --role button --name Send --exact` and `wait-settle`. Assert the transcript holds `verify-manor ping` and `Marlow here. You said: "verify-manor ping". Caught up on the whole thread.`, and `Send` is disabled again.
- **Single send with Enter.** From the New session stage (workspace-navigation), `fill --composer --value "verify-manor single ping"`, `press --key Enter`, `wait-settle`. Assert `Assistant here. You said: "verify-manor single ping".` and a Sessions row `Open verify-manor single ping`.
- **Proof.** `screenshot` after typing, `snapshot --aria` and `screenshot` after the reply.
- **Inline Session steer.** Send `slow turn inspect the files`, wait until the first `Assistant here.` text is visible, then send `Waar kijk je allemaal naar?`. The earlier text stays above the addition and the resumed answer appears below it, under one turn header. Reopen the Session and expand its Worked trace to check the saved order. Repeat in Multiple with `@Sage slow turn inspect the files`. DMs keep their existing chat layout.
- **Focus.** In a Session with an inline addition, `press --key 'Meta+.'` enters focus mode. After `wait-settle`, the user addition must remain visible. `press --key Escape` leaves focus mode when focus is on the page.

## Gotchas

- The editor has no accessible name and its placeholder is a separate node, so `--placeholder` and `--name` do not find it. Use `--composer` (it targets `[data-composer-editor]`). `--role textbox` is unsafe: after the first message the composer sits in `contentinfo`, which also holds open draft fields.
- `Send` becomes `Stop` only while a turn runs with an empty draft; a non-empty draft always shows `Send`. Ordinary additions steer the running answer. Explicit addressing and runtime safety guards can still make a message wait.
- Pass `--exact` on `Send` so it does not match other buttons containing the word.
- The mock reply names the agent: `Assistant` in Single, the persona name in a DM or Multiple. A reply without that prefix means you are not on the mock driver.
