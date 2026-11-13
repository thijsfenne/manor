import { EDIT_SIDE_LIMIT, MAX_EDITS_PER_CALL, type FileEdit } from '@manor/contracts'
import path from 'node:path'
import { folderLabels } from '../repoFiles.js'

/**
 * Turns whatever shape a provider uses to describe a file change into Manor's one
 * FileEdit shape. Every provider quirk stays in this file: the UI renders diffs
 * without knowing that Claude sends string pairs and Codex sends patch text.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** Tools whose input describes a file change. Everything else is read-only to us. */
const EDIT_TOOLS = /^(edit|write|multiedit|multi_edit|notebookedit|notebook_edit|search_replace|str_replace[a-z_]*)$/i

export const isEditTool = (tool: string): boolean => EDIT_TOOLS.test(tool)

/** Native file tools resolve relative paths from the driver's workspace. */
export function withEditOrigins(edits: FileEdit[], cwd: string, repoPaths: readonly string[]): FileEdit[] {
  const roots = repoPaths.map((root) => path.resolve(root))
  const labels = folderLabels(roots)
  return edits.map((edit) => {
    // Driver edit paths are capped at 400 characters; at the cap the origin may
    // have lost its tail, so it cannot identify a file safely.
    if (edit.path.length >= 400) return edit
    const absolute = path.resolve(cwd, edit.path)
    if (absolute.length > 1_024) return edit
    const rootIndex = roots.reduce((best, root, index) =>
      absolute.startsWith(`${root}${path.sep}`) && (best < 0 || root.length > roots[best]!.length)
        ? index : best, -1)
    const root = roots[rootIndex]
    const label = labels[rootIndex]
    const panelPath = root === undefined || label === undefined
      ? undefined : `${label}/${absolute.slice(root.length + 1).split(path.sep).join('/')}`
    return {
      ...edit,
      originPath: absolute,
      ...(panelPath !== undefined && panelPath.length <= 1_024 ? { panelPath } : {}),
    }
  })
}

/**
 * Builds one edit, enforcing the transcript caps. A side longer than the cap keeps
 * its head and is flagged, because the start of a hunk is the part that identifies
 * the change; silently storing a shortened side would render a diff that lies.
 */
