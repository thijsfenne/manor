# Security

## Report a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private report instead. Open the Security tab of this repository and choose "Report a vulnerability". Only the maintainer sees the report.

Say what you found, how to reproduce it and what an attacker gains. A proof of concept helps. Leave real credentials, chats and personal data out of the report.

Manor is maintained by one person in spare time. Expect a first answer within a week. A fix lands on `main`, since there are no release branches.

## What counts

Manor runs on one Mac for one user, and its server listens on the local machine. These are the parts where a flaw matters most.

- The local access key (`<data dir>/local-access-token`) and the device sessions of the phone companion.
- Anything that lets a web page, a file or a tool result make an agent act outside its approval rules.
- The in-app browser and the copy of a browser profile it can use.
- Provider sign ins. Manor starts the provider's own command line tool and must never read, store or pass on its credentials.
- Keys in `<data dir>/.env`, such as the Composio key.
- Writes outside the folders the user picked (data, memory, Knowledge, a linked project).

## What does not count

- A problem in a provider's command line tool or service. Report that to the provider.
- An attacker who already has the user's macOS account. That account can read everything Manor stores.
- Agents that run with full access because the user chose that mode.
