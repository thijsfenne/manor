import path from 'node:path'
import type { FileEdit } from '@manor/contracts'
import { editsFromApplyPatch, editsFromShellWrite } from './edits.js'
import { searchSubject } from './toolActivity.js'

export interface CommandActivity {
  tool: string
  detail: string
  subject?: string
  targets?: string[]
  command: string
  edits?: FileEdit[]
}

const truncate = (value: string, limit = 120): string =>
  value.length > limit ? `${value.slice(0, limit - 3)}...` : value

const commandName = (word: string): string => word.split('/').at(-1) ?? word

const SEARCH_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag'])
/** Commands that only steer or trim a search and cannot write a file of their own. */
const SEARCH_COMPANIONS = new Set(['cd', 'pwd', 'head', 'tail', 'wc', 'cut', 'true'])

/**
 * The files an unquoted output redirect writes, read from the raw segment so a quoted
 * `'>'` pattern is not one and `input.txt>output.txt` is. Discarding output or
 * merging streams is not a write.
 */
function redirectTargets(segment: string): string[] {
  const targets: string[] = []
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char !== '>') continue
    let at = index + 1
    if (segment[at] === '>') at += 1
    if (segment[at] === '&' && /[\d-]/.test(segment[at + 1] ?? '')) {
      index = at + 1
      continue
    }
    if (segment[at] === '&' || segment[at] === '|') at += 1
    while (segment[at] === ' ' || segment[at] === '\t') at += 1
    let target = ''
    while (at < segment.length && !/[\s;&|<>]/.test(segment[at] ?? '')) target += segment[at++]
    target = target.replace(/^['"]|['"]$/g, '')
    if (target !== '' && target !== '/dev/null') targets.push(target)
    index = at - 1
  }
  return targets
}

/** Commands that never write a file unless a redirect makes them. */
const READ_ONLY_COMMANDS = new Set([
  'cat', 'nl', 'head', 'tail', 'less', 'wc', 'ls', 'pwd', 'stat', 'file', 'du', 'echo', 'printf', 'true',
  'which', 'diff', 'cut', 'tree', ...SEARCH_COMMANDS,
])
const READ_ONLY_GIT = new Set(['diff', 'log', 'show', 'status', 'blame', 'ls-files', 'grep', 'rev-parse'])

/** Whether the command itself only reads, leaving any redirect aside. */
function readOnlyCommand(words: readonly string[]): boolean {
  const name = commandName(words[0] ?? '')
  if (READ_ONLY_COMMANDS.has(name)) return true
  if (name === 'sed') return !words.some((word) => word.startsWith('-i') || word === '--in-place')
  if (name !== 'git') return false
  const rest = words.slice(1)
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? ''
    if (word === '-C' || word === '-c') index += 1
    else if (!word.startsWith('-')) return READ_ONLY_GIT.has(word)
  }
  return false
}

/** The file a read-only git command writes through `--output`, beside its redirects. */
function gitOutputTargets(words: readonly string[]): string[] {
  if (commandName(words[0] ?? '') !== 'git') return []
  return words.flatMap((word, index) =>
    word.startsWith('--output=') ? [word.slice('--output='.length)]
      : word === '--output' && words[index + 1] !== undefined ? [words[index + 1] ?? ''] : [])
}

/**
 * Command or process substitution, which runs a command inside an argument or a
 * heredoc. Even quoted, a read that carries one may write.
 */
