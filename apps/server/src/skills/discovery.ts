import type { SkillCandidate, SkillConfig, SkillSource } from '@manor/contracts'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { SkillBundleFile } from '../store.js'

export interface SkillRoot {
  source: SkillSource
  path: string
}

export interface DiscoveredSkill {
  candidate: SkillCandidate
  skill: SkillConfig
  files: SkillBundleFile[]
}

const SKILL_FILE = 'SKILL.md'
const VALID_SLUG = /^[a-z0-9][a-z0-9_-]*$/
const MAX_INSTRUCTIONS = 150_000
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024
const MAX_BUNDLE_FILES = 1_000
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__'])
const SKIPPED_FILES = new Set(['.DS_Store', 'auth.json', 'credentials.json'])

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

const excludedName = (name: string): boolean =>
  SKIPPED_FILES.has(name) || name === '.env' || name.startsWith('.env.') || /\.(pem|key)$/i.test(name)

async function readBundle(root: string): Promise<SkillBundleFile[]> {
  const resolvedRoot = await realpath(root)
  const files: SkillBundleFile[] = []
  let totalBytes = 0

  const visit = async (folder: string, relativeFolder: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue
      if (excludedName(entry.name)) continue
      const absolute = path.join(folder, entry.name)
      const relative = path.posix.join(relativeFolder.split(path.sep).join(path.posix.sep), entry.name)
      const info = await lstat(absolute)

      if (info.isSymbolicLink()) {
        const target = await realpath(absolute)
        if (!isInside(resolvedRoot, target)) continue
        const targetInfo = await stat(target)
        if (targetInfo.isDirectory()) await visit(target, relative)
        else if (targetInfo.isFile()) await addFile(target, relative, targetInfo.mode)
        continue
      }
      if (info.isDirectory()) {
        await visit(absolute, relative)
        continue
      }
      if (info.isFile()) await addFile(absolute, relative, info.mode)
    }
  }

  const addFile = async (absolute: string, relative: string, mode: number): Promise<void> => {
    const bytes = await readFile(absolute)
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`skill file is larger than ${MAX_FILE_BYTES} bytes`)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_BUNDLE_BYTES) throw new Error(`skill bundle is larger than ${MAX_BUNDLE_BYTES} bytes`)
    if (files.length >= MAX_BUNDLE_FILES) throw new Error(`skill bundle contains more than ${MAX_BUNDLE_FILES} files`)
    files.push({
      path: relative,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mode: mode & 0o777,
    })
  }

  await visit(resolvedRoot, '')
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

/** The two provider-owned roots Manor imports from. Its own runtime home is not one. */
export const defaultSkillRoots = (home: string): SkillRoot[] => [
  { source: 'claude', path: path.join(home, '.claude', 'skills') },
  { source: 'codex', path: path.join(home, '.codex', 'skills') },
]

const cleanScalar = (value: string): string => {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/**
 * Reads only the two frontmatter fields the registry needs. This is intentionally a
 * small YAML reader, not a second config language. Block scalar descriptions cover
 * the shape used by local skills, and the remaining frontmatter is metadata only.
 */
export function parseSkillDocument(raw: string, slug: string): Omit<SkillConfig, 'sources'> | null {
  const normalised = raw.replace(/\r\n/g, '\n')
  let body = normalised.trim()
  let name = slug
  let description = ''

  if (normalised.startsWith('---\n')) {
    const close = normalised.indexOf('\n---', 4)
    if (close !== -1) {
      const header = normalised.slice(4, close)
      body = normalised.slice(close + 4).replace(/^\n/, '').trim()
      const lines = header.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        const field = /^(name|description):\s*(.*)$/.exec(line)
        if (field === null) continue
        const key = field[1]
        let value = field[2] ?? ''
        if (value === '>' || value === '|') {
          const block: string[] = []
          while (index + 1 < lines.length && /^\s+/.test(lines[index + 1] ?? '')) {
            index += 1
            block.push((lines[index] ?? '').trim())
          }
          value = value === '>' ? block.join(' ') : block.join('\n')
        }
        if (key === 'name' && cleanScalar(value) !== '') name = cleanScalar(value)
        if (key === 'description') description = cleanScalar(value)
      }
    }
  }

  if (body.length === 0 || body.length > MAX_INSTRUCTIONS) return null
  return {
    id: slug,
    name: name.slice(0, 120),
    description: description.slice(0, 500),
    instructions: body,
  }
}