export function buildEdit(
  path: string,
  before: string | undefined,
  after: string | undefined,
  created = false,
  offset?: FileEdit['offset'],
): FileEdit {
  const overlong = (value: string | undefined) => value !== undefined && value.length > EDIT_SIDE_LIMIT
  const cap = (value: string | undefined) => (value === undefined ? undefined : value.slice(0, EDIT_SIDE_LIMIT))
  const truncated = overlong(before) || overlong(after)
  const cappedBefore = cap(before)
  const cappedAfter = cap(after)
  return {
    path: path.slice(0, 400),
    ...(cappedBefore === undefined ? {} : { before: cappedBefore }),
    ...(cappedAfter === undefined ? {} : { after: cappedAfter }),
    ...(created ? { created: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(offset === undefined ? {} : { offset }),
  }
}

/** A whole-file write starts at the top of both sides. */
const WHOLE_FILE = { before: 0, after: 0 }

/**
 * The lines above a hunk, read from its `@@ -a,b +c,d @@` header. A side with count
 * 0 names the line the hunk sits after rather than its first line, so it is not
 * shifted back. Undefined for a header without numbers, as `apply_patch` writes them.
 */
export function hunkOffset(header: string): FileEdit['offset'] {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
  if (match === null) return undefined
  const side = (start: string, count: string | undefined) =>
    count === '0' ? Number(start) : Math.max(Number(start) - 1, 0)
  return { before: side(match[1]!, match[2]), after: side(match[3]!, match[4]) }
}

/**
 * Reads file changes out of a Claude Code tool_use input. A Write carries only the
 * new contents — the CLI never sends what was there before — so the input alone
 * cannot tell a new file from one being overwritten. `exists` is what answers that,
 * and the caller is expected to ask the disk before the write lands. Getting it
 * wrong is one-directional on purpose: a file that already existed still exists when
 * we look, so we can under-report a creation but never invent one.
 */
export function editsFromToolInput(
  tool: string,
  rawInput: unknown,
  exists?: (path: string) => boolean,
): FileEdit[] | undefined {
  if (!isRecord(rawInput) || !isEditTool(tool)) return undefined
  const path = asString(rawInput['file_path']) ?? asString(rawInput['path']) ?? asString(rawInput['notebook_path'])
  if (path === undefined) return undefined

  // MultiEdit: several hunks against one file, each its own row in the diff.
  const batch = rawInput['edits']
  if (Array.isArray(batch)) {
    const edits = batch
      .filter(isRecord)
      .map((entry) => buildEdit(path, asString(entry['old_string']), asString(entry['new_string'])))
      .filter((edit) => edit.before !== undefined || edit.after !== undefined)
    return edits.length === 0 ? undefined : edits.slice(0, MAX_EDITS_PER_CALL)
  }

  const before = asString(rawInput['old_string'])
  const content = asString(rawInput['content'])
  const after = asString(rawInput['new_string']) ?? content ?? asString(rawInput['new_source'])
  if (before === undefined && after === undefined) return undefined
  // Only a whole-file write can be a creation; a targeted edit had a `before` to
  // match against, so the file was already there by definition.
  const created = before === undefined && after !== undefined && exists?.(path) === false
  // A Write's `content` is the whole file; an Edit's strings carry no position.
  const whole = before === undefined && content !== undefined && after === content
  return [buildEdit(path, before, after, created, whole ? WHOLE_FILE : undefined)]
}

/**
 * Reads Codex's native file-change item. App-server includes a unified diff; older
 * records may still carry only path and operation, which remains enough to list the
 * changed file without inventing contents.
 */
export function editsFromCodexFileChanges(rawChanges: unknown): FileEdit[] | undefined {
  if (!Array.isArray(rawChanges)) return undefined
  const edits = rawChanges.flatMap<FileEdit>((raw) => {
    if (!isRecord(raw)) return []
    const path = asString(raw['path'])
    const rawKind = raw['kind']
    const kind = asString(rawKind) ?? (isRecord(rawKind) ? asString(rawKind['type']) : undefined)
    if (path === undefined || (kind !== 'add' && kind !== 'update' && kind !== 'delete')) return []
    const diff = asString(raw['diff'])
    return diff === undefined || diff.length === 0
      ? [{ path: path.slice(0, 400), kind }]
      : [{ ...editFromUnifiedDiff(path, diff), kind }]
  })
  return edits.length === 0 ? undefined : edits.slice(0, MAX_EDITS_PER_CALL)
}

/** One file's unified diff as the before/after fragment Manor renders. */
function editFromUnifiedDiff(path: string, diff: string): FileEdit {
  const lines = diff.split('\n')
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  const headers = firstHunk === -1 ? lines : lines.slice(0, firstHunk)
  const oldHeader = headers.find((line) => line.startsWith('--- '))?.slice(4).trim()
  const newHeader = headers.find((line) => line.startsWith('+++ '))?.slice(4).trim()
  const before: string[] = []
  const after: string[] = []
  let inHunk = false
  let changed = false
  let hunks = 0
  let offset: FileEdit['offset']

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true
      hunks += 1
      offset = hunkOffset(line)
      continue
    }
    if (!inHunk || line === '\\ No newline at end of file') continue
    if (line.startsWith('+')) {
      after.push(line.slice(1))
      changed = true
    } else if (line.startsWith('-')) {
      before.push(line.slice(1))
      changed = true
    } else if (line.startsWith(' ')) {
      before.push(line.slice(1))
      after.push(line.slice(1))
    }
  }

  if (!changed) return { path: path.slice(0, 400), kind: 'update' }
  const side = (value: string[]) => (value.length === 0 ? '' : `${value.join('\n')}\n`)
  const created = oldHeader === '/dev/null'
  const deleted = newHeader === '/dev/null'
  // Several hunks are joined into one fragment here, so only a lone hunk keeps its place.
  return buildEdit(
    path,
    created ? undefined : side(before),
    deleted ? undefined : side(after),
    created,
    hunks === 1 ? offset : undefined,
  )
}

/**
 * Cursor reports a native file operation's durable truth only on the completed
 * tool call. Keep that provider shape here and hand the rest of Manor the same
 * FileEdit used by every other driver.
 */
