/**
 * What a shell command did, in words someone who never opened a terminal can read:
 * "Used the database" instead of `sqlite3 -readonly $DB "select …"`. Worked out
 * here from the stored command, so it costs no tokens and reads the same for every
 * provider and for older transcripts. A command it does not recognise gets no plain
 * label; the row then shows the cleaned command itself, and the exact command always
 * stays one click down.
 */

type Words = readonly [running: string, done: string]

/** One command of a chain and the operator that led to it. */
interface CommandPart {
  text: string
  after: 'start' | 'and' | 'or' | 'then' | 'pipe'
}

/**
 * Splits at `&&`, `||`, `;`, `|`, `&` and newlines outside quotes. A heredoc body is
 * the input of its command, not a command of its own, so it is skipped. Syntax this
 * reading does not model returns undefined: a comment, a process substitution, or
 * output sent anywhere but the terminal or `/dev/null`.
 */
function commandParts(command: string): CommandPart[] | undefined {
  const parts: CommandPart[] = []
  let current = ''
  let after: CommandPart['after'] = 'start'
  let quote: string | undefined
  let heredoc: string | undefined
  const push = (next: CommandPart['after']) => {
    const text = current.trim()
    current = ''
    if (text.length > 0) {
      parts.push({ text, after })
      after = next
    } else if (after === 'then' || after === 'start') {
      // A line break after `||` or `|` continues that operator; it does not reset it.
      after = next
    }
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    const next = command[index + 1]
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      else if (char === '\\' && quote === '"' && next !== undefined) {
        current += next
        index++
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === '\\') {
      current += next === '\n' ? ' ' : `${char}${next ?? ''}`
      index++
      continue
    }
    if (char === '#' && /^$|\s$/.test(current)) return undefined
    if ((char === '<' || char === '>') && next === '(') return undefined
    if (char === '>') {
      const harmless = /^>>?\s*(?:&[12-]|\/dev\/null(?![^\s;|&)]))/.exec(command.slice(index))
      if (harmless === null) return undefined
      current += harmless[0].replace(/\s+/g, '')
      index += harmless[0].length - 1
      continue
    }
    if (char === '<' && next === '<' && command[index + 2] === '<') {
      // A here-string feeds one word to its command; it opens no body.
      current += '<<<'
      index += 2
      continue
    }
    if (char === '<' && next === '<') {
      const opened = /^<<-?\s*(['"]?)([\w.-]+)\1(?=[\s;|&)]|$)/.exec(command.slice(index))
      // A delimiter built from more than plain characters may end somewhere else.
      if (opened === null) return undefined
      heredoc = opened[2]
      current += opened[0]
      index += opened[0].length - 1
      continue
    }
    if (char === '\n') {
      push('then')
      if (heredoc !== undefined) {
        const lines = command.slice(index + 1).split('\n')
        const end = lines.findIndex((line) => line.trim() === heredoc)
        const skipped = end < 0 ? lines : lines.slice(0, end + 1)
        index += skipped.reduce((length, line) => length + line.length + 1, 0)
        heredoc = undefined
      }
      continue
    }
    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      push(char === '&' ? 'and' : 'or')
      index++
      continue
    }
    if (char === ';') {
      push('then')
      continue
    }
    if (char === '|') {
      push('pipe')
      continue
    }
    // `2>&1` and `&>file` redirect output; a lone `&` sends the command to the background.
    if (char === '&' && !/[<>]/.test(current.at(-1) ?? '') && next !== '>') {
      push('then')
      continue
    }
    current += char
  }
  push('then')
  return parts
}

/** Shell words without their quotes, enough to find a program and its arguments. */
function shellWords(text: string): string[] {
  const words: string[] = []
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
  for (const match of text.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3] ?? '')
  return words
}

const baseName = (path: string): string => path.split('/').filter((part) => part.length > 0).at(-1) ?? path

