# Manor

Manor is a desktop workspace where several AI agents with their own personas share chats, organized by project. An Electron shell hosts the Vite React app and a local Node backend that wraps the provider command line tools (Claude Code, Codex, Grok and Cursor), signed in with the user's own subscription.

This file is for the agent or person changing Manor. `README.md` says what Manor is for a user, `CONTRIBUTING.md` says how to send a change, `docs/DESIGN.md` holds the design system.

Personal additions. If `~/.claude/manor.md` exists on this machine, read it before you start. It holds the additions of whoever works here and is not part of the repository.

## What Manor can never compromise on

1. **Knowledge work first.** The user does knowledge work (planning, research, client work, life admin), coding is secondary. The runtime is a coding tool, so every feature pulls toward code. Resist it. A persona that answers a planning question by reaching for a file editor is a bug.
2. **Subscriptions, not meters.** The user's existing subscriptions power the agents. Everything that touches the runtime goes through the runtime interface (agent config in, event stream out), so a driver can be swapped without a rebuild. Never call a provider tool or an API directly from feature code.
3. **Local desktop first.** No feature may require a hosted service or a second machine. The Mac desktop is the primary platform and may host native capabilities such as the in-app browser. The Expo phone companion connects to the same Mac host. Desktop keeps native browser control and project configuration.
4. **Memory in the walls.** The memory layer is infrastructure, not an agent. Standing files are read at the start of a turn, the daily log is written after it. There is no memory persona.
5. **One user.** Manor is single user by design. Reject complexity that only pays off with several tenants (organizations, roles, sharing).

## Before changing code

- Say briefly what you intend to change. For substantial work, name the scope and what done means.
- If the diff starts to touch unrelated files, stop and shrink the plan.

## A small glossary

- **the user** means the one person a Manor install serves.
- **agent / persona** means a configured Manor identity: name, character, runtime, tools and memory scope.
- **chief of staff** means the default agent that receives messages without a mention and delegates by @mention.
- **driver** means a runtime implementation behind the runtime interface.
- **provider** means the tool a driver wraps: Claude Code, Codex, Grok or Cursor.
- **project** means a container in the sidebar that holds chats, context files and optionally a linked git repository.
- **work** means one conversation inside a project, possibly with several personas.
- **DM chat** means a conversation with one agent.
- **memory layer** means the memory folder, plain markdown, `~/.manor/memory` on a new install. Not a database.

## The three ways to hurt yourself

1. **Writing memory from anywhere but the user's Mac.** Manor writes memory only as local file edits in the configured memory folder. Many users sync that folder themselves, and a second writer from somewhere else creates conflicts. Do not add a remote write path.
2. **Leaking credentials or personal context.** The provider sign ins and the chats are the user's private data. Nothing from a provider sign in folder or a `.env` file gets committed, logged or echoed into a transcript.
3. **Letting agents talk to each other unbounded.** An agent summons only names on its own allowlist. A summoner and the agent it summoned may run three review hops, then the errand ends. Any change to turn taking ships with its loop guard and its budget cap in the same change. One deliberate exception: a goal Session has no count cap. Its guards are the lead's `goal_reached`, the stall stop after two empty lead endings, the stop after a failed turn, Stop and settle. Keep those guards tested.

## Hit every surface

- **Drivers.** A feature shaped by persona or runtime needs a decision per driver, even when the decision is "not supported here". Persona application differs per driver (system prompt replacement on Claude Code, profiles and config on Codex).
- **Personas in plural.** Check every chat feature with one persona and with several: streaming, interruption, mention parsing, context cost.
- **Reverse states.** A way in ships with the way out. Add an agent to a chat, remove an agent from a chat.
- **Memory scope.** Features that inject context respect the memory switch per agent. Test with it off as well as on.
- **Desktop boundary.** Native features degrade explicitly when the Electron host is absent. Changes to shared client behaviour cover both web and the Expo companion.

