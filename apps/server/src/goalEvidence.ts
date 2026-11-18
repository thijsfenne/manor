import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { ThreadEvent } from '@manor/contracts'
import { INTERPRETERS, SCRIPT_PATH, commandArguments, shellSteps } from './drivers/commands.js'
import { isProse } from './goalReview.js'

/**
 * The rule (2026-10-18): a Session reports Done only with proof that is newer than
 * its last code change. Measured over the 30 days before, the two largest reasons the user
 * came back after a Done were a result that looked different from what they asked
 * (visual-mismatch, 23 rounds) and a claim that did not hold (not-proven, 21 rounds).
 * Both shared one shape: nothing in the Session showed the final code working.
 * `goal_reached` therefore reads the Session's own record, never the claim:
 *
 * - in a project with a screenshot route (a verify skill, see `verifySkills.ts`), a changed
 *   file that renders needs a screenshot passed to `goal_reached`, taken after that file
 *   last changed, so the card shows the after state;
 * - any other changed code needs a successful test, typecheck, build or script run
 *   after it last changed, or such a screenshot.
 *
 * Since 2026-11-18 a project without a route holds a file that renders to the second rule:
 * demanding a picture nobody can take turned every UI change there into a question card.
 * The result card then says the change was not checked on screen (`OFF_SCREEN_LIMITATION`),
 * so the missing picture is never silent.
 *
 * The user saying yes to the `report_without_proof` question after the last change lifts the
 * rule, for work no screenshot or check can show; skipping proof costs them a visible click.
 *
 * The gate catches a forgotten proof, not a forged one: a check followed by a pipe or `;`,
 * as in `pnpm test | tail` or `pnpm build; pkill vite`, counts as run whatever it printed,
 * since the call's exit code is the last command's. Refusing those refused 3 of the last
 * 20 Done reports whose agents had read a passing check. A screenshot's file time stands
 * for when it was taken.
 */

/**
 * Files whose change only a picture proves: markup, styles, images, theme, token and
 * `…Renderer` modules, any module in a `components` folder (icon geometry and face motion live in
 * `.ts` there), and the blobatar face renderer. Tests and stories are code, whatever
 * their extension.
 */
export const isUiFile = (file: string): boolean =>
  (/\.(tsx|jsx|css|scss|html|svg|vue|svelte|png|jpe?g|webp|gif)$/i.test(file) ||
    /[/\\](components|blobatar[/\\]src)[/\\](.+[/\\])?[^/\\]+\.(ts|mts|js)$/i.test(file) ||
    /(^|[/\\])(theme|tokens|colou?rs|\w*Renderer)\.(ts|mts|js)$/i.test(file)) &&
  !/(\.test\.|\.spec\.|\.stories\.|(^|[/\\])test[/\\])/i.test(file)

const CHECK_TOOLS = new Set(['vitest', 'jest', 'mocha', 'playwright', 'pytest', 'tsc', 'vue-tsc', 'eslint', 'oxlint', 'biome', 'xcodebuild', 'maestro'])
const BUILD_TOOLS = new Set(['cargo', 'go', 'swift'])
const BUILD_VERBS = new Set(['test', 'build', 'check', 'vet', 'clippy'])
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun'])
const PACKAGE_SCRIPT = /^(test|typecheck|lint|build|check|verify|smoke)([:-]\S*)?$/
/** Package manager flags that take the next word as their value. */
const VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--workspace'])
const RUNNERS = new Set(['npx', 'bunx'])

