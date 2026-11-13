import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '../src')

/**
 * Spreading the whole server env hands a child every secret the server loaded from
 * `apps/server/.env` (SMTP password, Supabase key, connector tokens). The 08-11 audit
 * removed it from the provider drivers; new code copied it back on 10-04. Existing
 * sites are counted, never added to: a new child takes `childProcessEnv` or
 * `upstreamProcessEnv` from `src/childEnv.ts` with only the keys it needs.
 */
const ALLOWED: Record<string, number> = {
  'workCompletion.ts': 1, // local git, GIT_CONFIG_GLOBAL cleared
  'worktree.ts': 1, // local git, GIT_CONFIG_GLOBAL cleared
  'drivers/mockDriver.ts': 1, // mock git in a scratch dir, never a provider
  'mcp/effectProxyMcp.ts': 2, // the broker child: its own env is already the narrowed one
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : []
  })
}

describe('child process environments', () => {
  it('adds no new spread of the full server env', () => {
    const found: Record<string, number> = {}
    for (const file of sources(SRC)) {
      const count = readFileSync(file, 'utf8').match(/\.\.\.process\.env\b/g)?.length ?? 0
      if (count > 0) found[path.relative(SRC, file)] = count
    }
    const added = Object.entries(found)
      .filter(([file, count]) => count > (ALLOWED[file] ?? 0))
      .map(([file, count]) => `src/${file} spreads process.env ${count}x (allowed ${ALLOWED[file] ?? 0})`)
    expect(added, `${added.join('\n')}\nBuild the child env with childProcessEnv() or upstreamProcessEnv() from src/childEnv.ts.`).toEqual([])
  })
})