## Code layout

- `apps/server` is the Node backend: WebSocket to clients, runtime interface, drivers, memory layer. The SQLite schema lives in `apps/server/sqlite/migrations/`, as versioned files the local store applies in a transaction. See `apps/server/SQLITE.md`.
- `apps/desktop` is the Electron main process, the preload bridge and the native browser host. A packaged app starts its own bundled server.
- `apps/web` is the Vite React app.
- `packages/contracts` holds the typed schemas for everything that crosses the wire. Change the schema and server and web follow.
- `apps/mobile` is the Expo phone companion. Its interface is partly Dutch.
- `packages/client-runtime` holds shared client connection and state behaviour.
- `packages/blobatar` is Manor's own copy of the blobatar face library.

## Verifying

- The smallest proof that the change works: targeted tests, lint and type check for the scope you touched.
- A change in backend behaviour ships with focused tests for that behaviour.
- Tests stay proportional. A test more complex than the behaviour it covers is over-engineering.
- Never claim success from construction. Run it, read the output, then say it works.
- Prove desktop and web interface changes on the isolated server with `.cursor/skills/verify-manor/SKILL.md` (headless Chromium on 43180, memory store, mock driver), never on the user's own Manor. Phone changes use `.cursor/skills/verify-manor-mobile/SKILL.md`.
- Review probes go in the package's gitignored `test/.review/` and run with `pnpm exec vitest run --config vitest.review.config.ts` from `apps/web` or `apps/server`. The default suite skips that folder.
- `scripts/check-public.sh` fails when a file that must stay private is tracked, and on the private names a maintainer lists on their own machine. The push hook and CI run it. `scripts/check-outgoing.sh` judges the commits of a push the same way, their mail addresses and their messages. Only the push hook runs that one.
- Never test against a real subscription carelessly, runs with several agents burn real quota. Use the mock driver for interface work.

## Taste

- Prefer one fix at the root cause. Before you add an adapter, a compatibility path, a configuration layer or a second implementation, establish that the requirement needs it.
- Complexity belongs at the driver boundary. Orchestration stays pure, the interface stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, not what the next line does.
- This is a chat app someone looks at all day. A dropped frame, a lying spinner or a stale label is a real defect. Motion comes from `motion/react`.
- Icons are HugeIcons, the free MIT set: import from `@hugeicons/core-free-icons`, render with `HugeiconsIcon` from `@hugeicons/react`. The package is pinned to the exact version, because a newer one redraws glyphs. Pro glyphs may not be committed. File type glyphs come from `@pierre/trees` through `components/fileMark.tsx`. Filled glyphs are only for active and selected states and come from `@manor/client-runtime/solid-icons`, a file generated from the line icons (`pnpm --filter @manor/client-runtime generate:solid-icons`). No emoji and no ad hoc inline SVG icons.
- Colours come from the `@theme` tokens in `apps/web/src/styles.css` or the `--accent` variable of a persona. Persona colours are runtime data, not tokens. The exempt files are listed in `.claude/hooks/check-colors.sh`.
- Files in this repository are in English.

## Working files

- Plans go in `.claude/plans/` and loose ideas in `.claude/ideas/`, as `YYYY-MM-DD-short-slug.md`. Both folders are gitignored. A plan opens with YAML frontmatter that carries `status:` (`ready`, `in-progress`, `shipped`, `parked`, `reference`).
- A Stop hook (`.claude/hooks/auto-review.sh`) asks for a review in Claude Code and Codex once enough unreviewed app code is on the branch. Each runtime has a read only reviewer agent. Record the review with `.claude/hooks/record-review.sh`.
- A PostToolUse hook warns on a hardcoded hex or rgba colour outside the token files.
- Codex gets the same setup through `.codex/`: `hooks.json` points at the scripts in `.claude/hooks/`, and `agents/reviewer.toml` mirrors `.claude/agents/reviewer.md`. Change both in the same change.
