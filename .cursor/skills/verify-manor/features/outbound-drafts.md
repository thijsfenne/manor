# Outbound drafts

A persona can prepare a Gmail or Slack draft that the user edits, sends or discards. The draft is a card inside the turn that wrote it: an app tile with `Mail` or `Slack`, a subject (Gmail), field rows `From`, `To`, `Cc` (Gmail) or `To` (Slack), a plain body, then `Discard` and `Send`. A threaded reply shows `Later` and `Ignore` instead of `Discard`. A decided card folds to its header (`Discarded · <to>`, `Sent · <to>`) and the header reopens it read-only. After a confirmed send the persona adds one line, `Sent to <to>.`

## Sub-features

- `draft-create` produces a Gmail draft from a mock turn.
- `draft-edit` changes `Draft subject`, `Draft Cc` or `Draft body` in place.
- `draft-discard` folds the card to `Discarded · <to>`; `Open mail card` reopens it without buttons.
- `draft-send` folds the card to `Sent · <to>` and adds the `Sent to <to>.` reply.
- `draft-thread` shows the quoted message with `Later` and `Ignore`.
- `draft-slack` and `draft-connect` show a connect card when the app has no account, then the draft once it connects.

## How to get to it (user POV)

- Ask an agent for a draft. On the spike, send `Draft a gmail to ada@example.com: Hello Ada, see you Thursday.` in the Marlow DM.

## Driving it with control-manor

Preconditions: spike launched by `control-manor.mjs launch` (it blanks every key in `apps/server/.env`, see Gotchas), Marlow DM from `home`.

- **Create.** `fill --composer --value "Draft a gmail to ada@example.com cc sam@example.com: Hello Ada, see you Thursday."`, `click --role button --name Send --exact`, `wait-settle`. Expect `Mail`, `From you@example.com`, `To ada@example.com`, `textbox "Draft Cc"` = `sam@example.com`, `textbox "Draft subject"` = `Draft from Manor`, `textbox "Draft body"`, buttons `Discard draft` and `Send`.
- **Discard.** `click --role button --name "Discard draft" --exact`; expect `Discarded · ada@example.com`, then `click --role button --name "Open mail card" --exact` shows the fields read-only.
- **Send.** The composer's button is also named `Send`; with a draft open the card's comes first, so `click --role button --name Send --exact --nth 0`. Expect `Sent · ada@example.com` and a reply `Sent to ada@example.com.`
- **Thread.** `Draft a gmail reply to ada@example.com: Thanks.` adds a seeded thread quote, `Later` and `Ignore`.
- **Slack.** `Draft a slack to #general: hi` shows `Connect Slack personal` first (the mock has no Slack account); `click --role button --name "Open in browser"` lands the sign-in about 6 seconds later and the draft appears in the same turn.
- **Gmail connect card.** Disconnect Gmail on Plugins (see `connectors-marketplace.md`), then ask for a Gmail draft.
- **Proof.** `snapshot` text for each state, one `screenshot` per state.

## Gotchas

- **The spike's Send is safe.** The mock server sends through a mock Composio account, never SMTP or a real token, and the harness blanks every key in `apps/server/.env`. A spike started any other way (`pnpm desktop:spike-server`, a hand-run server) holds the live credentials; never press Send there.
- A recipient containing `uncertain` makes the mock send return an unconfirmed outcome: the card locks as `Uncertain` and no `Sent to` reply follows.
- The mock only recognises `draft [a] gmail|email|slack [reply] [to <who>] [cc <who>]: <body>`.
- A reload resets a reopened card to folded.
- To clear `Draft Cc`, fill it with `--value " "`; an empty `--value ""` reaches the field as the text `true`, which Send then refuses as not an address.
