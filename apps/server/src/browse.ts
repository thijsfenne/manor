import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface DirEntry {
  name: string
  path: string
}

export type DirListingResult =
  | { ok: true; path: string; parent: string | null; entries: DirEntry[] }
  | { ok: false; message: string }

/**
 * One directory's subdirectories, for the folder picker in the create-project flow.
 * This browses the machine Manor runs on, never the viewer's: a browser cannot hand
 * out an absolute path, and once Manor lives on the VPS the viewer's disk is the
 * wrong one anyway. Nothing here is a permission boundary. Manor is single-user and a
 * linked folder already gets full read and write access from every persona.
 *
 * `message` is shown to the user verbatim, so it reads as a sentence, the same way
 * `validateRepoPath` writes its refusals.
 */
export async function listDirectories(input?: string): Promise<DirListingResult> {
  const trimmed = input?.trim() ?? ''
  // No path means "start where project folders usually live", the server user's
  // home. The picker walks up and down from there.
  const target = trimmed.length === 0 ? os.homedir() : trimmed
  if (!path.isAbsolute(target)) {
    return {
      ok: false,
      message: `${target} is not an absolute path. Manor browses its own machine and has no current folder to read it against, so give it the whole path, starting at /.`,
    }
  }

  // Collapses "..", repeated separators and a trailing slash, so the path echoed
  // back to the picker is the one that would be stored.
  const resolved = path.resolve(target)
  const opened = await open(resolved)
  if (!opened.ok) return opened

  const entries: DirEntry[] = []
  for (const child of opened.children) {
    // A home directory full of `.config`-style entries is noise in a folder picker,
    // and none of them is a project folder.
    if (child.name.startsWith('.')) continue
    const childPath = path.join(resolved, child.name)
    if (child.isDirectory()) {
      entries.push({ name: child.name, path: childPath })
      continue
    }
    // A symlink is reported as the link, not as what it points at, so a linked
    // folder needs one stat to be recognised. A dangling or unreadable child is
    // skipped rather than fatal: one bad entry must not cost the whole listing.
    if (!child.isSymbolicLink()) continue
    try {
      if ((await stat(childPath)).isDirectory()) entries.push({ name: child.name, path: childPath })
    } catch {
      continue
    }
  }

  // Case-insensitive, pinned to one locale so the laptop and the VPS order a folder
  // list the same way.
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'accent' }))

  // The root is its own parent, which is what stops the picker's "up" control from
  // walking off the end.
  const parent = path.dirname(resolved)
  return { ok: true, path: resolved, parent: parent === resolved ? null : parent, entries }
}

/**
 * readdir, with its failures turned into the sentence the picker shows. ENOTDIR is
 * reported as "a file" because that is what it means when someone picked one; it can
 * also mean a file sits halfway along the path, which reads close enough to be worth
 * one syscall here instead of a stat and then a readdir.
 */
async function open(resolved: string) {
  try {
    return { ok: true as const, children: await readdir(resolved, { withFileTypes: true }) }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false as const, message: `There is nothing at ${resolved}.` }
    if (code === 'ENOTDIR') return { ok: false as const, message: `${resolved} is a file, not a folder.` }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false as const, message: `Manor is not allowed to read ${resolved}.` }
    }
    return { ok: false as const, message: `Manor cannot open ${resolved}: ${(error as Error).message}` }
  }
}
