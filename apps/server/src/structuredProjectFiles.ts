import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ServerMessage } from '@manor/contracts'
import { structuredProjectSlug } from './structuredMemory.js'

type Listing = Pick<Extract<ServerMessage, { type: 'project_memory' }>, 'files' | 'truncated'>
const MAX_FILES = 200
const MAX_BYTES = 1_000_000

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

/** Available project evidence, independent of a turn's relevance ranking and prompt budget. */
export async function listStructuredProjectMemory(root: string | undefined, name: string): Promise<Listing> {
  const listing: Listing = { files: [], truncated: false }
  const slug = structuredProjectSlug(name)
  if (root === undefined || slug.length === 0) return listing
  const index = path.join(root, slug, 'MEMORY.md')
  let directory: string
  try {
    directory = path.dirname(await realpath(index))
  } catch (error) {
    if (missing(error)) return listing
    throw error
  }
  const seen = new Set<string>()
  let remaining = MAX_BYTES
  const read = async (filePath: string, kind: 'index' | 'file') => {
    try {
      const resolved = await realpath(filePath)
      if (!resolved.startsWith(`${directory}${path.sep}`) || seen.has(resolved)) return
      seen.add(resolved)
      const info = await stat(resolved)
      if (!info.isFile()) return
      if (listing.files.length >= MAX_FILES || info.size > remaining) {
        listing.truncated = true
        return
      }
      const content = await readFile(resolved, 'utf8')
      const bytes = Buffer.byteLength(content)
      if (bytes > remaining) { listing.truncated = true; return }
      remaining -= bytes
      listing.files.push({ path: filePath, kind, modifiedAt: info.mtimeMs, content })
      return content
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  const content = await read(index, 'index')
  if (content === undefined) return listing
  // Match the same project-index rows as turn retrieval, without relevance filtering.
  for (const row of content.split('\n')) {
    const link = row.match(/^\s*-\s+\[[^\]]+\]\(([^)]+\.md)\)/)?.[1]
    if (link !== undefined) await read(path.resolve(path.dirname(index), link), 'file')
  }
  return listing
}