/** Commands that only prepare the next one; they never name what a chain did. */
const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'unset', 'true', ':', 'setopt', 'ulimit'])
/** What may receive another command's output without doing anything of its own. */
const FILTERS = new Set(['tail', 'head', 'grep', 'rg', 'wc', 'cut', 'tr', 'jq', 'less', 'cat', 'column', 'nl', 'fold'])
/** Commands that matter only when nothing else ran. */
const QUIET: Readonly<Record<string, Words>> = {
  sleep: ['Waiting', 'Waited'],
  echo: ['Printing a message', 'Printed a message'],
  printf: ['Printing a message', 'Printed a message'],
}
const PREFIXES = new Set(['sudo', 'time', 'nohup', 'env', 'exec', 'command', 'caffeinate', 'timeout', 'gtimeout'])

const RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun'])
const DIRECT_RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
const RUNNER_OPTIONS_WITH_VALUE = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--cwd', '-w', '--workspace'])
const INTERPRETERS = new Set(['node', 'python', 'python3', 'tsx', 'ts-node', 'deno', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'php', 'swift'])

const GIT: Readonly<Record<string, Words>> = {
  status: ['Checking for changes', 'Checked for changes'],
  diff: ['Reviewing the changes', 'Reviewed the changes'],
  show: ['Reviewing a commit', 'Reviewed a commit'],
  log: ['Reading the history', 'Read the history'],
  blame: ['Reading the history', 'Read the history'],
  add: ['Staging changes', 'Staged changes'],
  commit: ['Saving a commit', 'Saved a commit'],
  push: ['Pushing changes', 'Pushed changes'],
  pull: ['Pulling in updates', 'Pulled in updates'],
  fetch: ['Fetching updates', 'Fetched updates'],
  switch: ['Switching branch', 'Switched branch'],
  merge: ['Merging changes', 'Merged changes'],
  rebase: ['Rebasing changes', 'Rebased changes'],
  'cherry-pick': ['Copying a commit', 'Copied a commit'],
  restore: ['Undoing changes', 'Undid changes'],
  reset: ['Undoing changes', 'Undid changes'],
  clone: ['Downloading a repository', 'Downloaded a repository'],
  worktree: ['Managing worktrees', 'Managed worktrees'],
}

