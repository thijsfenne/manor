import path from 'node:path'

/**
 * The files a shell command that exited successfully certainly wrote, for the project
 * thread guard, which undoes a write only on proof. It reads a small part of shell
 * grammar faithfully and declines everything else: an empty answer means "not proven",
 * never "nothing written", so a missed write is a known gap while a wrong answer would
 * erase the user's own edit.
 */

/** A word after quote removal; `exact` is false when expansion could change it. */
interface Word {
  text: string
  exact: boolean
}

type Token = { word: Word } | { op: string }

interface Simple {
  words: Word[]
  redirects: { op: string; target: Word }[]
}

/** Thrown inside the reader for syntax it does not follow; the command proves nothing. */
class Declined extends Error {}

const decline = (): never => {
  throw new Declined()
}

const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>'])
const REDIRECTS = new Set([...OUTPUT_REDIRECTS, '<', '<<', '<<-', '<<<', '<>', '<&', '>&'])

/**
 * Keywords, grouping and builtins (bash and zsh) that change which commands run, how
 * often, or where: with any of them the command proves nothing.
 */
const DECLINED_COMMANDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'foreach', 'while', 'until', 'repeat', 'do', 'done',
  'end', 'case', 'esac', 'select', 'function', 'always', 'time', 'coproc', '{', '}', '[[', ']]',
  '!', '-', 'exit', 'return', 'exec', 'set', 'setopt', 'unsetopt', 'emulate', 'eval', 'source',
  '.', 'trap', 'alias', 'disable', 'enable', 'shopt', 'command', 'builtin', 'noglob', 'nocorrect',
  'pushd', 'popd',
])

/**
 * A `..` after a symlink climbs out of the link's target, not out of the folder the
 * text names, so a path with one is no proof of which file it is.
 */
export const climbsParent = (file: string): boolean => file.split(/[\\/]/).includes('..')

/** A word that may assign or unset HOME, after which `~` and `$HOME` name other files. */
const TOUCHES_HOME = /HOME(?:\+?=|$)/

