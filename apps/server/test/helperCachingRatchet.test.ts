import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '../src')

/**
 * A one-shot helper (title, summary, trace, review) is a fresh process that sends one
 * request, so a cache write is paid and never read. Measured 2026-11-12 over 1,280
 * helper calls: 2% cache read, 1.44 times the raw prompt in weighted input. A job that
 * resumes a session or runs a tool loop keeps caching and is listed here.
 */
const KEEPS_CACHING = new Set([
  'composer.ts', // passes the flag through, starts no turn
  'subagents.ts', // a child runs a tool loop
  'drivers/sessionCompact.ts', // resumes the persona session
])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

it('turns prompt caching off on every one-shot infrastructure job', () => {
  const cached = sources(SRC)
    .filter((file) => !KEEPS_CACHING.has(path.relative(SRC, file)))
    .filter((file) => {
      const text = readFileSync(file, 'utf8')
      const jobs = text.match(/infrastructure: true,/g)?.length ?? 0
      return jobs > (text.match(/promptCaching: 'off',/g)?.length ?? 0)
    })
    .map((file) => `src/${path.relative(SRC, file)}`)
  expect(cached, `${cached.join('\n')}\nAdd promptCaching: 'off', or list the file in KEEPS_CACHING with the reason.`).toEqual([])
})
