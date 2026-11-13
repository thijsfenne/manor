# Outbound drafts

A persona can prepare a Gmail or Slack draft that the user edits, copies or submits. On the spike the mock driver turns a message shaped like `Draft a gmail to <address>: <body>` into a draft, shown in a dock above the composer with subject, body, Copy, Submit and Discard.

## Sub-features

- `draft-create` produces a Gmail draft from a mock turn.
- `draft-edit` changes `Draft subject` or `Draft body` in place.
- `draft-copy` copies the draft; the button reads `Copied` briefly.
- `draft-discard` removes the draft.

## How to get to it (user POV)

- Ask an agent for a draft. On the spike, send `Draft a gmail to ada@example.com: Hello Ada, see you Thursday.` in the Marlow DM.

## Driving it with control-manor

Preconditions: spike launched by `control-manor.mjs launch` (it blanks every key in `apps/server/.env`, see Gotchas), Marlow DM from `home`.

- **Create.** `fill --composer --value "Draft a gmail to ada@example.com: Hello Ada, see you Thursday."`, `click --role button --name Send --exact`, `wait-settle`. Expect in `contentinfo` the text `Gmail draft from Personal · ada@example.com`, `textbox "Draft subject"` = `Draft from Manor`, `textbox "Draft body"` = `Hello Ada, see you Thursday.`, and buttons `Copy`, `Submit`, `Discard draft`.
- **Edit.** `fill --role textbox --name "Draft body" --value "Hello Ada, Friday instead."`; the snapshot shows the new body.
- **Copy.** `click --role button --name Copy --exact`; the button is named `Copied` right after.
- **Proof.** `snapshot --aria` and `screenshot` after create and after copy.

## Gotchas

- **Never press Submit.** It really sends: Gmail through SMTP with `MANOR_MAIL_IMAP_USER`/`_PASSWORD`, Slack through its token. The server loads `apps/server/.env`, so a spike started any other way (`pnpm desktop:spike-server`, a hand-run server) holds the live credentials and would mail from the maintainer's account. The harness passes every key in that file as an empty variable, which wins over the file; `sendGmail` then refuses with `Gmail sending is unavailable…`. Even then, Submit is not needed to prove this feature.
- The draft lives in the composer dock (`contentinfo`), not inside the reply bubble.
- The mock only recognises `draft gmail|email|slack`, optionally `to <target>` and `: <body>`. A Slack draft needs a real channel id; `Draft slack to #general: hi` is refused with `The outbound draft was invalid and was not added.`, so Slack drafts are not reachable on the spike.
- With a draft open, `contentinfo` holds the draft fields too; address the message box with `--composer`, never `--role textbox`.
