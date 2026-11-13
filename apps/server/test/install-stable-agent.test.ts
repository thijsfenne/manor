import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('install-stable-agent', () => {
  it('writes an agent that only serves, so a failing build cannot loop it', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'manor-stable-agent-'))
    const script = fileURLToPath(new URL('../scripts/install-stable-agent.sh', import.meta.url))
    execFileSync('bash', [script], { env: { ...process.env, HOME: home } })
    const plist = readFileSync(path.join(home, 'Library/LaunchAgents/com.thijsfenne.manor.plist'), 'utf8')
    const args = [...(plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '')
      .matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1])
    // `stable:serve`, never `dev:stable`: the web build belongs in stable-restart.sh,
    // where a failure is seen and leaves the running server alone.
    expect(args.slice(1)).toEqual(['stable:serve'])
    const dirs = plist.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.split(':') ?? []
    expect(dirs.some((dir) => existsSync(path.join(dir, 'node')))).toBe(true)
    const repo = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${repo}</string>`)
  })
})