const commandName = (word: string) => word.replace(/^[({]+/, '').split('/').at(-1) ?? ''

/**
 * Whether one shell step runs a check: a test runner, typecheck, linter or build, a
 * package script of that kind, or a script file run by an interpreter or directly.
 * Read from the step's words, so `rg "pnpm test"` or `echo vitest` is no check.
 */
function checkStep(words: readonly string[]): boolean {
  let rest = commandName(words[0] ?? '') === 'time' ? words.slice(1) : [...words]
  if (RUNNERS.has(commandName(rest[0] ?? ''))) {
    rest = rest.slice(1)
    while (rest[0]?.startsWith('-') === true) rest = rest.slice(1)
  }
  const name = commandName(rest[0] ?? '')
  // `tsc --version` or `vitest run --help` names a check tool and runs nothing.
  if (CHECK_TOOLS.has(name)) {
    const args = commandArguments(rest.slice(1))
    return !args.some((word) => HELP_FLAGS.has(word)) && (args.length === 0 || !args.every((word) => VERSION_FLAGS.has(word)))
  }
  if (BUILD_TOOLS.has(name)) return BUILD_VERBS.has(rest[1] ?? '')
  if (name === 'node' && rest[1] === '--test') return true
  if (PACKAGE_MANAGERS.has(name)) {
    for (let index = 1; index < rest.length; index += 1) {
      const word = rest[index] ?? ''
      if (VALUE_FLAGS.has(word)) index += 1
      else if (word === 'exec' || word === 'dlx') return checkStep(rest.slice(index + 1))
      else if (word !== 'run' && !word.startsWith('-')) return PACKAGE_SCRIPT.test(word) && !commandArguments(rest.slice(index + 1)).some((arg) => HELP_FLAGS.has(arg))
    }
    return false
  }
  // A script file, or a heredoc piped to the interpreter (`node --input-type=module <<'JS'`). Inline code
  // after `-`, `-c`, `-e` or `-i` is how agents edit files, and `--version` runs nothing, so neither is a check.
  if (INTERPRETERS.has(name)) {
    const args = commandArguments(rest.slice(1))
    const script = args.find((word) => !word.startsWith('-'))
    return script !== undefined ? SCRIPT_PATH.test(script) : args.every((flag) => STDIN_FLAGS.has(flag) || flag.startsWith('--input-type='))
  }
  return /^\.\.?\//.test(rest[0] ?? '') && SCRIPT_PATH.test(rest[0] ?? '')
}

/** Flags that only print a tool's version, alone, or its usage, anywhere. */
const VERSION_FLAGS = new Set(['--version', '-V', '-v'])
const HELP_FLAGS = new Set(['--help', '-h'])

/** Interpreter flags that still leave it reading a script from stdin. */
const STDIN_FLAGS = new Set(['-u', '-I', '-B', '-s', '-l', '--no-warnings'])

/** Folders whose files are scratch, not the code under test. */
const SCRATCH = /^(\/dev\/|\/tmp\/|\/private\/tmp\/|\/var\/folders\/)/

/** Git commands that rewrite files in the checkout. */
const GIT_WRITES = new Set(['rebase', 'merge', 'pull', 'checkout', 'switch', 'reset', 'restore', 'stash', 'cherry-pick', 'revert', 'am', 'apply'])

/** The git subcommand a step runs and its first argument, past `-C <dir>` and `-c <key=value>`. */
const gitVerb = (words: readonly string[]): string[] => {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? ''
    if (word === '-C' || word === '-c') index += 1
    else if (!word.startsWith('-')) return words.slice(index).filter((rest) => !rest.startsWith('-')).slice(0, 2)
  }
  return []
}

/** Whether a git step rewrites the checkout; `git stash list` and `git stash show` only read. */
const gitWrites = (words: readonly string[]): boolean => {
  const [verb = '', sub = ''] = gitVerb(words)
  return GIT_WRITES.has(verb) && !(verb === 'stash' && ['list', 'show'].includes(sub))
}

/** Whether a shell step removes or moves a file, `git rm` and `git mv` included. */
const removeStep = (words: readonly string[]): boolean => {
  const name = commandName(words[0] ?? '')
  return name === 'rm' || name === 'mv' || (name === 'git' && words.some((word) => word === 'rm' || word === 'mv'))
}

/**
 * Whether a shell step changes a file: an in-place editor, inline code, a copy, a git
 * command that rewrites the checkout, or a removal, move or redirect outside scratch
 * folders, wherever a `cd` left the shell.
 */
function editStep({ words, written, folder }: { words: readonly string[]; written: readonly string[]; folder: string | undefined }): boolean {
  const name = commandName(words[0] ?? '')
  const flags = words.slice(1).filter((word) => word.startsWith('-'))
  const kept = (target: string) => !SCRATCH.test(folder === undefined || target.startsWith('/') ? target : path.posix.join(folder, target))
  return ((name === 'sed' || name === 'perl') && flags.some((flag) => /^-\w*i/.test(flag) || flag === '--in-place')) ||
    (INTERPRETERS.has(name) && (words[1] === '-' || flags.some((flag) => flag === '-c' || flag === '-e'))) ||
    ['cp', 'tee', 'install', 'patch'].includes(name) || (name === 'git' && gitWrites(words)) ||
    (removeStep(words) && words.slice(1).some((word) => !word.startsWith('-') && !['rm', 'mv'].includes(word) && kept(word))) ||
    written.some(kept)
}

/** The command a shell runs, without the bodies of its heredocs, which are file content and not commands. */
export const withoutHeredocs = (command: string): string =>
  command.replace(/<<-?\s*(['"]?)([\w.-]+)\1[^\n]*\n[\s\S]*?(\n\s*\2(?![\w.-])|$)/g, '')

/**
 * From when this shell call's check proves the code, or undefined when it proves none.
 * A check alone proves the code as it was when it started, so an edit made while it ran
 * is not covered; a check after an edit in the same command proves it from the
 * command's end. A `||` after the last check, which runs on its failure and hides it, or a
 * rewrite after it, leaves the command without proof.
 */
export function checkFrom(event: Extract<ThreadEvent, { type: 'tool_use' }>): 'start' | 'end' | undefined {
  if (event.command === undefined) return undefined
  const steps = shellSteps(withoutHeredocs(event.command))
  let last = -1
  steps.forEach((step, index) => { if (checkStep(step.words)) last = index })
  if (last === -1 || steps.slice(last).some((step) => step.then === '||')) return undefined
  if (steps.slice(last + 1).some(editStep)) return undefined
  // Edits Manor read off this command came before its last check, which no later step rewrites.
  return (event.edits ?? []).length > 0 || steps.slice(0, last).some(editStep) ? 'end' : 'start'
}

/** Whether this shell call runs a check that proves the code. */
export const runsCheck = (event: Extract<ThreadEvent, { type: 'tool_use' }>): boolean => checkFrom(event) !== undefined

/** From when each successful check in these events proves the code, in Manor's clock. */
export function checkRunTimes(events: readonly ThreadEvent[]): number[] {
  const checks = new Map<string, number | 'end'>()
  const times: number[] = []
  for (const event of events) {
    if (event.type === 'tool_use' && event.toolCallId !== undefined) {
      const from = checkFrom(event)
      if (from === 'end') checks.set(event.toolCallId, 'end')
      else if (from === 'start' && event.ts !== undefined) checks.set(event.toolCallId, event.ts)
    }
    if (event.type !== 'tool_result' || event.outcome !== 'success' || event.ts === undefined) continue
    const from = checks.get(event.toolCallId)
    if (from !== undefined) times.push(from === 'end' ? event.ts : from)
  }
  return times
}

/** The `ask_user` question id whose yes lets a Session report without proof. */
export const PROOF_WAIVER_ID = 'report_without_proof'

/** When the user agreed, in answer to the waiver question, to a report without proof. */
export const waiverTimes = (events: readonly ThreadEvent[]): number[] =>
  events.flatMap((event) => {
    // Only the user waives proof; Manor answering from a preference never does.
    if (event.type !== 'user_input_response' || event.ts === undefined || event.fromPreference !== undefined) return []
    const answer = event.answers[PROOF_WAIVER_ID]
    const lines = answer === undefined ? [] : typeof answer === 'string' ? [answer] : answer
    return lines.some((line) => /^\s*(yes|ja|report)\b/i.test(line)) ? [event.ts] : []
  })

export interface SessionChange { file: string; changedAt: number; deleted?: true }

/**
 * When the nearest folder that still exists last changed, which a deletion inside it
 * updates. A path with only the filesystem root left was never a checkout file.
 */
async function deletedAt(file: string): Promise<number | undefined> {
  for (let folder = path.dirname(file); path.dirname(folder) !== folder; folder = path.dirname(folder)) {
    const info = await stat(folder).catch(() => undefined)
    if (info?.isDirectory() === true) return info.mtimeMs
  }
  return undefined
}

/**
 * Whether a removal operand names this file or a folder holding it. A full path, or one a
 * `cd` in the same command anchors, must match exactly; a relative one, from wherever the
 * shell stood, by its trailing path.
 */
const removesFile = (operand: string, folder: string | undefined, file: string): boolean => {
  const target = (folder === undefined || operand.startsWith('/') ? operand : path.posix.join(folder, operand))
    .replace(/^\.\//, '').replace(/\/+$/, '')
  if (target.length === 0 || target === '.') return false
  if (target.startsWith('/')) return file === target || file.startsWith(`${target}/`)
  return file.endsWith(`/${target}`) || file.includes(`/${target}/`)
}

/**
 * When the last tool call that deleted each file ran: an edit that is a deletion, by its
 * kind or by having no after side (Codex reports its native edits on the result, by
 * `originPath`), or a shell step that removes or moves the file or its folder.
 */
const deletingCalls = (events: readonly ThreadEvent[], files: readonly string[]): Map<string, number> => {
  const found = new Map<string, number>()
  const started = new Map<string, number>()
  for (const event of events) {
    if ((event.type !== 'tool_use' && event.type !== 'tool_result') || event.ts === undefined) continue
    if (event.type === 'tool_use' && event.toolCallId !== undefined) started.set(event.toolCallId, event.ts)
    const at = event.type === 'tool_result' ? started.get(event.toolCallId) ?? event.ts : event.ts
    const removes = event.type !== 'tool_use' || event.command === undefined ? [] : shellSteps(withoutHeredocs(event.command))
      .filter(({ words }) => removeStep(words))
      .flatMap(({ words, folder }) => words.slice(1).filter((word) => !word.startsWith('-') && word !== 'rm' && word !== 'mv')
        .map((operand) => ({ operand, folder })))
    for (const file of files) {
      const deleted = (event.edits ?? []).some((edit) => (edit.kind === 'delete' || (edit.before !== undefined && edit.after === undefined)) &&
        ((edit.originPath ?? edit.path) === file || edit.path === file))
      if (deleted || removes.some(({ operand, folder }) => removesFile(operand, folder, file))) found.set(file, at)
    }
  }
  return found
}

/** When a turn first reported each file deleted, which bounds when it went. */
const reportedDeleted = (events: readonly ThreadEvent[]): Map<string, number> => {
  const reported = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'turn_result' || event.ts === undefined) continue
    for (const change of event.fileChanges ?? []) {
      if (change.status === 'deleted' && !reported.has(change.path)) reported.set(change.path, event.ts)
    }
  }
  return reported
}

/**
 * The last write time of each changed code file; prose and relative names carry no proof
 * duty. A deleted file counts as changed when the tool call that removed it ran, or else at
 * the earlier of two times that both follow its deletion, the end of the turn that first
 * reported it gone and its folder's last change. It counts as code: a build or test, not
 * a picture, shows nothing still needs it.
 */
export async function codeChangeTimes(files: readonly string[], events: readonly ThreadEvent[] = []): Promise<SessionChange[]> {
  const code = [...new Set(files)].filter((file) => path.isAbsolute(file) && !isProse(file))
  const reported = reportedDeleted(events)
  const found = await Promise.all(code.map(async (file) => ({ file, info: await stat(file).catch(() => undefined) })))
  const removed = deletingCalls(events, found.filter(({ info }) => info === undefined).map(({ file }) => file))
  const changes = await Promise.all(found.map(async ({ file, info }): Promise<SessionChange | undefined> => {
    if (info !== undefined) return info.isFile() ? { file, changedAt: info.mtimeMs } : undefined
    // The call that removed it, when the transcript names one, is the closest time; a later note beside it moves neither.
    const named = removed.get(file)
    if (named !== undefined) return { file, changedAt: named, deleted: true }
    const bounds = [reported.get(file), await deletedAt(file)].filter((time) => time !== undefined)
    return bounds.length === 0 ? undefined : { file, changedAt: Math.min(...bounds), deleted: true }
  }))
  return changes.filter((change) => change !== undefined)
}

/** What the gate calls changes Manor could not see, in its refusal. */
const UNMEASURED = 'files Manor could not measure'

/**
 * A checkout Manor could not measure hides what its turn changed, so it counts as code
 * changed at that turn's last tool call other than `goal_reached`: a check run last, or
 * the user's later waiver, still proves it. `failedTurnId` names the live turn whose
 * measurement just failed; a finished one says so on its result or note.
 */
export function unmeasuredChanges(events: readonly ThreadEvent[], failedTurnId?: string): SessionChange[] {
  const failed = new Set(events.flatMap((event) =>
    (event.type === 'turn_result' || event.type === 'system_note') && event.fileChangesFailed === true && event.turnId !== undefined ? [event.turnId] : []))
  if (failedTurnId !== undefined) failed.add(failedTurnId)
  return [...failed].flatMap((turnId) => {
    const calls = events.flatMap((event) =>
      event.type === 'tool_use' && event.turnId === turnId && event.ts !== undefined && !/goal_reached$/.test(event.tool) ? [event.ts] : [])
    return calls.length === 0 ? [] : [{ file: UNMEASURED, changedAt: Math.max(...calls) }]
  })
}

const latest = (changes: readonly SessionChange[]) =>
  changes.reduce<SessionChange | undefined>((last, change) => last === undefined || change.changedAt > last.changedAt ? change : last, undefined)

const names = (changes: readonly SessionChange[]) => {
  const shown = changes.slice(0, 3).map((change) => path.basename(change.file))
  return changes.length > 3 ? `${shown.join(', ')} and ${changes.length - 3} more` : shown.join(', ')
}

/** The UI files changed or deleted after the newest screenshot passed. */
export const unseenUi = (changes: readonly SessionChange[], screenshotsTakenAt: readonly number[]): SessionChange[] =>
  changes.filter((change) => isUiFile(change.file) && !screenshotsTakenAt.some((time) => time >= change.changedAt))

/** What the result card says when a project without a screenshot route changed UI nobody saw. */
export const OFF_SCREEN_LIMITATION = 'Not checked on screen.'

/** The report's limitation line, led by `OFF_SCREEN_LIMITATION` and kept within the schema's 300 characters. */
export const offScreenLimitation = (limitations: string | undefined): string =>
  limitations === undefined ? OFF_SCREEN_LIMITATION : `${OFF_SCREEN_LIMITATION} ${limitations}`.slice(0, 300).trimEnd()

/** Why `goal_reached` may not record yet, or undefined when the proof is newer than every change. */
export function goalEvidenceBlock(input: {
  changes: readonly SessionChange[]
  /** Write times of the screenshots this call passed. */
  screenshotsTakenAt: readonly number[]
  checksAt: readonly number[]
  /** When the user agreed to a report without proof, see `waiverTimes`. */
  waivedAt: readonly number[]
  /** The project's verify skills, as the agent should read their names; empty when it has none. */
  screenshotRoutes: readonly string[]
}): string | undefined {
  const last = latest(input.changes)
  if (last === undefined) return undefined
  const after = (times: readonly number[], since: number) => times.some((time) => time >= since)
  if (after(input.waivedAt, last.changedAt)) return undefined
  const ask = `If no screenshot or check can show this change, ask the user with ask_user, question id "${PROOF_WAIVER_ID}", ` +
    'whether to report without that proof; an option starting with "Yes" that they pick unlocks it.'
  // A deleted file has nothing left to picture, so it needs a check instead.
  const stale = input.screenshotRoutes.length === 0 ? [] : unseenUi(input.changes, input.screenshotsTakenAt).filter((change) => change.deleted !== true)
  if (stale.length > 0) {
    return `The goal is not marked reached: ${names(stale)} changed after the newest screenshot you passed${input.screenshotsTakenAt.length === 0 ? ' (none)' : ''}. ` +
      `Take an after screenshot of every state you claim with this project's verify skill (${input.screenshotRoutes.join(' or ')}), ` +
      `compare it with the reference or ask you were given, and pass it in screenshots, then call goal_reached again. ${ask}`
  }
  if (after(input.checksAt, last.changedAt) || after(input.screenshotsTakenAt, last.changedAt)) return undefined
  const unproven = input.changes.filter((change) => !after(input.checksAt, change.changedAt))
  return `The goal is not marked reached: ${names(unproven)} changed after the last successful test, typecheck, build or script run in this Session. ` +
    `Run the check that proves the current code, then call goal_reached again. ${ask}`
}