const PROGRAMS: Readonly<Record<string, Words>> = {
  jest: ['Running tests', 'Ran tests'],
  pytest: ['Running tests', 'Ran tests'],
  psql: ['Using the database', 'Used the database'],
  mysql: ['Using the database', 'Used the database'],
  sqlite3: ['Using the database', 'Used the database'],
  duckdb: ['Using the database', 'Used the database'],
  supabase: ['Using Supabase', 'Used Supabase'],
  ls: ['Listing files', 'Listed files'],
  tree: ['Listing files', 'Listed files'],
  du: ['Checking disk space', 'Checked disk space'],
  df: ['Checking disk space', 'Checked disk space'],
  stat: ['Checking a file', 'Checked a file'],
  file: ['Checking a file', 'Checked a file'],
  mkdir: ['Creating a folder', 'Created a folder'],
  touch: ['Creating a file', 'Created a file'],
  rm: ['Deleting files', 'Deleted files'],
  rmdir: ['Deleting a folder', 'Deleted a folder'],
  trash: ['Deleting files', 'Deleted files'],
  mv: ['Moving files', 'Moved files'],
  cp: ['Copying files', 'Copied files'],
  ln: ['Linking files', 'Linked files'],
  chmod: ['Changing permissions', 'Changed permissions'],
  chown: ['Changing permissions', 'Changed permissions'],
  unzip: ['Unpacking files', 'Unpacked files'],
  cat: ['Reading a file', 'Read a file'],
  head: ['Reading a file', 'Read a file'],
  tail: ['Reading a file', 'Read a file'],
  less: ['Reading a file', 'Read a file'],
  wc: ['Counting lines', 'Counted lines'],
  sort: ['Sorting text', 'Sorted text'],
  jq: ['Reading JSON', 'Read JSON'],
  diff: ['Comparing files', 'Compared files'],
  cmp: ['Comparing files', 'Compared files'],
  grep: ['Searching the files', 'Searched the files'],
  ag: ['Searching the files', 'Searched the files'],
  ps: ['Checking running processes', 'Checked running processes'],
  pgrep: ['Checking running processes', 'Checked running processes'],
  lsof: ['Checking running processes', 'Checked running processes'],
  top: ['Checking running processes', 'Checked running processes'],
  pkill: ['Stopping a process', 'Stopped a process'],
  killall: ['Stopping a process', 'Stopped a process'],
  which: ['Checking a tool is installed', 'Checked a tool is installed'],
  whereis: ['Checking a tool is installed', 'Checked a tool is installed'],
  type: ['Checking a tool is installed', 'Checked a tool is installed'],
  pwd: ['Checking the folder', 'Checked the folder'],
  date: ['Checking the time', 'Checked the time'],
  whoami: ['Checking the user', 'Checked the user'],
  uname: ['Checking the system', 'Checked the system'],
  sw_vers: ['Checking the system', 'Checked the system'],
  printenv: ['Checking settings', 'Checked settings'],
  defaults: ['Using Mac settings', 'Used Mac settings'],
  launchctl: ['Managing a background service', 'Managed a background service'],
  osascript: ['Controlling an app', 'Controlled an app'],
  open: ['Opening', 'Opened'],
  gh: ['Using GitHub', 'Used GitHub'],
  docker: ['Using Docker', 'Used Docker'],
  brew: ['Using Homebrew', 'Used Homebrew'],
  xcodebuild: ['Building the app', 'Built the app'],
  xcrun: ['Using Xcode tools', 'Used Xcode tools'],
  expo: ['Using Expo', 'Used Expo'],
  eas: ['Using Expo', 'Used Expo'],
  ffmpeg: ['Converting media', 'Converted media'],
  sips: ['Converting an image', 'Converted an image'],
  pbcopy: ['Copying to the clipboard', 'Copied to the clipboard'],
  pbpaste: ['Reading the clipboard', 'Read the clipboard'],
  ssh: ['Connecting to a server', 'Connected to a server'],
  scp: ['Copying to a server', 'Copied to a server'],
}

/** Package scripts by the start of their name: `test:unit` is still tests. */
const SCRIPTS: readonly (readonly [RegExp, Words])[] = [
  [/^test(?::|$)/, ['Running tests', 'Ran tests']],
  [/^(?:typecheck|check-types)(?::|$)/, ['Typechecking', 'Ran typecheck']],
  [/^lint(?::|$)/, ['Linting', 'Ran lint']],
  [/^(?:format|fmt)(?::|$)/, ['Formatting code', 'Formatted code']],
  [/^build(?::|$)/, ['Building the app', 'Built the app']],
  [/^(?:dev|start|serve|preview)(?::|$)/, ['Starting the app', 'Started the app']],
]

const INSTALL = new Set(['install', 'i', 'add', 'ci', 'update', 'up', 'upgrade'])
const UNINSTALL = new Set(['remove', 'rm', 'uninstall', 'un'])

/** Tools where a lone `-v` or `-V` asks for the version; for `ls` it sorts, for `bash` it echoes. */
const SHORT_VERSION = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'tsc', 'vite', 'vitest', 'eslint', 'prettier', 'ruby', 'perl', 'php'])

/** Asking a tool about itself runs nothing. `-h` means human-readable sizes as often as help. */
function selfQuery(program: string, args: readonly string[]): Words | undefined {
  const [flag] = args
  if (flag === '--version' || (args.length === 1 && (flag === '-v' || flag === '-V') && SHORT_VERSION.has(program))) {
    return [`Checking the ${program} version`, `Checked the ${program} version`]
  }
  if (flag === '--help') return [`Reading the ${program} help`, `Read the ${program} help`]
  return undefined
}

function scriptWords(script: string): Words {
  const known = SCRIPTS.find(([pattern]) => pattern.test(script))
  return known?.[1] ?? [`Running the ${script} script`, `Ran the ${script} script`]
}

/** Flags that make curl or wget send rather than fetch, in any spelling. */
const SENDS = /^(?:-[a-zA-Z]*[XdFTK]|--(?:request|data|form|json|upload-file|post|method|body|config))/

