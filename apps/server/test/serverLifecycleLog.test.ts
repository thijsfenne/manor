import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

const mainUrl = new URL('../src/main.ts', import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../', mainUrl))

const gitHead = (cwd: string): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

it.each([
  { signal: 'SIGTERM', duringStartup: false },
  { signal: 'SIGINT', duringStartup: false },
  { signal: 'SIGTERM', duringStartup: true },
] as const)('logs start metadata and $signal with timestamp and uptime (startup=$duringStartup)', async ({ signal, duringStartup }) => {
  const home = await mkdtemp(path.join(tmpdir(), 'manor-lifecycle-log-'))
  // Bypass the real .env and give the mock server only disposable state. The settings
  // files are read while the modules load, before the server can catch a signal, so the
  // startup case sends its signal at the first thing the server says instead.
  const duringStart = `const say = console.log; console.log = (...words) => { say(...words); if (String(words[0]).includes(' starting ')) process.emit('${signal}') };`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `process.loadEnvFile = () => {}; ${duringStartup ? duringStart : ''} await import(${JSON.stringify(mainUrl.href)})`,
  ], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MANOR_DATA_DIR: home,
      MANOR_GLOBAL_CLAUDE_DIR: '',
      MANOR_MEMORY_DIR: '',
      MANOR_STORE: 'memory',
      MANOR_DRIVER: 'mock',
      MANOR_AUTH: 'off',
      MANOR_HOST: '127.0.0.1',
      MANOR_PORT: '0',
      MANOR_ROUTINES: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let errors = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { errors += chunk })
  const closed = once(child, 'close')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
  try {
    if (!duringStartup) {
      await vi.waitFor(() => {
        expect(child.exitCode, errors).toBeNull()
        expect(output, errors).toContain('[manor] listening on ')
      }, { timeout: 10_000 })
      expect(child.kill(signal)).toBe(true)
    }
    const [code, exitSignal] = await closed
    // The pre-commit hook runs this in a snapshot without .git, where the server logs `unknown` too.
    const commit = gitHead(repoRoot)
    const start = output.split('\n').find((line) => line.includes(' starting '))!
    expect(start).toMatch(/^\[manor\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z starting /)
    expect(start).toContain(`pid=${child.pid} ppid=${process.pid} commit=${commit}`)

    expect(exitSignal, errors).toBeNull()
    expect(code, errors).toBe(signal === 'SIGINT' ? 130 : 143)
    if (duringStartup) expect(output).not.toContain('[manor] listening on ')
    const stops = output.split('\n').filter((line) => line.includes(' stopping '))
    expect(stops).toHaveLength(1)
    expect(stops[0]).toMatch(new RegExp(`^\\[manor\\] \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z stopping pid=${child.pid} signal=${signal} uptime=\\d+\\.\\d{3}s$`))
    const uptime = Number(/uptime=([\d.]+)s/.exec(stops[0]!)![1])
    expect(uptime).toBeGreaterThan(0)
    const startTime = Date.parse(start.split(' ')[1]!)
    const stopTime = Date.parse(stops[0]!.split(' ')[1]!)
    expect(stopTime).toBeGreaterThanOrEqual(startTime)
    expect(uptime * 1_000).toBeGreaterThanOrEqual(stopTime - startTime)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    await rm(home, { recursive: true, force: true })
  }
}, 20_000)
