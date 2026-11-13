# Secret requests

An agent that needs a login, pairing code or token calls `request_secret` and names where the value goes. The user sees a masked card with the destination, enters the value, and Manor delivers it once. The agent hears only the outcome, and the transcript keeps only `Used once`, `Not delivered`, `Declined` or `Timed out`.

## Sub-features

- `command-card` shows `<name> asks for a secret`, the label, the reason, the command and the note about `$MOCK_TOKEN`.
- `command-used` runs the command with the value in one child env variable and ends the mock turn with `{"status":"used","exitCode":0,"output":"token is [secret hidden]\n"}`.
- `declined` ends it with `"status":"declined"`.
- `stopped` closes the card on Stop; the transcript shows `Closed. The turn ended or Manor restarted, so no value is held.`
- `posted` is the Codex and Cursor shape: the attempt ends on the card, and the result opens the next attempt.
- `browser-card` names the site of the open page, and Use once fills its password field. Manor keeps no copy, so the page is sealed: agents cannot read it or what it leads to until `browser_navigate` goes to a new address.
- `no-shell` refuses a command secret in a turn without a shell.

## How to get to it (user POV)

- In a real turn, an agent's `request_secret` call. On the spike, send `mock secret command`, `mock secret browser`, `mock secret command posted` or `mock secret browser posted`.

## Driving it with control-manor

Preconditions: spike launched as `MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/desktop-browser.js node .cursor/skills/verify-manor/control-manor.mjs launch`, in a Smith DM or a Single Session. Marlow and Sage have no shell, so a command card is refused there; use it to prove `no-shell`.

- **Card.** `fill --composer --value "mock secret command"`, `press --key Enter`, `wait-settle`. Expect group `Mock API token` in `contentinfo` with `textbox "Mock API token"`, `Decline` and a disabled `Use once`.
- **Use once.** `fill --role textbox --name "Mock API token" --value SENTINEL-spike`, `click --role button --name "Use once"`. Expect `Used once` and the JSON reply above.
- **Decline.** Send the phrase again, `click --role button --name Decline`. Expect `Declined` and `"status":"declined"`.
- **Stop.** Send the phrase again, `click --role button --name Stop --exact`. Expect the closed copy.
- **Browser.** `mock secret browser`, expect the note `Fills the password field on www.ah.nl, once`; after Use once the stub tab reads `Filled <n> characters`.
- **Several personas.** Create a `New group` with Marlow and Smith, click its row to open it, let Smith finish one turn, then send `@Smith mock secret command`.
- **No value kept.** After a run, `grep -rl SENTINEL-spike /tmp/manor-electron-spike` finds nothing.

## Gotchas

- `Create group` does not open the group: click its row, or the message goes to the chat on the stage.
- The first turn of a new group shows every card closed. A saved-login card does the same on a tree without secret requests, so this is older than this feature. Use the second turn.
- In a split, `--composer` reaches the left pane. Use `fill --role textbox --nth 1` plus `press --key Enter` for the right one.
- A restart loses the memory store's events on the spike, so the closed card after a restart is covered by unit tests and shares its copy with Stop.
- The stub renders no page. A real form filled, the seal through a redirect, no save offer, no Back after the seal lifts and the changed page refusal are proven by `pnpm --filter @manor/desktop smoke:browser-passwords`. The popup, favicon, new-tab, page-context and preview refusals live in `browserTab.test.ts` and `browserManager.test.ts`.