export function editsFromCursorToolCall(
  rawToolCall: unknown,
  existedBefore?: boolean,
): FileEdit[] | undefined {
  if (!isRecord(rawToolCall)) return undefined
  const entry = Object.entries(rawToolCall).find(([key, value]) =>
    /^(?:write|edit|applyPatch|delete)ToolCall$/i.test(key) && isRecord(value),
  )
  if (entry === undefined) return undefined

  const kind = entry[0].toLowerCase()
  const call = entry[1] as Record<string, unknown>
  const args = isRecord(call['args']) ? call['args'] : {}
  const result = isRecord(call['result']) ? call['result'] : undefined
  const success = result !== undefined && isRecord(result['success']) ? result['success'] : undefined
  if (success === undefined) return undefined

  const path = asString(success['path'])
    ?? asString(args['path'])
    ?? asString(args['filePath'])
    ?? asString(args['targetFile'])
  if (path === undefined) return undefined

  if (kind === 'deletetoolcall') {
    const before = asString(success['prevContent'])
    return before === undefined
      ? [{ path: path.slice(0, 400), kind: 'delete' }]
      : [buildEdit(path, before, undefined)]
  }

  if (kind === 'writetoolcall') {
    const after = asString(args['fileText'])
    if (after !== undefined) return [buildEdit(path, undefined, after, existedBefore === false, WHOLE_FILE)]
    return [{ path: path.slice(0, 400), kind: existedBefore === false ? 'add' : 'update' }]
  }

  const linesAdded = typeof success['linesAdded'] === 'number' ? success['linesAdded'] : undefined
  const linesRemoved = typeof success['linesRemoved'] === 'number' ? success['linesRemoved'] : undefined
  if (linesAdded === 0 && linesRemoved === 0) return undefined

  const diff = asString(success['diffString'])
  if (diff === undefined) return [{ path: path.slice(0, 400), kind: 'update' }]

  return [editFromUnifiedDiff(path, diff)]
}

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/

/**
 * Parses Codex's `apply_patch` envelope into the same FileEdit shape. Context lines
 * land on both sides so the rendered diff keeps its surrounding lines; an Update
 * hunk with no context still reads correctly because both sides stay aligned.
 *
 * Returns undefined when the command is not an apply_patch, so the caller can keep
 * treating it as an ordinary shell command.
 */
export function editsFromApplyPatch(command: string): FileEdit[] | undefined {
  if (!command.includes('*** Begin Patch')) return undefined
  const lines = command.split('\n')
  const edits: FileEdit[] = []
  let path: string | undefined
  let mode: 'Add' | 'Update' | 'Delete' | undefined
  let before = ''
  let after = ''

  const flush = () => {
    if (path === undefined || mode === undefined) return
    if (mode === 'Delete') edits.push(buildEdit(path, undefined, undefined))
    // Codex says so outright in the patch header, so this is the one creation we
    // never have to guess at.
    else if (mode === 'Add') edits.push(buildEdit(path, undefined, after, true, WHOLE_FILE))
    else edits.push(buildEdit(path, before, after))
    before = ''
    after = ''
  }

  for (const line of lines) {
    const header = PATCH_FILE.exec(line)
    if (header) {
      flush()
      mode = header[1] as 'Add' | 'Update' | 'Delete'
      path = header[2]!.trim()
      continue
    }
    if (path === undefined) continue
    if (line.startsWith('*** End Patch')) break
    // A hunk header carries no content of its own; the lines under it do.
    if (line.startsWith('@@')) continue
    if (line.startsWith('+')) after += `${line.slice(1)}\n`
    else if (line.startsWith('-')) before += `${line.slice(1)}\n`
    else if (line.startsWith(' ')) {
      before += `${line.slice(1)}\n`
      after += `${line.slice(1)}\n`
    }
  }
  flush()

  const real = edits.filter((edit) => edit.before !== undefined || edit.after !== undefined || edit.path.length > 0)
  return real.length === 0 ? undefined : real.slice(0, MAX_EDITS_PER_CALL)
}

