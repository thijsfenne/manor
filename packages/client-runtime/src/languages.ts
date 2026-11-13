/**
 * Which grammar colours a file, by its path. The one map every code view reads: the
 * desktop Files panel and the Session diff (CodeMirror grammars) and the phone's file
 * preview (its own small colourer), so a file never highlights in one view and reads
 * plain in the next.
 *
 * A near relative is not a grammar: `.jsonc`, `.scss`, `.vue` and `.svelte` stay plain
 * rather than half-parse under JSON, CSS or HTML and colour the rest wrongly.
 */

export type SourceLanguage =
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'css'
  | 'dart'
  | 'dockerfile'
  | 'go'
  | 'html'
  | 'java'
  | 'javascript'
  | 'json'
  | 'jsx'
  | 'kotlin'
  | 'markdown'
  | 'powershell'
  | 'properties'
  | 'python'
  | 'ruby'
  | 'rust'
  | 'shell'
  | 'sql'
  | 'swift'
  | 'toml'
  | 'tsx'
  | 'typescript'
  | 'xml'
  | 'yaml'

const BY_EXTENSION: Record<string, SourceLanguage> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  json: 'json', webmanifest: 'json',
  css: 'css',
  html: 'html', htm: 'html',
  xml: 'xml', svg: 'xml', plist: 'xml', xib: 'xml', storyboard: 'xml', entitlements: 'xml', csproj: 'xml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', pyi: 'python',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'properties', cfg: 'properties', conf: 'properties', properties: 'properties', env: 'properties',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell',
  c: 'c', h: 'c', m: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'cpp', hpp: 'cpp', mm: 'cpp',
  cs: 'csharp',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  dart: 'dart',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  swift: 'swift',
}

/** Whole names that say more than their extension, or have none. Lockfiles read as the format they are written in. */
const BY_NAME: Record<string, SourceLanguage> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'shell', gnumakefile: 'shell',
  '.bashrc': 'shell', '.bash_profile': 'shell', '.profile': 'shell', '.zshrc': 'shell', '.zprofile': 'shell', '.zshenv': 'shell',
  '.gitignore': 'shell', '.dockerignore': 'shell', '.npmignore': 'shell', '.prettierignore': 'shell', '.eslintignore': 'shell',
  '.npmrc': 'properties', '.editorconfig': 'properties', '.gitconfig': 'properties', '.gitattributes': 'properties', '.env': 'properties',
  gemfile: 'ruby', rakefile: 'ruby', podfile: 'ruby', brewfile: 'ruby', fastfile: 'ruby',
  'cargo.lock': 'toml', 'poetry.lock': 'toml', 'uv.lock': 'toml', 'pdm.lock': 'toml',
  'flake.lock': 'json', 'deno.lock': 'json', 'composer.lock': 'json', 'package.resolved': 'json',
  'pnpm-lock.yaml': 'yaml', 'yarn.lock': 'yaml',
  'package.swift': 'swift',
}

/** What a `#!` first line names, for a script with no extension. */
const BY_INTERPRETER: Record<string, SourceLanguage> = {
  sh: 'shell', bash: 'shell', zsh: 'shell', dash: 'shell', ksh: 'shell', fish: 'shell',
  node: 'javascript', deno: 'typescript', bun: 'typescript', tsx: 'typescript', 'ts-node': 'typescript',
  python: 'python', python3: 'python', ruby: 'ruby', swift: 'swift', pwsh: 'powershell',
}

/**
 * The grammar for a path, `null` when no grammar fits and the text reads plain.
 * `firstLine` is the file's own first line where the caller has it, so an
 * extensionless script still colours by its `#!`.
 */
export function sourceLanguage(path: string, firstLine?: string): SourceLanguage | null {
  const name = (path.split(/[\\/]/).at(-1) ?? path).toLowerCase()
  // Own keys only: a file named `constructor` must not find Object's.
  const named = Object.hasOwn(BY_NAME, name) ? BY_NAME[name] : undefined
  if (named !== undefined) return named
  // `.env.local`, `.env.example`, `Dockerfile.dev`: the family is the first part.
  if (name.startsWith('.env.')) return 'properties'
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile'
  const dot = name.lastIndexOf('.')
  const extension = name.slice(dot + 1)
  const byExtension = dot > 0 && Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension] : undefined
  if (byExtension !== undefined) return byExtension
  return dot > 0 || firstLine === undefined ? null : interpreterOf(firstLine)
}

function interpreterOf(firstLine: string): SourceLanguage | null {
  const shebang = /^#!\s*(\S+)(?:\s+(?:-\S+\s+)*(\S+))?/.exec(firstLine)
  if (shebang === null) return null
  const program = shebang[1]!.split('/').at(-1)!
  const interpreter = program === 'env' ? shebang[2]?.split('/').at(-1) : program
  if (interpreter === undefined) return null
  const bare = interpreter.replace(/[\d.]+$/, '')
  return Object.hasOwn(BY_INTERPRETER, interpreter) ? BY_INTERPRETER[interpreter]!
    : Object.hasOwn(BY_INTERPRETER, bare) ? BY_INTERPRETER[bare]! : null
}
