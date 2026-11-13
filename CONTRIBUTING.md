# Contributing to Manor

Thanks for looking. Manor is a small project with one maintainer, so a short issue before a large change saves us both time.

## Scope

Manor is a single user desktop app for macOS on Apple Silicon. It runs on the subscriptions the user already has and keeps everything on their Mac. Changes that need a hosted service, accounts for several people, or a metered API key as the only route do not fit. `AGENTS.md` lists the rules the project does not bend.

## Set up

You need Node 22 or newer and pnpm 10.

```sh
pnpm install
pnpm dev
pnpm desktop:dev
```

`pnpm install` also points git at the hooks in `.githooks`. The commit hook runs the tests of the packages you touched.

To try a change without touching your own Manor data or a provider subscription, use the isolated server with the mock driver.

```sh
pnpm desktop:spike-server
pnpm desktop:spike
```

To try the packaged app as a new user gets it, run a second, empty Manor beside your own. It keeps everything under `~/.manor-fresh` and leaves your own Manor alone.

```bash
pnpm desktop:fresh --build
pnpm desktop:fresh --stranger
```

The first builds the app from your tree and opens it on an empty workspace, with the provider CLIs you already signed in to. A turn there spends your real subscription. `--stranger` adds an empty home folder, so no provider is installed or signed in and you see the whole first run. `--reset` empties it first.

## Before you open a pull request

- Run the tests and the type check of the packages you changed, for example `pnpm --filter @manor/server test` and `pnpm --filter @manor/server typecheck`.
- A change in server behaviour comes with a focused test for that behaviour.
- A change in the interface comes with a screenshot or a short recording.
- Keep the change to one subject. A fix and a refactor are two pull requests.
- Files, comments and interface text are in English. The phone companion is partly Dutch for now.
- `scripts/check-public.sh` must pass. The push hook runs it.
- A change a user notices gets a line in `CHANGELOG.md`.

## What must not go in a commit

- Anything from `~/.claude`, `~/.codex`, `~/.grok`, a `.env` file or another provider sign in folder.
- Real chats, real names or real addresses in test data. Use invented ones. `scripts/check-public.sh` fails on the names a maintainer listed on their machine.
- HugeIcons Pro glyphs, as SVG or as icon data. Their licence forbids a public repository. Use the free set, see `AGENTS.md`.

## Security

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence in `LICENSE`.