const HEREDOC_OPEN = /<<-?\s*(['"]?)(\w+)\1/

/**
 * Body of the first heredoc in `source`, or nothing when the closer never comes.
 * The closer has to sit on its own line, same as the shell requires.
 */
function takeHeredoc(source: string, from = 0): { tag: string; body: string } | undefined {
  const slice = source.slice(from)
  const open = HEREDOC_OPEN.exec(slice)
  if (!open || open.index === undefined) return undefined
  const tag = open[2]!
  const afterOpen = slice.slice(open.index + open[0].length)
  const newline = afterOpen.indexOf('\n')
  if (newline === -1) return undefined
  const rest = afterOpen.slice(newline + 1)
  const close = new RegExp(`^${tag}\\s*$`, 'm').exec(rest)
  if (!close || close.index === undefined) return undefined
  return { tag, body: rest.slice(0, close.index) }
}

/** Quoted paths keep their spaces; an unquoted path still stops at whitespace. */
const CAT_REDIRECT =
  /(?:^|[\n;&]|\|\||&&)\s*(?:\/[\w./]+\/)?cat\s+(?<op>>>?)\s*(?:'(?<single>[^']+)'|"(?<double>[^"]+)"|(?<bare>\S+))\s+<<-?/

function editsFromCatHeredoc(command: string, exists?: (path: string) => boolean): FileEdit[] {
  const edits: FileEdit[] = []
  let from = 0
  while (from < command.length && edits.length < MAX_EDITS_PER_CALL) {
    const slice = command.slice(from)
    const redirect = CAT_REDIRECT.exec(slice)
    if (!redirect || redirect.index === undefined) break
    const at = from + redirect.index
    const heredoc = takeHeredoc(command, at)
    if (heredoc === undefined) {
      from = at + redirect[0].length
      continue
    }
    const path = redirect.groups?.single ?? redirect.groups?.double ?? redirect.groups?.bare
    if (path === undefined) {
      from = at + redirect[0].length
      continue
    }
    const append = redirect.groups?.op === '>>'
    const created = !append && exists?.(path) === false
    edits.push(buildEdit(path, undefined, heredoc.body, created, append ? undefined : WHOLE_FILE))
    from = at + redirect[0].length + heredoc.body.length
  }
  return edits
}

const PYTHON_ASSIGN = /(?:^|\n)\s*(\w+)\s*=\s*(?:Path\s*\(\s*)?(['"])([^'"]+)\2/g
const PYTHON_OPEN_MODE = /\bopen\s*\(\s*(\w+)\s*,\s*(?:mode\s*=\s*)?(['"])([rwaxtbU+]+)\2/g
const PYTHON_PATH_WRITE = /\b(\w+)\.write(?:_text|_bytes)\s*\(/g
const PYTHON_PATH_CTOR_WRITE = /\bPath\s*\(\s*(\w+)\s*\)\.write(?:_text|_bytes)\s*\(/g

function pythonAssignments(script: string): Map<string, string> {
  const paths = new Map<string, string>()
  for (const match of script.matchAll(PYTHON_ASSIGN)) {
    const name = match[1]!
    if (!paths.has(name)) paths.set(name, match[3]!)
  }
  return paths
}

/**
 * Names that actually wrote a file. `open(p, encoding='utf-8')` is a read;
 * only a write-mode (`w`/`a`/`x` or `+`) or Path.write_text/write_bytes counts.
 */
function pythonWrittenNames(script: string): Set<string> {
  const names = new Set<string>()
  for (const match of script.matchAll(PYTHON_OPEN_MODE)) {
    if (/[wax+]/.test(match[3]!)) names.add(match[1]!)
  }
  for (const match of script.matchAll(PYTHON_PATH_WRITE)) names.add(match[1]!)
  for (const match of script.matchAll(PYTHON_PATH_CTOR_WRITE)) names.add(match[1]!)
  return names
}

function pythonWrittenPaths(script: string): string[] {
  const assigned = pythonAssignments(script)
  const paths: string[] = []
  const seen = new Set<string>()
  for (const name of pythonWrittenNames(script)) {
    const path = assigned.get(name)
    if (path === undefined || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

function pythonString(script: string, name: string): string | undefined {
  const assignment = /(?:^|\n)\s*(\w+)\s*=\s*("""|''')/g
  for (const match of script.matchAll(assignment)) {
    if (match[1] !== name || match.index === undefined) continue
    const quote = match[2]!
    const start = match.index + match[0].length
    const end = script.indexOf(quote, start)
    if (end === -1) return undefined
    const value = script.slice(start, end)
    return value.startsWith('\n') ? value.slice(1) : value
  }
  return undefined
}

function editsFromPythonHeredoc(command: string, exists?: (path: string) => boolean): FileEdit[] {
  if (!/\bpython3?(?:\.\d+)?\b/.test(command)) return []
  const heredoc = takeHeredoc(command)
  if (heredoc === undefined) return []
  const script = heredoc.body
  const paths = pythonWrittenPaths(script)
  if (paths.length === 0) return []
  const before = pythonString(script, 'old')
  const after = pythonString(script, 'new')
  return paths.slice(0, MAX_EDITS_PER_CALL).map((path) => {
    if (before !== undefined && after !== undefined) return buildEdit(path, before, after)
    if (after !== undefined) return buildEdit(path, undefined, after, exists?.(path) === false)
    // Wrote the path but did not spell the two sides in a shape we can parse.
    // Path and kind are still true; inventing contents would make a lying diff.
    return { path: path.slice(0, 400), kind: exists?.(path) === false ? 'add' : 'update' }
  })
}

/**
 * Reads a shell write that never went through a native edit tool: Claude's
 * bypassPermissions path uses `python3 - <<` for replacements and `cat > file <<`
 * for whole-file writes. Returns undefined when the command is not that shape, so
 * the caller can keep treating it as a read or an ordinary shell command.
 */
export function editsFromShellWrite(
  command: string,
  exists?: (path: string) => boolean,
): FileEdit[] | undefined {
  const python = editsFromPythonHeredoc(command, exists)
  if (python.length > 0) return python.slice(0, MAX_EDITS_PER_CALL)
  const cat = editsFromCatHeredoc(command, exists)
  return cat.length === 0 ? undefined : cat.slice(0, MAX_EDITS_PER_CALL)
}