const SUBSTITUTION = /\$\(|`|[<>]\(/

/** Interpreters that run the script named right after them. */
export const INTERPRETERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'deno', 'bun', 'tsx', 'ts-node', 'ruby', 'perl', 'php'])
export const SCRIPT_PATH = /^[\w.\-/]+\.(?:[cm]?[jt]sx?|py|sh|rb|pl|php)$/

/**
 * Where a segment names the script it runs (`node tool.mjs launch`): running a file
 * another chat changed does not claim it (2026-10-12). Only the word right after the
 * interpreter, or its `run`, and only a plain script path; anything else stays named,
 * since a missed write would leave an approved change out of the commit.
 */
function scriptIndex(words: readonly string[]): number | undefined {
  let at = 0
  while (/^\w+=/.test(words[at] ?? '')) at += 1
  const name = commandName(words[at] ?? '')
  if (!INTERPRETERS.has(name)) return undefined
  const next = (name === 'bun' || name === 'deno') && words[at + 1] === 'run' ? at + 2 : at + 1
  return SCRIPT_PATH.test(words[next] ?? '') ? next : undefined
}

/** Each segment of a shell command with the folder it ran in, and the command's last folder. */
function shellParts(command: string) {
  const wrapper = /^\/bin\/(?:ba|z)?sh\s+-lc\s+(['"])([\s\S]*)\1$/.exec(command.trim())
  const parts: { folder: string | undefined; words: string[]; named: string; written: string[]; readOnly: boolean; then: ShellJoin }[] = []
  const body = wrapper?.[2] ?? command
  // A heredoc's body arrives as segments of its own, so no word of it is taken for a script.
  const heredoc = body.includes('<<')
  const joins: ShellJoin[] = []
  let folder: string | undefined
  for (const [position, segment] of shellSegments(body, joins).entries()) {
    const raw = shellWords(segment)
    const words = raw.filter((word) => !/^\w+=/.test(word))
    const changesFolder = commandName(words[0] ?? '') === 'cd'
    const substitutes = SUBSTITUTION.test(segment)
    const ran = heredoc || substitutes ? undefined : scriptIndex(raw)
    // Redirects and substitutions expand in the folder a command starts in, a `cd`'s too.
    parts.push({
      folder, words, written: [...redirectTargets(segment), ...gitOutputTargets(words)], then: joins[position],
      // The script's folder stays: `node src/gen.cjs Foo.ts` may write `src/Foo.ts`.
      named: ran === undefined ? segment : raw.map((word, index) => index === ran ? path.posix.dirname(word) : word).join(' '),
      readOnly: (changesFolder || readOnlyCommand(words)) && !substitutes,
    })
    if (!changesFolder) continue
    // After a substitution the folder a `cd` lands in is unknown.
    const target = words[1]
    folder = substitutes || target === undefined || target === '-' || target.startsWith('~') ? undefined
      : target.startsWith('/') || folder === undefined ? target : path.posix.join(folder, target)
  }
  return { parts, folder }
}

/**
 * The parts of a shell command that may have written a file, each with the folder it
 * ran in. A shared working copy credits a measured change to a turn only through
 * these, so reading a file another chat changed does not claim it. A read that is
 * redirected contributes only its output file, and the command's last folder stays
 * for a later call that relies on it.
 */
export function writingParts(command: string): string[] {
  const { parts, folder } = shellParts(command)
  const named = parts.flatMap(({ folder: where, named: text, written, readOnly }) => {
    const prefix = where === undefined ? '' : `cd ${where} && `
    return !readOnly ? [`${prefix}${text}`] : written.length > 0 ? [`${prefix}${written.join(' ')}`] : []
  })
  return folder === undefined ? named : [...named, `cd ${folder}`]
}

/**
 * Each step of a shell command, a provider's `/bin/zsh -lc '…'` wrapper unwrapped: its
 * words without environment assignments, the files it redirects into, the folder an
 * earlier `cd` left it in when known, and the operator that joins it to the next step.
 */
export const shellSteps = (command: string): { words: string[]; written: string[]; folder: string | undefined; then: ShellJoin }[] =>
  shellParts(command).parts.map(({ words, written, folder, then }) => ({ words, written, folder, then }))

/**
 * Whether any part of a shell command may write a file: a command that is not a plain
 * read, a redirect, or any substitution. A `cd` alone does not.
 */
export const shellMayWrite = (command: string): boolean =>
  shellParts(command).parts.some(({ written, readOnly }) => !readOnly || written.length > 0)

/** Flags whose next argument is a value, not a path or the pattern. */
const SEARCH_VALUE_FLAGS = new Set([
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-C',
  '--context',
  '-d',
  '--directories',
  '-D',
  '--devices',
  '-e',
  '--regexp',
  '-f',
  '--file',
  '-g',
  '--glob',
  '-j',
  '--threads',
  '-m',
  '--max-count',
  '-r',
  '--replace',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '--exclude',
  '--exclude-dir',
  '--exclude-from',
  '--include',
  '--max-depth',
  '--max-filesize',
])

const SEARCH_PATTERN_FLAGS = new Set(['-e', '--regexp'])

/** Splits enough shell syntax to identify command names and path arguments. */
function shellWords(value: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let escaped = false

  const push = () => {
    if (current.length === 0) return
    words.push(current)
    current = ''
  }

  for (const char of value) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) push()
    else current += char
  }
  push()
  return words
}

/** The operator that follows a shell segment; a newline counts as `;`, the last segment has none. */
type ShellJoin = ';' | '&&' | '||' | '|' | undefined

/** Splits command chains without treating separators inside quotes as commands. */
function shellSegments(value: string, joins?: ShellJoin[]): string[] {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let escaped = false

  const push = (join: ShellJoin) => {
    const segment = current.trim()
    // An operator then a line break continues the line, so the first operator stands.
    if (segment.length > 0) {
      segments.push(segment)
      joins?.push(join)
    }
    current = ''
  }

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? ''
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      current += char
      escaped = true
      continue
    }
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    const pair = `${char}${value[index + 1] ?? ''}`
    if (char === '\n' || char === ';' || char === '|' || pair === '&&') {
      push(pair === '&&' || pair === '||' ? pair : char === '|' ? '|' : ';')
      if (pair === '&&' || pair === '||') index += 1
      continue
    }
    current += char
  }
  push(undefined)
  return segments
}

const SHELL_OPERATORS = new Set(['|', '||', '&&', ';'])
const REDIRECT = /^(?:\d*|&)?(?:>>?|<<?|<>|>&|<&)/
const BARE_REDIRECT = /^(?:\d*|&)?(?:>>?|<<?|<>|>&|<&)$/

/** Removes shell grammar while retaining the ordinary arguments around it. */
export function commandArguments(words: readonly string[]): string[] {
  const args: string[] = []
  let redirectTarget = false
  for (const word of words) {
    if (redirectTarget) {
      redirectTarget = false
      continue
    }
    if (SHELL_OPERATORS.has(word)) continue
    if (REDIRECT.test(word)) {
      redirectTarget = BARE_REDIRECT.test(word)
      continue
    }
    args.push(word)
  }
  return args
}

function readableTargets(segment: string): string[] {
  const words = shellWords(segment)
  const commandAt = words.findIndex((word) => ['sed', 'cat', 'head', 'tail'].includes(commandName(word)))
  if (commandAt === -1) return []
  const command = commandName(words[commandAt] ?? '')
  const args = commandArguments(words.slice(commandAt + 1))
  const targets: string[] = []

  // A redirect is a write, not a read. `cat > file` is handled as an edit; treating
  // the path as a target here would show a Read for a file that was just created.
  if (command === 'cat' && args.some((argument) => argument === '>' || argument === '>>' || argument.startsWith('>'))) {
    return []
  }

  if (command === 'sed') {
    if (args.some((argument) => argument === '-i' || argument.startsWith('--in-place'))) return []
    let scriptSeen = false
    let expressionNext = false
    for (const argument of args) {
      if (expressionNext) {
        scriptSeen = true
        expressionNext = false
        continue
      }
      if (argument === '-e' || argument === '--expression') {
        expressionNext = true
        continue
      }
      if (argument.startsWith('-')) continue
      if (!scriptSeen) {
        scriptSeen = true
        continue
      }
      targets.push(argument)
    }
  } else {
    let optionValueNext = false
    for (const argument of args) {
      if (optionValueNext) {
        optionValueNext = false
        continue
      }
      if ((command === 'head' || command === 'tail') && ['-n', '-c', '--lines', '--bytes'].includes(argument)) {
        optionValueNext = true
        continue
      }
      if (argument.startsWith('-')) continue
      targets.push(argument)
    }
  }

  return targets.filter((target) => target !== '/dev/null')
}

function namedFiles(paths: readonly string[]): { detail: string; targets: string[] } {
  return {
    detail: paths.length === 1 ? paths[0]! : `${paths.length} files`,
    targets: [...paths],
  }
}

function describeSearch(body: string): { detail: string; subject?: string; targets?: string[] } {
  for (const segment of shellSegments(body)) {
    const words = shellWords(segment)
    const commandAt = words.findIndex((word) => SEARCH_COMMANDS.has(commandName(word)))
    if (commandAt === -1) continue
    const args = commandArguments(words.slice(commandAt + 1))
    let pattern: string | undefined
    let valueNext = false
    let patternNext = false
    const targets: string[] = []

    for (const argument of args) {
      if (patternNext) {
        pattern ??= argument
        patternNext = false
        valueNext = false
        continue
      }
      if (valueNext) {
        valueNext = false
        continue
      }
      if (SEARCH_PATTERN_FLAGS.has(argument)) {
        patternNext = true
        continue
      }
      if (SEARCH_VALUE_FLAGS.has(argument)) {
        valueNext = true
        continue
      }
      if (argument.startsWith('-')) continue
      if (pattern === undefined) {
        pattern = argument
        continue
      }
      targets.push(argument)
    }

    if (pattern !== undefined) return {
      ...(targets.length > 0 ? namedFiles(targets) : { detail: truncate(pattern) }),
      subject: searchSubject(pattern, targets),
    }
    if (targets.length > 0) return namedFiles(targets)
    return { detail: truncate(segment) }
  }
  return { detail: 'search' }
}

/**
 * Converts a shell-shaped tool into the user-shaped action Manor renders.
 * Codex emits every file action as a command; Claude's bypassPermissions path
 * rewrites Read/Edit through Bash. Same translation, so the transcript does
 * not depend on which CLI still has a native tool for the job.
 *
 * The raw command stays secondary while concrete targets become structured
 * data, so a long command cannot hide the files it opened or wrote.
 */
export function describeCommand(command: string, exists?: (path: string) => boolean, description?: string): CommandActivity {
  const activity = classifyCommand(command, exists)
  // A plain command keeps the caller's own one-line description (Claude's Bash, Cursor's
  // shell) as its label; the command itself stays on the step for the row's detail. A
  // command that resolved into a read, search or edit keeps that deterministic label.
  // Kept as written: whitespace is collapsed for display only after redaction.
  return activity.tool === 'Shell' && description !== undefined && description.trim().length > 0
    ? { ...activity, subject: description }
    : activity
}

function classifyCommand(command: string, exists?: (path: string) => boolean): CommandActivity {
  const trimmed = command.trim()
  const wrapper = /^\/bin\/(?:ba|z)?sh\s+-lc\s+(['"])([\s\S]*)\1$/.exec(trimmed)
  const body = wrapper?.[2] ?? trimmed
  // Stored exactly as sent: `redactToolActivity` redacts first, then clips. A trim
  // here could break the match on a secret that ends the command.
  const recorded = { command, detail: wrapper?.[2] ?? command }

  // Writes first: an apply_patch or `cat > file` mentions the path it touches,
  // which would otherwise read as a shell command that merely opened it.
  const patch = editsFromApplyPatch(body)
  const writes = patch ?? editsFromShellWrite(body, exists)
  if (writes !== undefined) {
    return {
      tool: 'Edit',
      ...namedFiles(writes.map((edit) => edit.path)),
      command: recorded.command,
      edits: writes,
    }
  }

  const segments = shellSegments(body)
  const reads = segments.map(readableTargets)
  const targets = [...new Set(reads.flat())]
  // A mixed script also runs its other commands. Do not describe it as only a read.
  if (targets.length > 0 && reads.every((paths) => paths.length > 0)) {
    return { tool: 'Read', ...namedFiles(targets), command: recorded.command }
  }
  if (targets.length > 0) return { tool: 'Shell', detail: recorded.detail, command: recorded.command }

  // A grep at the end of a test run or a script does not make the whole thing a
  // search; that label is only true when every part of it searches and nothing writes.
  const searchOnly = segments.every((segment) => {
    const words = shellWords(segment)
    const name = commandName(words.find((word) => !/^\w+=/.test(word)) ?? '')
    return (SEARCH_COMMANDS.has(name) || SEARCH_COMPANIONS.has(name)) && redirectTargets(segment).length === 0
  })
  if (!searchOnly) return { tool: 'Shell', detail: recorded.detail, command: recorded.command }

  const words = shellWords(body)
  if (words.some((word) => commandName(word) === 'rg') && words.includes('--files')) {
    return { tool: 'Search', detail: 'repository files', command: recorded.command }
  }

  if (words.some((word) => SEARCH_COMMANDS.has(commandName(word)))) {
    return { tool: 'Search', ...describeSearch(body), command: recorded.command }
  }

  return { tool: 'Shell', detail: recorded.detail, command: recorded.command }
}