/** A plain download, named by its host. Anything that may send data is not read this way. */
function fetchWords(args: readonly string[]): Words | undefined {
  if (args.some((word) => SENDS.test(word))) return undefined
  const url = args.find((word) => /^https?:\/\//.test(word))
  let host: string | undefined
  try {
    host = url === undefined ? undefined : new URL(url).host
  } catch {
    host = undefined
  }
  return host === undefined ? ['Fetching from the web', 'Fetched from the web'] : [`Fetching from ${host}`, `Fetched from ${host}`]
}

/** `sed -n '1,80p' file`: a script that only prints lines. Any other script may write. */
function sedReads(args: readonly string[]): boolean {
  const scripts: string[] = []
  let quiet = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === '-n') quiet = true
    else if (word === '-e') scripts.push(args[++index] ?? '')
    else if (word === '-E' || word === '-r') continue
    else if (word.startsWith('-')) return false
    else if (scripts.length === 0) scripts.push(word)
  }
  const line = String.raw`(?:\d+|\$|/[^/]*/)`
  const print = new RegExp(`^(?:${line}(?:,${line})?p;?)+$`)
  return quiet && scripts.length > 0 && scripts.every((script) => print.test(script))
}

const GIT_BRANCH_LIST = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--list', '--show-current', '--merged', '--no-merged'])

/** Git subcommands whose meaning turns on their flags. */
function gitWords(sub: string, rest: readonly string[]): Words | undefined {
  if (sub === 'checkout') {
    // A bare `git checkout x` may switch a branch or throw away a file's changes.
    return rest.includes('-b') || rest.includes('-B') ? ['Creating a branch', 'Created a branch'] : undefined
  }
  if (sub === 'branch') {
    if (rest.some((word) => word === '-d' || word === '-D' || word === '--delete')) return ['Deleting a branch', 'Deleted a branch']
    return rest.every((word) => GIT_BRANCH_LIST.has(word)) ? ['Checking branches', 'Checked branches'] : undefined
  }
  if (sub === 'stash') {
    const [action] = rest
    if (action === 'pop' || action === 'apply') return ['Restoring set-aside changes', 'Restored set-aside changes']
    if (action === 'list' || action === 'show') return ['Checking set-aside changes', 'Checked set-aside changes']
    return action === undefined || action === 'push' || action.startsWith('-') ? ['Setting changes aside', 'Set changes aside'] : undefined
  }
  return GIT[sub] ?? ['Using git', 'Used git']
}

/** Programs whose flags decide between reading and writing, read by `flaggedWords`. */
const FLAGGED = new Set(['eslint', 'rsync', 'zip', 'tsc', 'sed', 'find', 'fd', 'rg', 'vitest', 'playwright', 'kill', 'tar', 'vite', 'prettier', 'curl', 'wget'])

