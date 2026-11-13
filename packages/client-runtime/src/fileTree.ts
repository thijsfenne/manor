/**
 * A flat listing folded into one level of a folder tree at a time. The server
 * sends every path as `<folder>/<inside>` and nothing else, because a tree over
 * the wire is a tree to keep in sync; the phone folds it on demand, one visible
 * level per call, which is all a drill-down list ever shows.
 */

export interface TreeEntry {
  kind: 'folder' | 'file'
  name: string
  /** The full path for a file, the prefix (without trailing slash) for a folder. */
  path: string
  /** Files under a folder, counted through every level, for the row's subtitle. */
  count: number
}

/** The folders and files directly under `dir` (`''` for the root), folders first, each side by name. */
export function entriesUnder(files: readonly string[], dir: string): TreeEntry[] {
  const prefix = dir === '' ? '' : `${dir}/`
  const folders = new Map<string, number>()
  const leaves: TreeEntry[] = []
  for (const file of files) {
    if (!file.startsWith(prefix)) continue
    const rest = file.slice(prefix.length)
    if (rest === '') continue
    const slash = rest.indexOf('/')
    if (slash === -1) {
      leaves.push({ kind: 'file', name: rest, path: file, count: 1 })
    } else {
      const name = rest.slice(0, slash)
      folders.set(name, (folders.get(name) ?? 0) + 1)
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  const dirs: TreeEntry[] = [...folders].map(([name, count]) => ({ kind: 'folder', name, path: `${prefix}${name}`, count }))
  return [...dirs.sort(byName), ...leaves.sort(byName)]
}

/**
 * The linked folder a single-root repo listing wraps every path in. Multiple linked
 * folders stay visible, because their labels are the only way to tell them apart.
 */
export function singleRootDir(files: readonly string[]): string {
  const root = entriesUnder(files, '')
  return root.length === 1 && root[0]?.kind === 'folder' ? root[0].path : ''
}

/** The folder one level up, `''` at the root. */
export const parentOf = (dir: string): string => {
  const slash = dir.lastIndexOf('/')
  return slash === -1 ? '' : dir.slice(0, slash)
}

/** The last segment of a path, or the path itself when it has none. */
export const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

/** Everything before the last segment, `''` when the path is a bare name. */
export const dirname = (path: string): string => parentOf(path)

/**
 * Resolve a Markdown link beside the file that contains it. External URLs and
 * root-absolute paths stay outside this helper; the mobile file browser owns
 * only paths inside the listing it already received from Manor.
 */
export function resolveRelativeFileLink(fromFile: string, href: string): string | null {
  const rawPath = href.split(/[?#]/, 1)[0] ?? ''
  if (rawPath === '' || rawPath.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(rawPath)) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }

  const parts: string[] = []
  for (const part of `${dirname(fromFile)}/${decoded}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/') || null
}
