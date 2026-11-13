import { createHash, randomBytes } from 'node:crypto'
import { rekeyEntry, type RekeyResult } from './capabilityRekey.js'
import type { SkillBundleFile } from './store.js'
import { validBundlePath } from './skills/materialize.js'

export const SKILL_READ_CALL_LIMIT = 100
export const MAX_SKILL_READ_CHARS = 200_000
export const MAX_SKILL_CAPABILITY_CACHED_BYTES = 25 * 1024 * 1024

interface Capability {
  skillIds: ReadonlySet<string>
  onSkillRead: (skillId: string) => void
  bundles: Map<string, Promise<ReadonlyMap<string, SkillBundleFile>>>
  cachedBytes: number
  calls: number
}

export interface SkillReadResult {
  skillId: string
  path: string
  content: string
  offset: number
  nextOffset?: number
  totalChars: number
}

export class InvalidSkillCapabilityError extends Error {}

export function legacySkillInstructionsBundle(instructions: string): readonly SkillBundleFile[] {
  const bytes = new TextEncoder().encode(instructions)
  return [{
    path: 'SKILL.md',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mode: 0o600,
  }]
}

export function readableSkillBundleLoader(
  loadBundle: (skillId: string) => Promise<readonly SkillBundleFile[]>,
  findLegacySkill: (skillId: string) => { instructions: string } | undefined,
): (skillId: string) => Promise<readonly SkillBundleFile[]> {
  return async (skillId) => {
    const bundle = await loadBundle(skillId)
    if (bundle.length > 0) return bundle
    const legacy = findLegacySkill(skillId)
    return legacy === undefined ? [] : legacySkillInstructionsBundle(legacy.instructions)
  }
}

/**
 * A turn-scoped capability, valid until the turn revokes it, fixes the readable skill ids outside model-controlled input.
 * The MCP child sends only a skill id and relative manifest path; neither can widen
 * the set captured here for this persona turn. Bytes come from the owned store, never
 * the shared materialisation cache.
 */
export class SkillCapabilities {
  private readonly entries = new Map<string, Capability>()
  /** Issued token to the token a live process holds it under, until the turn revokes it. */
  private readonly rekeyed = new Map<string, string>()

  constructor(
    private readonly loadBundle: (skillId: string) => Promise<readonly SkillBundleFile[]>,
    private readonly maxCachedBytes = MAX_SKILL_CAPABILITY_CACHED_BYTES,
  ) {}

  issue(
    skillIds: readonly string[],
    onSkillRead: (skillId: string) => void,
    token = randomBytes(32).toString('hex'),
  ): string {
    this.entries.set(token, {
      skillIds: new Set(skillIds),
      onSkillRead,
      bundles: new Map(),
      cachedBytes: 0,
      calls: 0,
    })
    return token
  }

  revoke(token: string): void {
    // A turn revokes the token it was issued, which a live process may since hold under another.
    const key = this.rekeyed.get(token) ?? token
    this.rekeyed.delete(token)
    const capability = this.entries.get(key)
    capability?.bundles.clear()
    this.entries.delete(key)
  }

  /** Moves this capability to a token a live process holds; see `rekeyEntry`. */
  rekey(from: string, to: string): RekeyResult {
    const result = rekeyEntry(this.entries, from, to)
    if (result === 'rekeyed' && from !== to) this.rekeyed.set(from, to)
    return result
  }

  async read(
    token: string | undefined,
    skillId: string,
    relativePath: string,
    offset = 0,
  ): Promise<SkillReadResult> {
    if (token === undefined || token === '') throw new InvalidSkillCapabilityError()
    const capability = this.entries.get(token)
    if (capability === undefined) {
      this.entries.delete(token)
      throw new InvalidSkillCapabilityError()
    }
    if (capability.calls >= SKILL_READ_CALL_LIMIT) {
      throw new Error(`Skill read budget exhausted after ${SKILL_READ_CALL_LIMIT} calls.`)
    }
    if (!capability.skillIds.has(skillId) || !validBundlePath(relativePath)) {
      throw new InvalidSkillCapabilityError()
    }
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Skill read offset must be a non-negative integer.')

    capability.calls += 1
    const files = await this.verifiedBundle(capability, skillId)
    const current = this.entries.get(token)
    if (current !== capability) {
      if (current === capability) this.revoke(token)
      throw new InvalidSkillCapabilityError()
    }
    const file = files.get(relativePath)
    if (file === undefined) throw new InvalidSkillCapabilityError()
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
    } catch {
      throw new Error(`$${skillId}/${relativePath} is not a UTF-8 text file.`)
    }
    if (offset > content.length) throw new Error(`Skill read offset ${offset} is past the end of the file.`)
    const end = Math.min(content.length, offset + MAX_SKILL_READ_CHARS)
    const result: SkillReadResult = {
      skillId,
      path: relativePath,
      content: content.slice(offset, end),
      offset,
      ...(end < content.length ? { nextOffset: end } : {}),
      totalChars: content.length,
    }
    // SKILL.md is capped below one response by import, so this means the model
    // received the complete activation instructions rather than one arbitrary slice.
    if (relativePath === 'SKILL.md' && offset === 0 && end === content.length) {
      capability.onSkillRead(skillId)
    }
    return result
  }

  private verifiedBundle(
    capability: Capability,
    skillId: string,
  ): Promise<ReadonlyMap<string, SkillBundleFile>> {
    const cached = capability.bundles.get(skillId)
    if (cached !== undefined) return cached
    const loading = this.loadBundle(skillId).then((files) => {
      const verified = new Map<string, SkillBundleFile>()
      let bundleBytes = 0
      for (const file of files) {
        if (!validBundlePath(file.path) || verified.has(file.path)) {
          throw new Error(`Stored bundle for $${skillId} has an invalid manifest.`)
        }
        const digest = createHash('sha256').update(file.bytes).digest('hex')
        if (digest !== file.sha256) {
          throw new Error(`Stored bundle for $${skillId} failed its integrity check.`)
        }
        bundleBytes += file.bytes.byteLength
        verified.set(file.path, file)
      }
      if (capability.cachedBytes + bundleBytes > this.maxCachedBytes) {
        throw new Error(`Skill reader cache exceeds ${this.maxCachedBytes} bytes for this turn.`)
      }
      capability.cachedBytes += bundleBytes
      return verified
    })
    capability.bundles.set(skillId, loading)
    return loading
  }
}
