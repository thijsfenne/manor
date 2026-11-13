import type { AgentConfig, SkillConfig } from '@manor/contracts'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

export interface SkillUsage {
  count: number
  lastUsedAt?: string
}

export type SkillUsageDriver = Exclude<AgentConfig['driver'], 'mock'>

const LastUsedAtSchema = z.string().datetime({ offset: true })
const writes = new Map<string, Promise<void>>()

export const defaultSkillUsagePath = (home: string): string =>
  path.join(home, '.manor', 'skill-usage.json')

/**
 * Reads only the aggregate count and last-used timestamp from Manor's host-local
 * sidecar. Provider detail stays private to the host and out of registry state.
 */
export async function readSkillUsage(
  usagePath: string,
): Promise<ReadonlyMap<string, SkillUsage> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(usagePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

    const usage = new Map<string, SkillUsage>()
    for (const [skillId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const count = Reflect.get(value, 'count')
      if (!Number.isSafeInteger(count) || count < 0) continue
      const lastUsed = LastUsedAtSchema.safeParse(Reflect.get(value, 'last_used'))
      usage.set(skillId, {
        count,
        ...(lastUsed.success ? { lastUsedAt: lastUsed.data } : {}),
      })
    }
    return usage
  } catch {
    // The sidecar is optional and writes atomically. Missing or temporarily unreadable
    // telemetry means "unavailable", never a server or Skills-screen failure.
    return null
  }
}

interface UsageEntry {
  count: number
  first_used: string
  last_used: string
  by_driver: Partial<Record<SkillUsageDriver, number>>
}

const safeCount = (value: unknown): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0

const entryFrom = (value: unknown, usedAt: string): UsageEntry => {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const rawDrivers = typeof record['by_driver'] === 'object' && record['by_driver'] !== null
    ? record['by_driver'] as Record<string, unknown>
    : {}
  return {
    count: safeCount(record['count']),
    first_used: LastUsedAtSchema.safeParse(record['first_used']).success
      ? String(record['first_used'])
      : usedAt,
    last_used: usedAt,
    by_driver: {
      claude: safeCount(rawDrivers['claude']),
      codex: safeCount(rawDrivers['codex']),
      grok: safeCount(rawDrivers['grok']),
      cursor: safeCount(rawDrivers['cursor']),
    },
  }
}

async function writeSkillUsage(
  usagePath: string,
  skillIds: readonly string[],
  driver: SkillUsageDriver,
  usedAt: string,
): Promise<void> {
  let parsed: Record<string, unknown> = {}
  try {
    const raw: unknown = JSON.parse(await readFile(usagePath, 'utf8'))
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>
    }
  } catch {
    // A missing or corrupt optional sidecar starts fresh. Telemetry never owns the turn.
  }

  for (const skillId of new Set(skillIds)) {
    const entry = entryFrom(parsed[skillId], usedAt)
    entry.count += 1
    entry.by_driver[driver] = (entry.by_driver[driver] ?? 0) + 1
    parsed[skillId] = entry
  }

  const folder = path.dirname(usagePath)
  const temporary = path.join(folder, `.${path.basename(usagePath)}.${randomUUID()}.tmp`)
  await mkdir(folder, { recursive: true })
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    await rename(temporary, usagePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Counts one execution per activated skill and provider turn. Explicit activation is
 * known when its injected turn starts; implicit activation is known after SKILL.md was
 * read successfully. Writes for one host are serialised before the atomic rename so
 * simultaneous chats cannot lose an increment.
 */
export function recordSkillUsage(
  usagePath: string,
  skillIds: readonly string[],
  driver: AgentConfig['driver'],
  usedAt = new Date().toISOString(),
): Promise<void> {
  if (skillIds.length === 0 || driver === 'mock') return Promise.resolve()
  const previous = writes.get(usagePath) ?? Promise.resolve()
  const job = previous.catch(() => undefined).then(() =>
    writeSkillUsage(usagePath, skillIds, driver, usedAt),
  )
  writes.set(usagePath, job)
  void job.finally(() => {
    if (writes.get(usagePath) === job) writes.delete(usagePath)
  }).catch(() => undefined)
  return job
}

/** Adds wire-only telemetry without mutating the owned registry rows. */
export function withSkillUsage(
  skills: readonly SkillConfig[],
  usage: ReadonlyMap<string, SkillUsage> | null,
): SkillConfig[] {
  if (usage === null) return [...skills]
  return skills.map((skill) => {
    const found = usage.get(skill.id)
    return {
      ...skill,
      usageCount: found?.count ?? 0,
      ...(found?.lastUsedAt === undefined ? {} : { lastUsedAt: found.lastUsedAt }),
    }
  })
}
