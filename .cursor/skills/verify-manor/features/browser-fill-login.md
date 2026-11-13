# Browser saved-login fill by an agent

An agent on a sign-in page calls `browser_fill_login`. The user gets a card in the chat, `Sign in to <site> as <username>?`, with `Fill` and `Don't fill`; only the user's Fill fills the page. The agent hears `filled`, `declined` or `no_saved_login` with the site and username, never the password.

## Sub-features

- `fill-card` shows the card for the active tab's exact origin, in a DM and from one persona in a group.
- `fill-approved` ends the mock turn with `{"status":"filled",…}` and the stub tab titled `Filled <username>`.
- `fill-declined` ends it with `{"status":"declined",…}`; `Skip` counts as a decline.
- `fill-none` answers `{"status":"no_saved_login",…}` without a card.

## How to get to it (user POV)

- In a real turn, an agent's `browser_fill_login` call. On the spike, send `mock fill login` (or `mock fill login as <username>`) in a chat. The stub's active tab is `Albert Heijn` (`www.ah.nl`), which has the saved login `sam`; `as nobody` gives no saved login.

## Driving it with control-manor

Preconditions: spike launched as `MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/desktop-browser.js node .cursor/skills/verify-manor/control-manor.mjs launch`, Marlow DM from `home`. Full access is fine: this card is human-only and appears in every mode.

- **Card.** `fill --composer --value "mock fill login"`, `click --role button --name Send --exact`, `wait-settle`. Expect the group `Sign in to www.ah.nl as sam?` with `radio "Fill Manor fills the saved login …"` and `radio "Don't fill …"`.
- **Fill.** `click --role radio --name "Fill Manor"`. Expect the code span `{"status":"filled","site":"www.ah.nl","username":"sam"}`; the Browser panel door (`click --role button --name Browser --exact --nth 1`) shows the tab `Filled sam`.
- **Decline.** Send the phrase again, `click --role radio --name "Don't fill"`. Expect `"status":"declined"`.
- **Several personas.** `New group` with Marlow and Sage, send `@Sage mock fill login`: Sage shows `Waiting for you…` and the same card.

## Gotchas

- Do not run `home` or reload while a card waits: the page's socket is the desktop host, and a replaced host makes the broker refuse the approval with `The browser session changed before the action was approved.` That is the intended guard.
- The stub renders no page. A real form filled, the reveal guard, hidden decoy fields, an early reveal, a page echoing the password (redacted, no screenshot), the username-only step and the moved-origin refusal are native; prove them with `MANOR_SMOKE_EVIDENCE_DIR=<dir> pnpm --filter @manor/desktop smoke:browser-passwords`, which also writes `agent-fill-filled-form.png`. It opens a window briefly and uses a throwaway store, never saved passwords.
- The phone shows this card without its options, with `Dit kun je alleen op je Mac goedkeuren.`; that is not reachable from this skill.
