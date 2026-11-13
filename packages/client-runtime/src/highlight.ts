/**
 * A small syntax colourer for reading code on a phone. Not a parser: one regular
 * expression per language family finds comments, strings, numbers, words and
 * punctuation, and a word is a keyword, a type or a call by lookup and by what
 * follows it. Enough to make a file scannable, which is what a preview is for; an
 * editor would need a real grammar, and the phone does not edit.
 */

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'function'
  | 'property'
  | 'punctuation'
  | 'tag'
  | 'attribute'
  | 'variable'

export interface Token {
  kind: TokenKind
  text: string
}

type Family = 'c-like' | 'python' | 'shell' | 'css' | 'json' | 'yaml' | 'markup' | 'sql' | 'toml' | 'plain'

interface Language {
  family: Family
  keywords: ReadonlySet<string>
  types: ReadonlySet<string>
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter(Boolean))

const JS_KEYWORDS = words(`
  as async await break case catch class const continue debugger default delete do else enum export
  extends false finally for from function get if implements import in instanceof interface let new null
  of package private protected public return satisfies set static super switch this throw true try type
  typeof undefined var void while with yield keyof readonly declare namespace abstract override infer is
`)
const JS_TYPES = words('string number boolean any unknown never object symbol bigint Promise Array Record Map Set Date Error')

const LANGUAGES: Record<string, Language> = {
  javascript: { family: 'c-like', keywords: JS_KEYWORDS, types: JS_TYPES },
  typescript: { family: 'c-like', keywords: JS_KEYWORDS, types: JS_TYPES },
  go: {
    family: 'c-like',
    keywords: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false'),
    types: words('string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 bool byte rune error any'),
  },
  rust: {
    family: 'c-like',
    keywords: words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
    types: words('i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 usize isize bool char str String Vec Option Result Box'),
  },
  swift: {
    family: 'c-like',
    keywords: words('as associatedtype break case catch class continue default defer deinit do else enum extension fallthrough false fileprivate for func guard if import in init inout internal is let nil open operator private protocol public repeat rethrows return self Self static struct subscript super switch throw throws true try typealias var where while some any await async'),
    types: words('Int Double Float String Bool Array Dictionary Set Optional Character Void'),
  },
  kotlin: {
    family: 'c-like',
    keywords: words('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where abstract actual annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg'),
    types: words('Int Long Double Float String Boolean Char Byte Short Unit Any List Map Set'),
  },
  java: {
    family: 'c-like',
    keywords: words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record sealed permits'),
    types: words('String Integer Long Double Float Boolean Object List Map Set'),
  },
  c: {
    family: 'c-like',
    keywords: words('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template public private protected virtual override using new delete this nullptr true false'),
    types: words('size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t bool string'),
  },
  python: {
    family: 'python',
    keywords: words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self'),
    types: words('int str float bool list dict set tuple bytes object Any Optional List Dict'),
  },
  shell: { family: 'shell', keywords: words('if then else elif fi for while until do done case esac in function select return exit export local readonly set unset source alias echo cd ls cat grep sed awk exec eval'), types: new Set() },
  css: { family: 'css', keywords: new Set(), types: new Set() },
  json: { family: 'json', keywords: words('true false null'), types: new Set() },
  yaml: { family: 'yaml', keywords: words('true false null yes no on off ~'), types: new Set() },
  toml: { family: 'toml', keywords: words('true false'), types: new Set() },
  markup: { family: 'markup', keywords: new Set(), types: new Set() },
  sql: {
    family: 'sql',
    keywords: words('select from where insert into values update set delete create table alter drop index view as and or not null is in join left right inner outer on group by order having limit offset union all distinct primary key foreign references default unique check constraint begin commit rollback if exists returning with recursive case when then else end true false'),
    types: words('int integer bigint smallint text varchar char boolean bool date timestamp timestamptz uuid json jsonb numeric decimal float real serial bytea'),
  },
  plain: { family: 'plain', keywords: new Set(), types: new Set() },
}

const BY_EXTENSION: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  go: 'go', rs: 'rust', swift: 'swift', kt: 'kotlin', kts: 'kotlin', java: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', m: 'c', mm: 'c',
  py: 'python', pyi: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', plist: 'markup',
  sql: 'sql',
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'shell', makefile: 'shell', '.zshrc': 'shell', '.bashrc': 'shell', '.npmrc': 'toml', '.gitignore': 'shell', '.env': 'shell',
}

/** The language to colour a path in, by its extension or its whole name; `plain` when neither says. */
export function languageOf(path: string): string {
  const name = (path.split('/').at(-1) ?? path).toLowerCase()
  const named = BY_NAME[name]
  if (named !== undefined) return named
  const dot = name.lastIndexOf('.')
  if (dot === -1) return 'plain'
  return BY_EXTENSION[name.slice(dot + 1)] ?? 'plain'
}

/** The same lookup for a fenced code block's info string ("ts", "python", "bash"). */
export function languageOfFence(info: string): string {
  const tag = info.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (tag === '') return 'plain'
  if (LANGUAGES[tag] !== undefined) return tag
  return BY_EXTENSION[tag] ?? ({ node: 'javascript', shellsession: 'shell', console: 'shell', jsonl: 'json', postgres: 'sql', postgresql: 'sql', mysql: 'sql', cpp: 'c', 'c++': 'c', objc: 'c', golang: 'go', py3: 'python' } as Record<string, string>)[tag] ?? 'plain'
}

