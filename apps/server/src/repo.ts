import { stat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_PROJECT_FOLDERS } from '@manor/contracts'

export type RepoPathResult = { ok: true; path: string } | { ok: false; message: string }

export type RepoPathsResult = { ok: true; paths: string[] } | { ok: false; message: string }

/**
 * Checks the folder a project wants to link, before it is stored. The path is a real
 * working copy on the machine Manor runs on and personas get full read and write
 * access to it, so an unusable one is refused at the door instead of being
 * discovered by a persona halfway through a turn. Being a git repo is not required:
 * a project links a folder, whatever is in it.
 *
 * `message` is shown to the user verbatim, so it reads as a sentence. The path is only
 * normalised and passed on as a single argv entry; nothing here builds a shell
 * string out of it.
 */
export async function validateRepoPath(input: string): Promise<RepoPathResult> {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { ok: false, message: 'Manor needs a folder path to link.' }
  if (!path.isAbsolute(trimmed)) {
    return {
      ok: false,
      message: `${trimmed} is not an absolute path. Manor has no current folder to read it against, so give it the whole path, starting at /.`,
    }
  }

  // Collapses "..", repeated separators and a trailing slash, so the same folder
  // typed two ways is stored one way.
  const resolved = path.resolve(trimmed)
  try {
    const stats = await stat(resolved)
    if (!stats.isDirectory()) return { ok: false, message: `${resolved} is a file, not a folder.` }
    return { ok: true, path: resolved }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, message: `There is nothing at ${resolved}.` }
    return { ok: false, message: `Manor cannot open ${resolved}: ${(error as Error).message}` }
  }
}

/**
 * The whole folder list a project wants, checked as one thing. All or nothing on
 * purpose: the list is one form, and a half-applied edit is a project whose folders
 * are neither what they were nor what the user asked for.
 *
 * Duplicates are dropped rather than refused. Two spellings of one folder are not a
 * mistake worth a refusal (the picker and a pasted path resolve to the same place),
 * and keeping both would name it twice in every catch-up block.
 */
export async function validateRepoPaths(inputs: readonly string[]): Promise<RepoPathsResult> {
  // Blanks vanish first: an empty row in the dialog is an unfilled field, not a
  // folder nobody can find.
  const wanted = inputs.filter((input) => input.trim().length > 0)
  if (wanted.length > MAX_PROJECT_FOLDERS) {
    return {
      ok: false,
      message: `That is ${wanted.length} folders and a project can link at most ${MAX_PROJECT_FOLDERS}. Every one of them is named in every turn's prompt, so the list has to stay something a persona can read.`,
    }
  }

  const paths: string[] = []
  for (const input of wanted) {
    const checked = await validateRepoPath(input)
    if (!checked.ok) return checked
    if (!paths.includes(checked.path)) paths.push(checked.path)
  }
  return { ok: true, paths }
}
