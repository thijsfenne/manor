# Manor

Manor is a desktop workspace where several AI agents, each with its own name, character and tools, share your chats and projects. It runs on the subscriptions you already have. Manor starts the provider's own command line tool (Claude Code, Codex, Grok or Cursor) and shows what it does, so there is no API key to buy and no meter running.

It is a Mac app for Apple Silicon. Everything stays on your Mac: the chats, the settings and the memory.

## What you get

- Agents you define yourself, with a name, a role, instructions, a provider and a model.
- Direct messages with one agent, and rooms where several agents work on one thread.
- Projects that hold chats, files and a linked folder or git repository.
- A memory folder of plain markdown that your agents read and that Manor keeps up to date.
- A Knowledge folder for your own notes. An Obsidian vault works as it is.
- A built in browser that agents can use, with your approval.
- A phone companion (Expo, in `apps/mobile`) that connects to Manor on your Mac. You build it yourself, see `apps/mobile/README.md`. Its interface is partly Dutch.

## Requirements

- macOS on Apple Silicon.
- A subscription to at least one provider, and that provider's command line tool. Manor can install Claude Code for you and installs Codex itself. Grok and Cursor you install yourself.
- To build from source you need Node 22 or newer and pnpm 10.

Manor has no GitHub sign in of its own. An agent that works in a linked folder uses the git and `gh` sign in of your Mac user, the same one your Terminal uses. Manor stores and passes no token of its own. If you have never signed in, run `gh auth login` once first. A Grok agent is the exception: it runs with a home folder of its own and sees your ssh keys, but not your git settings or your `gh` sign in.

## Build and run from source

There is no download yet. You build the app on your own Mac, which takes a few minutes. An app you build yourself opens without a Gatekeeper warning.

```sh
pnpm install
pnpm --filter @manor/desktop package:mac
open apps/desktop/release/mac-arm64/Manor.app
```

The app carries its own server and starts it when you open it. The first time, a short setup asks for your name, helps you sign in to a provider and creates your first agent.

For development, run the server and the web client with live reload, then the desktop shell on top of them.

```sh
pnpm dev
pnpm desktop:dev
```

## Where your data lives

Everything Manor writes sits under `~/.manor`.

| Path | What it holds |
|---|---|
| `~/.manor/sqlite/manor.db` | Agents, projects, chats and settings |
| `~/.manor/memory` | The memory folder |
| `~/.manor/knowledge` | The Knowledge folder |

You can move the memory folder and the Knowledge folder in Settings, under Memory and knowledge.

## The memory folder

Memory is a folder of markdown files. You can read and edit all of it.

| File | Purpose |
|---|---|
| `soul.md` | How your agents should sound and what they should care about |
| `user-core.md` | Who you are and how you like to work |
| `rules.md` | Standing rules for every agent |
| `memory/daily/YYYY-MM-DD.md` | The daily log. Manor adds a line when a turn decided or learned something |
| `memory/long-term.md` | What Manor kept from finished days of the daily log |
| `memory/agents/<agent>.md` | Notes one agent keeps about how it works for you |

Agents with memory switched on read the first three files and `long-term.md` at the start of every turn. If you point Manor at a folder you already keep, it uses that folder as it is. It distills the daily log only in a folder that has a `memory/long-term.md`.

## How far agents may act

Agents can click in the browser and write through connectors. A new install runs in `auto` mode. An independent model allows what is clearly low impact, and Manor asks you about the rest. Set `MANOR_EFFECT_MODE` to `confirm` to be asked every time, or to `full-access` to never be asked.

## Settings

Most settings are in the app. A few are environment variables. The app reads them from `~/.manor/.env`, and a server run from source reads `apps/server/.env` first. `apps/server/.env.example` lists them with what they do. Apple Reminders, for one, is off until that file says `MANOR_REMINDERS=on`.

## Tests

```sh
pnpm test
pnpm typecheck
```

## Subscriptions and provider terms

Manor does not call a model API and does not send a sign in token anywhere. It starts the provider's own, unchanged command line tool on your Mac, with the sign in you did in that tool's own sign in flow. For Codex and Grok it links the tool's sign in file into a settings folder of its own under `~/.manor`. That file never leaves your Mac.

What this means for you.

- You use your own subscription under that provider's terms. Read them. Whether your plan allows use through another app is between you and the provider, and a provider can change its rules.
- Everything your agents do counts against the limits of your plan.
- For Claude, Manor gives the command line tool its own name in place of the name the tool uses for scripted runs. In our own measurements the same work then took less of the 5 hour limit. To keep the tool's default, put `MANOR_CLAUDE_ENTRYPOINT=` with no value in `~/.manor/.env`.
- Manor is made for local, personal use. Do not host it for other people on your subscription.

Manor is not affiliated with or endorsed by Anthropic, OpenAI, xAI or Cursor.

## Contributing

See `CONTRIBUTING.md`. To report a security problem, see `SECURITY.md`.

## Licence

MIT, see `LICENSE`. Code and assets from other projects are listed in `THIRD_PARTY_NOTICES.md`.