/* One alternation per family. Order matters: comments before punctuation, strings before words. */
const PATTERNS: Record<Family, RegExp> = {
  'c-like': /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#!.*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b0[xXbBoO][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[nNfFuUlL]*\b)|(@?[A-Za-z_$][\w$]*)|([{}()[\];,.<>=+\-*/%!&|^~?:])|(\s+)|(.)/g,
  python: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|[rbfRBF]{0,2}"(?:\\.|[^"\\\n])*"|[rbfRBF]{0,2}'(?:\\.|[^'\\\n])*')|(\b0[xXbBoO][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?j?\b)|(@?[A-Za-z_][\w]*)|([{}()[\];,.<>=+\-*/%!&|^~?:])|(\s+)|(.)/g,
  shell: /(#[^\n]*)|("(?:\\.|[^"\\])*"|'[^']*')|(\b\d+\b)|(\$\{?[A-Za-z_][\w]*\}?|\$[0-9@#?*!-]|[A-Za-z_][\w.-]*)|([{}()[\];,.<>=+\-*/%!&|^~?:])|(\s+)|(.)/g,
  css: /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(#[0-9a-fA-F]{3,8}\b|-?\d[\d.]*(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?)|(@[\w-]+|--[\w-]+|\.[\w-]+|[\w-]+(?=\s*:)|[\w-]+)|([{}()[\];,.<>=+\-*/%!&|^~?:])|(\s+)|(.)/g,
  json: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b[A-Za-z_]\w*\b)|([{}[\]:,])|(\s+)|(.)/g,
  yaml: /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:''|[^'\n])*')|(\b-?\d+(?:\.\d+)?\b)|(^[ \t]*-?[ \t]*[\w.-]+(?=\s*:)|&\w+|\*\w+|[\w./-]+)|([{}[\],:|>-])|(\s+)|(.)/gm,
  markup: /(<!--[\s\S]*?-->)|("(?:[^"\\])*"|'[^']*')|(\b\d+(?:\.\d+)?\b)|(<\/?[\w:-]+|[\w:-]+(?==)|[^<>"'=\s]+)|([<>/=])|(\s+)|(.)/g,
  sql: /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'\n])*'|"(?:[^"\n])*")|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)|([{}()[\];,.<>=+\-*/%!&|^~?:])|(\s+)|(.)/g,
  toml: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'[^'\n]*')|(\b-?\d[\d_]*(?:\.\d[\d_]*)?\b)|(\[[\w.\s"'-]+\]|[\w.-]+)|([{}[\]=,.])|(\s+)|(.)/g,
  plain: /([\s\S]+)/g,
}

/** Colours one text. Returns one token list per line so a list can render them row by row. */
export function highlight(code: string, language: string): Token[][] {
  const lang = LANGUAGES[language] ?? LANGUAGES.plain!
  if (lang.family === 'plain') return code.split('\n').map((line) => (line === '' ? [] : [{ kind: 'plain', text: line }]))
  const pattern = new RegExp(PATTERNS[lang.family].source, PATTERNS[lang.family].flags)
  const tokens: Token[] = []
  let match: RegExpExecArray | null
  // Where the text after the current word starts, so a name followed by `(` reads as a call.
  const ahead = (from: number) => code.slice(from, from + 24)
  while ((match = pattern.exec(code)) !== null) {
    const [text, comment, string, number, word, punct] = match
    if (text === '') { pattern.lastIndex += 1; continue }
    if (comment !== undefined) tokens.push({ kind: 'comment', text })
    else if (string !== undefined) tokens.push({ kind: 'string', text })
    else if (number !== undefined) tokens.push({ kind: 'number', text })
    else if (word !== undefined) tokens.push({ kind: classify(lang, text, ahead(pattern.lastIndex), tokens), text })
    else if (punct !== undefined) tokens.push({ kind: 'punctuation', text })
    else tokens.push({ kind: 'plain', text })
  }
  return splitLines(tokens)
}

function classify(lang: Language, word: string, after: string, before: Token[]): TokenKind {
  const family = lang.family
  if (family === 'markup') {
    if (word.startsWith('<')) return 'tag'
    return /^=/.test(after) ? 'attribute' : 'plain'
  }
  if (family === 'css') {
    if (word.startsWith('@')) return 'keyword'
    if (word.startsWith('--')) return 'variable'
    if (word.startsWith('.')) return 'type'
    return /^\s*:/.test(after) ? 'property' : 'plain'
  }
  if (family === 'yaml' || family === 'toml') {
    if (lang.keywords.has(word.trim())) return 'keyword'
    if (family === 'toml' && word.startsWith('[')) return 'type'
    if (family === 'yaml' && (word.startsWith('&') || word.startsWith('*'))) return 'variable'
    return /^\s*[:=]/.test(after) ? 'property' : 'plain'
  }
  if (family === 'json') return lang.keywords.has(word) ? 'keyword' : 'plain'
  if (family === 'shell') {
    if (word.startsWith('$')) return 'variable'
    if (lang.keywords.has(word)) return 'keyword'
    if (/^\s*=/.test(after) && !/^\s*==/.test(after)) return 'variable'
    return 'plain'
  }
  const lower = family === 'sql' ? word.toLowerCase() : word
  if (lang.keywords.has(lower)) return 'keyword'
  if (lang.types.has(lower)) return 'type'
  if (word.startsWith('@')) return 'keyword'
  const previous = before.at(-1)
  if (previous?.kind === 'punctuation' && previous.text === '.' && !/^\s*\(/.test(after)) return 'property'
  if (/^\s*\(/.test(after)) return 'function'
  if (family === 'c-like' && /^[A-Z][\w$]*$/.test(word) && word.length > 1) return 'type'
  return 'plain'
}

function splitLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]]
  for (const token of tokens) {
    const parts = token.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part !== '') lines[lines.length - 1]!.push({ kind: token.kind, text: part })
    })
  }
  return lines
}