interface ReadSkill {
  realPath: string
  slug: string
  parsed: Omit<SkillConfig, 'sources'>
  files: SkillBundleFile[]
  revision: string
  bundleBytes: number
}

async function readSkillFolder(folder: string, slug: string): Promise<ReadSkill | null> {
  if (!VALID_SLUG.test(slug)) return null
  try {
    const folderStat = await stat(folder)
    if (!folderStat.isDirectory()) return null
    const skillPath = path.join(folder, SKILL_FILE)
    const [resolved, raw, files] = await Promise.all([
      realpath(skillPath),
      readFile(skillPath, 'utf8'),
      readBundle(folder),
    ])
    const parsed = parseSkillDocument(raw, slug)
    if (parsed === null) return null
    if (!files.some((file) => file.path === SKILL_FILE)) return null
    const revision = createHash('sha256')
    for (const file of files) revision.update(file.path).update('\0').update(file.sha256).update('\0').update(String(file.mode)).update('\0')
    return {
      realPath: resolved,
      slug,
      parsed,
      files,
      revision: revision.digest('hex'),
      bundleBytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    }
  } catch {
    // A provider folder is optional and may contain a broken symlink. Discovery is a
    // catalogue, so one unreadable entry disappears instead of taking the server down.
    return null
  }
}

/**
 * Scans immediate skill folders, follows symlinks, and collapses identical documents
 * across Claude and Codex. Paths never leave this module.
 */
export async function discoverSkills(roots: readonly SkillRoot[]): Promise<DiscoveredSkill[]> {
  const byRealPath = new Map<string, ReadSkill>()
  const found: { source: SkillSource; read: ReadSkill }[] = []

  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const folder = path.join(root.path, entry.name)
      let read = [...byRealPath.values()].find((skill) => skill.realPath === folder)
      if (read === undefined) {
        read = await readSkillFolder(folder, entry.name) ?? undefined
        if (read === undefined) continue
        const cached = byRealPath.get(read.realPath)
        if (cached !== undefined) read = cached
        else byRealPath.set(read.realPath, read)
      }
      found.push({ source: root.source, read })
    }
  }

  const grouped = new Map<string, DiscoveredSkill>()
  for (const { source, read } of found) {
    const contentHash = createHash('sha256')
      .update(read.slug)
      .update('\0')
      .update(read.parsed.name)
      .update('\0')
      .update(read.parsed.description)
      .update('\0')
      .update(read.revision)
      .digest('hex')
    const candidateId = `skill_${contentHash}`
    const existing = grouped.get(candidateId)
    if (existing !== undefined) {
      if (!existing.candidate.sources.includes(source)) {
        existing.candidate.sources.push(source)
        existing.skill.sources.push(source)
      }
      existing.candidate.hasSupportingFiles ||= read.files.length > 1
      continue
    }
    const sources = [source]
    grouped.set(candidateId, {
      candidate: {
        candidateId,
        slug: read.slug,
        name: read.parsed.name,
        description: read.parsed.description,
        sources,
        hasSupportingFiles: read.files.length > 1,
        fileCount: read.files.length,
        bundleBytes: read.bundleBytes,
      },
      skill: {
        ...read.parsed,
        sources: [...sources],
        bundleRevision: read.revision,
        fileCount: read.files.length,
        bundleBytes: read.bundleBytes,
      },
      files: read.files,
    })
  }

  return [...grouped.values()].sort((left, right) =>
    left.candidate.name.localeCompare(right.candidate.name, 'en', { sensitivity: 'base' }),
  )
}
