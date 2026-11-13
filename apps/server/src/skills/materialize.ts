import type { SkillConfig } from '@manor/contracts'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SkillBundleFile, Store } from '../store.js'

/** The one persistence call materialisation needs; the full Store satisfies it. */
type SkillBundleSource = Pick<Store, 'loadSkillBundle'>

const COMPLETE = '.manor-bundle-complete'
const inFlight = new Map<string, Promise<string | undefined>>()

export function validBundlePath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || path.posix.isAbsolute(value)) return false
  const normal = path.posix.normalize(value)
  return normal === value && normal !== '..' && !normal.startsWith('../') && !normal.split('/').includes('')
}

function verifyBundle(skill: SkillConfig, files: readonly SkillBundleFile[]): void {
  if (files.length !== (skill.fileCount ?? 0)) {
    throw new Error(`skill $${skill.id} bundle is incomplete`)
  }
  for (const file of files) {
    if (!validBundlePath(file.path)) throw new Error(`skill $${skill.id} has an unsafe bundle path`)
    const digest = createHash('sha256').update(file.bytes).digest('hex')
    if (digest !== file.sha256) throw new Error(`skill $${skill.id} bundle failed its integrity check`)
  }
}

async function materializeOne(store: SkillBundleSource, skill: SkillConfig, cacheRoot: string): Promise<string | undefined> {
  const revision = skill.bundleRevision
  if (revision === undefined || (skill.fileCount ?? 0) === 0) return undefined
  const skillRoot = path.join(cacheRoot, skill.id)
  const target = path.join(skillRoot, revision)
  const marker = path.join(target, COMPLETE)
  try {
    await access(marker)
    return target
  } catch {
    // A missing marker means the cache is absent or was interrupted halfway through.
  }

  const files = await store.loadSkillBundle(skill.id)
  verifyBundle(skill, files)
  await mkdir(skillRoot, { recursive: true })
  const temporary = path.join(skillRoot, `${revision}.tmp-${randomUUID()}`)
  try {
    for (const file of files) {
      const destination = path.join(temporary, ...file.path.split('/'))
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, file.bytes)
      await chmod(destination, file.mode)
    }
    await writeFile(path.join(temporary, COMPLETE), `${revision}\n`)
    // Cache only. An unmarked target is an interrupted materialisation and safe to
    // replace; source-of-truth bytes remain in private Storage.
    await rm(target, { recursive: true, force: true })
    await rename(temporary, target)
    return target
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** Materialises each selected bundle once and returns roots keyed by `$slug`. */
export async function materializeSkills(
  store: SkillBundleSource,
  skills: readonly SkillConfig[],
  cacheRoot: string,
): Promise<Map<string, string>> {
  const roots = new Map<string, string>()
  for (const skill of skills) {
    const key = `${cacheRoot}\0${skill.id}\0${skill.bundleRevision ?? 'legacy'}`
    let job = inFlight.get(key)
    if (job === undefined) {
      job = materializeOne(store, skill, cacheRoot)
      inFlight.set(key, job)
      const clear = () => {
        if (inFlight.get(key) === job) inFlight.delete(key)
      }
      void job.then(clear, clear)
    }
    const root = await job
    if (root !== undefined) roots.set(skill.id, root)
  }
  return roots
}