/** Splits a command into words and operators, or declines. */
function lex(command: string, home: string): Token[] {
  const tokens: Token[] = []
  const heredocs: { delimiter: string; strip: boolean }[] = []
  let awaitingDelimiter: boolean | undefined
  let text = ''
  let exact = true
  let started = false
  let tilde = false

  const push = () => {
    if (!started) return
    if (tilde) text = `${home}${text}`
    const word = { text, exact }
    if (awaitingDelimiter !== undefined) {
      heredocs.push({ delimiter: text, strip: awaitingDelimiter })
      awaitingDelimiter = undefined
    }
    tokens.push({ word })
    text = ''
    exact = true
    started = false
    tilde = false
  }
  const op = (value: string) => {
    push()
    if (awaitingDelimiter !== undefined) decline()
    if (value === '<<' || value === '<<-') awaitingDelimiter = value === '<<-'
    tokens.push({ op: value })
  }
  /**
   * `$HOME` or `${HOME}` opening a word expands; any other parameter makes the word
   * inexact. Returns the index of the last character it consumed.
   */
  const dollar = (at: number, quoted: boolean): number => {
    // A heredoc delimiter takes quote removal only, never expansion.
    if (awaitingDelimiter !== undefined) decline()
    const after = command.slice(at + 1)
    if (after.startsWith('(') || (!quoted && /^['"]/.test(after))) decline()
    const homeRef = /^(?:HOME(?!\w)|\{HOME\})/.exec(after)
    if (homeRef !== null && text === '' && !tilde) {
      text = home
      return at + homeRef[0].length
    }
    if (after.startsWith('{')) {
      const close = command.indexOf('}', at + 2)
      if (close < 0) decline()
      exact = false
      return close
    }
    const name = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(after)
    if (name === null) {
      text += '$'
      return at
    }
    exact = false
    return at + name[0].length
  }

  for (let at = 0; at < command.length; at += 1) {
    const char = command[at] ?? ''
    if (char === '\\') {
      const next = command[at + 1]
      at += 1
      if (next === undefined) decline()
      if (next === '\n') continue
      text += next
      started = true
      continue
    }
    if (char === "'") {
      const close = command.indexOf("'", at + 1)
      if (close < 0) decline()
      text += command.slice(at + 1, close)
      started = true
      at = close
      continue
    }
    if (char === '"') {
      started = true
      let closed = false
      for (at += 1; at < command.length; at += 1) {
        const inner = command[at] ?? ''
        if (inner === '"') {
          closed = true
          break
        }
        if (inner === '`') decline()
        if (inner === '$') {
          at = dollar(at, true)
          continue
        }
        if (inner === '\\' && /[$`"\\\n]/.test(command[at + 1] ?? '')) {
          at += 1
          if (command[at] !== '\n') text += command[at]
          continue
        }
        text += inner
      }
      if (!closed) decline()
      continue
    }
    if (char === '`') decline()
    if (char === '$') {
      started = true
      at = dollar(at, false)
      continue
    }
    if (char === '#' && !started) {
      while (at + 1 < command.length && command[at + 1] !== '\n') at += 1
      continue
    }
    if (char === ' ' || char === '\t') {
      push()
      continue
    }
    if (char === '\n') {
      op('\n')
      // Heredoc bodies are input, never commands.
      for (const { delimiter, strip } of heredocs.splice(0)) {
        let end = command.indexOf('\n', at + 1)
        for (;;) {
          const line = command.slice(at + 1, end < 0 ? undefined : end)
          at = end < 0 ? command.length : end
          if ((strip ? line.replace(/^\t+/, '') : line) === delimiter || end < 0) break
          end = command.indexOf('\n', at + 1)
        }
      }
      continue
    }
    const rest = command.slice(at)
    if (char === '<' || char === '>') {
      if (/^[<>]\(/.test(rest)) decline()
      // A number right before a redirect names a descriptor, not an argument.
      if (started && /^\d+$/.test(text) && exact && !tilde) {
        text = ''
        started = false
      }
      const value = /^(?:<<<|<<-|<<|<>|<&|<|>>|>\||>&|>)/.exec(rest)![0]
      op(value)
      at += value.length - 1
      continue
    }
    if (char === '&' || char === '|' || char === ';' || char === '(' || char === ')') {
      const value = /^(?:&>>|&>|&&|&|\|\||\|&|\||;;|;|\(|\))/.exec(rest)![0]
      if (value === '&' || value === ';;' || value === '(' || value === ')') decline()
      op(value)
      at += value.length - 1
      continue
    }
    // A leading `~` expands only when an unquoted `/` or the word's end follows it.
    if (char === '~' && !started) {
      if (awaitingDelimiter !== undefined) decline()
      started = true
      if (/^(?:$|[/\s;&|<>])/.test(command.slice(at + 1))) tilde = true
      else {
        text += char
        exact = false
      }
      continue
    }
    // Globs and brace expansion may name other files.
    if ('*?[{}'.includes(char)) exact = false
    text += char
    started = true
  }
  push()
  if (awaitingDelimiter !== undefined) decline()
  return tokens
}

/** And-or lists, each a run of pipelines joined by `&&` or `||`. */
function parse(tokens: readonly Token[]): { pipelines: Simple[][]; joins: string[] }[] {
  const lists: { pipelines: Simple[][]; joins: string[] }[] = []
  let list: { pipelines: Simple[][]; joins: string[] } = { pipelines: [], joins: [] }
  let pipeline: Simple[] = []
  let simple: Simple = { words: [], redirects: [] }
  const endSimple = () => {
    if (simple.words.length > 0 || simple.redirects.length > 0) pipeline.push(simple)
    else if (pipeline.length > 0) decline()
    simple = { words: [], redirects: [] }
  }
  const endPipeline = () => {
    endSimple()
    if (pipeline.length > 0) list.pipelines.push(pipeline)
    pipeline = []
  }
  const endList = () => {
    endPipeline()
    if (list.joins.length >= list.pipelines.length && list.joins.length > 0) decline()
    if (list.pipelines.length > 0) lists.push(list)
    list = { pipelines: [], joins: [] }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if ('word' in token) {
      simple.words.push(token.word)
      continue
    }
    if (REDIRECTS.has(token.op)) {
      const target = tokens[index + 1]
      if (target === undefined || !('word' in target)) decline()
      simple.redirects.push({ op: token.op, target: (target as { word: Word }).word })
      index += 1
      continue
    }
    if (token.op === '|' || token.op === '|&') {
      if (simple.words.length === 0 && simple.redirects.length === 0) decline()
      endSimple()
      continue
    }
    if (token.op === '&&' || token.op === '||') {
      endPipeline()
      if (list.pipelines.length === 0) decline()
      list.joins.push(token.op)
      continue
    }
    endList()
  }
  endList()
  return lists
}

/** The command's own words, after leading `NAME=value` assignments. */
const commandWords = (simple: Simple): Word[] => {
  const first = simple.words.findIndex((word) => !/^[A-Za-z_]\w*=/.test(word.text))
  return first < 0 ? [] : simple.words.slice(first)
}

/** The files `tee` opens for writing; an option it does not know or an inexact word proves nothing. */
function teeTargets(args: readonly Word[]): Word[] {
  if (args.some((arg) => !arg.exact)) return []
  const targets: Word[] = []
  let options = true
  for (const arg of args) {
    if (options && arg.text === '--') options = false
    else if (options && arg.text.startsWith('-') && arg.text !== '-') {
      if (!/^(?:-[aip]+|--append|--ignore-interrupts)$/.test(arg.text)) return []
    } else targets.push(arg)
  }
  return targets
}

/**
 * The script inside `/bin/zsh -lc <script>` and its bash and sh twins, unquoted the way
 * the shell would, or the command itself.
 */
function script(command: string, home: string): string {
  const words = lex(command, home)
  if (words.length !== 3 || !words.every((token) => 'word' in token && token.word.exact)) return command
  const [shell, flag, body] = words.map((token) => (token as { word: Word }).word.text)
  return /^\/bin\/(?:ba|z)?sh$/.test(shell!) && flag === '-lc' ? body! : command
}

/**
 * Files a shell command that exited successfully certainly wrote, as absolute paths:
 * the targets of output redirects and of `tee`, on a simple command whose own success
 * the exit status proves. A failed redirect fails its command, so a command that
 * succeeded opened every file it redirects to. Exit status 0 proves only the last
 * and-or list, and only when `&&` joins it: each of its pipelines then succeeded, and a
 * pipeline's status is its last command's. Earlier stages and earlier lists may have
 * failed. A relative path counts only in the command right after a `cd` to an absolute
 * folder proven the same way, since the folder a call starts in is not known. A path
 * with `..` never counts. Anything the reader does not follow returns nothing.
 */
export function shellWriteDestinations(command: string, home: string): string[] {
  let lists: ReturnType<typeof parse>
  try {
    const tokens = lex(script(command.trim(), home), home)
    if (tokens.some((token) => 'word' in token && TOUCHES_HOME.test(token.word.text))) return []
    lists = parse(tokens)
  } catch (error) {
    if (error instanceof Declined) return []
    throw error
  }
  const simples = lists.flatMap((list) => list.pipelines.flat())
  if (simples.some((simple) => {
    const name = commandWords(simple)[0]
    return name !== undefined && (!name.exact || DECLINED_COMMANDS.has(name.text))
  })) return []

  const destinations: string[] = []
  let folder: string | undefined
  const resolve = (word: Word): string | undefined => {
    if (!word.exact || word.text === '' || climbsParent(word.text)) return undefined
    if (path.isAbsolute(word.text)) return path.resolve(word.text)
    return folder === undefined ? undefined : path.resolve(folder, word.text)
  }
  lists.forEach((list, listIndex) => {
    const proven = listIndex === lists.length - 1 && list.joins.every((join) => join === '&&')
    for (const pipeline of list.pipelines) {
      pipeline.forEach((simple, stage) => {
        const succeeded = proven && stage === pipeline.length - 1
        const [name, ...args] = commandWords(simple)
        if (succeeded) {
          const targets = [
            ...simple.redirects.filter(({ op }) => OUTPUT_REDIRECTS.has(op)).map(({ target }) => target),
            ...(name?.text === 'tee' ? teeTargets(args) : []),
          ]
          for (const target of targets) {
            const absolute = resolve(target)
            if (absolute !== undefined) destinations.push(absolute)
          }
        }
        // Only a `cd` proven to succeed, on its own, to a folder named in full moves us,
        // and only for the command right after it: any other command may be `chdir`, or
        // a function that changes folder.
        const operands = args.filter((arg) => !/^-[LPe@]+$/.test(arg.text) && arg.text !== '--')
        const target = operands.length === 0 ? { text: home, exact: true } : operands[0]!
        folder = name?.text === 'cd' && succeeded && pipeline.length === 1 && operands.length <= 1 && target.exact &&
          path.isAbsolute(target.text) && !climbsParent(target.text)
          ? path.resolve(target.text) : undefined
      })
    }
  })
  return destinations
}
