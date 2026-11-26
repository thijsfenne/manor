import { LOCAL_ACCESS_FILE } from './localAccess.js'
import os from 'node:os'
import path from 'node:path'
import { serverFile } from './serverRoot.js'

/** Dev-only state, gitignored. `MANOR_DATA_DIR` points it elsewhere (tests use a temp dir). */
const defaultRoot = `${serverFile('data')}/`

/**
 * `ephemeral` is a store that starts empty (`MANOR_STORE=memory`). Its sweeps see no
 * chats and would delete every live chat's scratch folder and worktree, so it never
 * gets the shared `~/.manor` dirs, whatever HOME and `MANOR_DATA_DIR` say.
 */
export function dataPaths(
  root: string = process.env.MANOR_DATA_DIR ?? defaultRoot,
  { ephemeral = false }: { ephemeral?: boolean } = {},
) {
  const sharedRoot = root === defaultRoot ? path.join(os.homedir(), '.manor') : root
  const externalRoot = ephemeral && root === defaultRoot
    ? path.join(os.tmpdir(), `manor-ephemeral-${process.pid}`)
    : sharedRoot
  return {
    root,
    // Every chat runs its turns in its own empty directory, never a real repo.
    // The scratch root deliberately lives OUTSIDE the repo by default: the CLI
    // tells the model its cwd, and a path containing the project name leaks what
    // the machine is working on into the persona (observed with "Manor"). A
    // non-default root (tests, explicit MANOR_DATA_DIR) keeps scratch inside it
    // so runs stay hermetic.
    scratch:
      process.env.MANOR_SCRATCH_DIR ??
      path.join(externalRoot, 'scratch'),
    // Per-chat git worktrees of linked folders. Same family as scratch: outside the
    // repo by default so a path containing the project name does not leak into a
    // persona, inside a non-default root so tests stay hermetic.
    worktrees:
      process.env.MANOR_WORKTREES_DIR ??
      path.join(externalRoot, 'worktrees'),
    // Where a Knowledge delete moves a note or folder, `trash/knowledge/<UTC stamp>/<path>`.
    // The scratch family, so a memory-store run never fills the real trash.
    trash: path.join(externalRoot, 'trash'),
    // Content-addressed copies of selected private skill bundles. They are a cache,
    // never the owned source, and can be rebuilt from the store after a cache cleanup.
    skills: path.join(sharedRoot, 'skills'),
    // The home the Grok CLI runs in, with login files linked from the real Grok home.
    grokHome: path.join(sharedRoot, 'grok-home'),
    // LiteLLM's public model price table, refreshed daily for the Usage view.
    usageRates: path.join(sharedRoot, 'usage-rates.json'),
    // The key the desktop shell on this Mac presents instead of a password.
    localAccessToken: path.join(sharedRoot, LOCAL_ACCESS_FILE),
    // One JSON line per finished turn with its stage timings, for latency work.
    turnStages: path.join(sharedRoot, 'logs', 'turn-stages.jsonl'),
    // The Mail door's disposable cache. Safe to delete at any time; the next poll refills it.
    mailCache: path.join(root, 'mail-cache.db'),
  }
}