function flaggedWords(program: string, args: readonly string[]): Words | undefined {
  switch (program) {
    case 'sed':
      return sedReads(args) ? ['Reading a file', 'Read a file'] : undefined
    case 'find':
      return args.some((word) => /^-(?:delete|exec|execdir|ok|okdir|fprint.*|fls)$/.test(word)) ? undefined : ['Finding files', 'Found files']
    case 'rg':
      // `--pre` runs a program on every file it searches.
      return args.some((word) => word.startsWith('--pre')) ? undefined : ['Searching the files', 'Searched the files']
    case 'fd':
      return args.some((word) => /^(?:-[xX]|--exec)/.test(word)) ? undefined : ['Finding files', 'Found files']
    case 'rsync':
      return args.some((word) => word.startsWith('--delete') || word === '--remove-source-files') ? undefined : ['Copying files', 'Copied files']
    case 'zip':
      // `d` deletes entries from the archive, `m` deletes the originals once packed.
      return args.some((word) => /^-[a-zA-Z]*[dm]/.test(word) || word === '--delete' || word === '--move') ? undefined : ['Packing files', 'Packed files']
    case 'eslint':
      if (args.includes('--init')) return undefined
      return args.some((word) => word.startsWith('--fix')) ? ['Fixing lint issues', 'Fixed lint issues'] : ['Linting', 'Ran lint']
    case 'tsc': {
      // Without --noEmit tsc may write JavaScript, depending on a config this cannot see.
      const flag = args.indexOf('--noEmit')
      return flag >= 0 && args[flag + 1] !== 'false' ? ['Typechecking', 'Ran typecheck'] : undefined
    }
    case 'vitest':
      return args.some((word) => word === 'list' || word === 'bench' || word === 'init') ? undefined : ['Running tests', 'Ran tests']
    case 'playwright':
      return args[0] === 'test' ? ['Running browser tests', 'Ran browser tests'] : undefined
    case 'kill':
      return args.some((word) => word === '-0' || word === '-l' || word === '-s') ? undefined : ['Stopping a process', 'Stopped a process']
    case 'tar': {
      const mode = args.find((word) => !word.includes('/'))?.replace(/^-/, '') ?? ''
      if (/^[a-zA-Z]*x/.test(mode)) return ['Unpacking files', 'Unpacked files']
      if (/^[a-zA-Z]*c/.test(mode)) return ['Packing files', 'Packed files']
      return undefined
    }
    case 'vite':
      if (args[0] === 'build') return ['Building the app', 'Built the app']
      return args[0] === undefined || args[0] === 'dev' || args[0] === 'serve' || args[0] === 'preview' ? ['Starting the app', 'Started the app'] : undefined
    case 'prettier':
      return args.some((word) => word === '--write' || word === '-w') ? ['Formatting code', 'Formatted code'] : ['Checking the formatting', 'Checked the formatting']
    default:
      return undefined
  }
}

type PartWords = Words | 'setup' | { quiet: Words } | undefined

function partWords(text: string): PartWords {
  // Redirects reaching here go to the terminal or /dev/null; commandParts refused the rest.
  let words = shellWords(text).filter((word) => !/^(?:\d|&)?[<>]/.test(word))
  while (words[0] !== undefined && (/^[A-Za-z_]\w*=/.test(words[0]) || PREFIXES.has(baseName(words[0])))) words = words.slice(1)
  const first = words[0]
  if (first === undefined) return 'setup'
  const program = baseName(first)
  const args = words.slice(1)
  if (SETUP.has(program)) return 'setup'
  const quiet = QUIET[program]
  if (quiet !== undefined) return { quiet }
  if (program === 'git') {
    if (args[0] === '--version') return selfQuery(program, args)
    let rest = args
    // `-c` can point git at programs to run; only `-C <folder>` is read past.
    while (rest[0] === '-C') rest = rest.slice(2)
    const sub = rest[0]
    // `--ext-diff` and `--textconv` run a configured helper; `--output` writes a file.
    if (sub === undefined || sub.startsWith('-') || rest.some((word) => word === '--ext-diff' || word === '--textconv' || word.startsWith('--output'))) return undefined
    return gitWords(sub, rest.slice(1))
  }
  if (RUNNERS.has(program) || DIRECT_RUNNERS.has(program)) {
    let rest = args
    for (;;) {
      const word = rest[0]
      if (word === undefined || !word.startsWith('-')) break
      rest = rest.slice(RUNNER_OPTIONS_WITH_VALUE.has(word) ? 2 : 1)
    }
    const verb = rest[0]
    if (verb === undefined) return selfQuery(program, args)
    if (DIRECT_RUNNERS.has(program) || verb === 'exec' || verb === 'dlx' || verb === 'x') {
      const inner = DIRECT_RUNNERS.has(program) ? rest : rest.slice(1)
      return inner.length === 0 ? undefined : partWords(inner.join(' '))
    }
    // `pnpm tsc` runs the tool itself, so its flags decide.
    if (PROGRAMS[verb] !== undefined || FLAGGED.has(verb)) return partWords(rest.join(' '))
    if (INSTALL.has(verb)) return ['Installing packages', 'Installed packages']
    if (UNINSTALL.has(verb)) return ['Removing packages', 'Removed packages']
    if (verb === 'run' || verb === 'run-script') return rest[1] === undefined ? undefined : scriptWords(rest[1])
    if (program === 'bun' && /\.[cm]?[jt]sx?$/.test(verb)) return [`Running ${baseName(verb)}`, `Ran ${baseName(verb)}`]
    return scriptWords(verb)
  }
  // After the runners: `pnpm exec tsc --version` asks tsc, not pnpm. A script of its
  // own may ignore `--help` and simply run, so only known tools are asked this way.
  const known = PROGRAMS[program] !== undefined || FLAGGED.has(program) || SHORT_VERSION.has(program) || INTERPRETERS.has(program)
  const self = known && !first.includes('/') ? selfQuery(program, args) : undefined
  if (self !== undefined) return self
  if (INTERPRETERS.has(program)) {
    if (args.some((word) => word === '-e' || word === '-c' || word === '-' || word.startsWith('<<'))) return ['Running a script', 'Ran a script']
    if (program === 'python' || program === 'python3') {
      const module = args[args.indexOf('-m') + 1]
      if (args.includes('-m') && module !== undefined) return partWords([module, ...args.slice(args.indexOf('-m') + 2)].join(' '))
    }
    const script = args.find((word) => !word.startsWith('-'))
    return script === undefined ? ['Running a script', 'Ran a script'] : [`Running ${baseName(script)}`, `Ran ${baseName(script)}`]
  }
  if (program === 'curl' || program === 'wget') return fetchWords(args)
  if (program === 'open') {
    const target = args.find((word) => !word.startsWith('-'))
    return target === undefined ? ['Opening an app', 'Opened an app'] : [`Opening ${baseName(target)}`, `Opened ${baseName(target)}`]
  }
  if (program.endsWith('.sh') || first.startsWith('./')) return [`Running ${program}`, `Ran ${program}`]
  return PROGRAMS[program] ?? flaggedWords(program, args)
}

