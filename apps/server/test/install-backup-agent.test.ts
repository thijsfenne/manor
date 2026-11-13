import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('install-backup-agent', () => {
  it('writes a PATH that contains node so launchd can run hermes pnpm', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'manor-backup-agent-'))
    const script = fileURLToPath(new URL('../scripts/install-backup-agent.sh', import.meta.url))
    execFileSync('bash', [script], { env: { ...process.env, HOME: home } })
    const plist = readFileSync(
      path.join(home, 'Library/LaunchAgents/com.thijsfenne.manor-backup.plist'),
      'utf8',
    )
    const match = plist.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/)
    expect(match?.[1]).toBeTruthy()
    const dirs = match?.[1]?.split(':') ?? []
    expect(dirs.some((dir) => existsSync(path.join(dir, 'node')))).toBe(true)
    // The package script, not tsx directly: that is what loads apps/server/.env.
    const args = [...(plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '')
      .matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1])
    expect(args.slice(1)).toEqual(['--filter', '@manor/server', 'backup:sqlite'])
    const repo = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${repo}</string>`)
  })
})
