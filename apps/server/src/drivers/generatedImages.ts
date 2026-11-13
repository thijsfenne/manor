import type { ImageAttachment } from '@manor/contracts'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_IMAGES = 4
const MAX_DATA_URL_LENGTH = 2_000_000
// Codex generates raster images through its image tool; Claude has no image
// tool and reaches for SVG, so both are collected. Only the raster formats are
// replayable as multimodal context — see materialiseImages in turnContext.ts.
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

// A checkout or an install rewrites thousands of bundled images in one go, and
// every one of them looks freshly modified. Skipping these keeps the collector
// pointed at what the agent actually drew.
const SKIPPED_DIRECTORIES = new Set([
  // User inputs materialised for the CLI, not agent output.
  'attachments',
  '.git',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
])

interface Candidate {
  path: string
  mtimeMs: number
}

async function candidatesUnder(root: string, sinceMs: number): Promise<Candidate[]> {
  const rootMetadata = await stat(root).catch(() => undefined)
  if (rootMetadata?.isFile() === true) {
    return MIME_TYPES[path.extname(root).toLowerCase()] !== undefined && rootMetadata.mtimeMs >= sinceMs - 1_000
      ? [{ path: root, mtimeMs: rootMetadata.mtimeMs }]
      : []
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const candidates: Candidate[] = []

  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      candidates.push(...(await candidatesUnder(target, sinceMs)))
      continue
    }
    if (!entry.isFile() || MIME_TYPES[path.extname(entry.name).toLowerCase()] === undefined) continue
    const metadata = await stat(target).catch(() => undefined)
    // Allow for filesystems whose modification timestamps have coarse precision.
    if (metadata !== undefined && metadata.mtimeMs >= sinceMs - 1_000) {
      candidates.push({ path: target, mtimeMs: metadata.mtimeMs })
    }
  }

  return candidates
}

/** Makes images produced during one turn durable chat attachments. */
export async function collectGeneratedImages(
  roots: readonly string[],
  sinceMs: number,
): Promise<ImageAttachment[]> {
  const found = (await Promise.all(roots.map((root) => candidatesUnder(root, sinceMs))))
    .flat()
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))

  const images: ImageAttachment[] = []
  const seen = new Set<string>()
  for (const candidate of found) {
    const resolved = path.resolve(candidate.path)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    const mime = MIME_TYPES[path.extname(resolved).toLowerCase()]
    if (mime === undefined) continue
    const bytes = await readFile(resolved).catch(() => undefined)
    if (bytes === undefined) continue
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
    // The shared contract is the one size boundary for human and agent images.
    if (dataUrl.length > MAX_DATA_URL_LENGTH) continue
    images.push({ name: path.basename(resolved), dataUrl })
    if (images.length === MAX_IMAGES) break
  }
  return images
}