/** Output plumbing (`| tail -30`, `| grep fail`) belongs to the command before it. */
function isFilter(text: string): boolean {
  const [first, ...args] = shellWords(text)
  return first !== undefined && FILTERS.has(baseName(first)) && !args.some((word) => word.startsWith('--pre'))
}

const lowerFirst = (text: string): string => `${text[0]!.toLowerCase()}${text.slice(1)}`

/** Up to three plain steps read as one sentence; more than that are counted. */
function sentence(steps: readonly string[]): string {
  if (steps.length === 1) return steps[0]!
  const [head, ...rest] = steps
  if (steps.length > 3) return `${head}, ${lowerFirst(rest[0]!)} and ${steps.length - 2} more steps`
  return `${head}${rest.slice(0, -1).map((step) => `, ${lowerFirst(step)}`).join('')} and ${lowerFirst(rest.at(-1)!)}`
}

/**
 * The plain words for a command, or undefined when any part of it is unknown: a label
 * that names half of what ran would be worse than the command itself. A command the
 * driver clipped may have lost a part, so it gets none either.
 */
export function plainCommand(command: string, running: boolean): string | undefined {
  if (command.endsWith('…') || command.endsWith('...')) return undefined
  // A substitution runs a command inside another one's words.
  if (/\$\(|`/.test(command)) return undefined
  const parts = commandParts(command)
  if (parts === undefined) return undefined
  const steps: string[] = []
  let quiet: Words | undefined
  for (const part of parts) {
    if (part.after === 'pipe') {
      if (isFilter(part.text)) continue
      return undefined
    }
    const words = partWords(part.text)
    if (words === 'setup') continue
    if (words === undefined) return undefined
    // After `||` a step may never run; only a harmless fallback (`|| true`) reads as nothing.
    if (part.after === 'or' && Array.isArray(words)) return undefined
    if (!Array.isArray(words)) {
      quiet ??= (words as { quiet: Words }).quiet
      continue
    }
    const said = (words as Words)[running ? 0 : 1]
    if (!steps.includes(said)) steps.push(said)
  }
  if (steps.length === 0) return quiet?.[running ? 0 : 1]
  return sentence(steps)
}
