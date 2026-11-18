import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledServerEntry,
  bundledServerEnv,
  choosePort,
  loginShellPath,
  manorAnswers,
  waitForManor,
  startBundledServer,
  type BundledServer,
} from './bundledServer'

const roots: string[] = []
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-bundled-'))
  roots.push(dir)
  return dir
}
let running: BundledServer | undefined
let held: Server | undefined
afterEach(() => {
  running?.child.kill('SIGKILL')
  running = undefined
  held?.close()
  held = undefined
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the PATH a server started from Finder gets', () => {
  const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }

  it("takes the login shell's PATH, through whatever the profile prints around it", async () => {
    const asked: string[][] = []
    const found = await loginShellPath(env, '/Users/sam', async (shell, args) => {
      asked.push([shell, ...args])
      return 'Welcome back!\n__MANOR_PATH__/opt/homebrew/bin:/Users/sam/.nvm/bin:/usr/bin__MANOR_PATH__\n'
    })
    expect(found).toBe('/opt/homebrew/bin:/Users/sam/.nvm/bin:/usr/bin:/bin:/Users/sam/.local/bin:/usr/local/bin')
    expect(asked[0]?.slice(0, 2)).toEqual(['/bin/zsh', '-ilc'])
  })

  it('keeps what it was given, with the usual install folders, when the shell cannot be asked', async () => {
    const usual = '/usr/bin:/bin:/Users/sam/.local/bin:/opt/homebrew/bin:/usr/local/bin'
    expect(await loginShellPath(env, '/Users/sam', async () => { throw new Error('no shell') })).toBe(usual)
    expect(await loginShellPath(env, '/Users/sam', async () => 'nothing useful')).toBe(usual)
  })
})

describe('what the bundled server is started with', () => {
  it('runs as Node on this Mac only, with its files and the user data folder', () => {
    const started = bundledServerEnv({ env: { HOME: '/Users/sam', LANG: 'nl_NL.UTF-8' }, home: '/Users/sam', path: '/opt/homebrew/bin', port: 43179, resourcesPath: '/Applications/Manor.app/Contents/Resources' })
    expect(started).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1', PATH: '/opt/homebrew/bin', LANG: 'nl_NL.UTF-8',
      MANOR_HOST: '127.0.0.1', MANOR_PORT: '43179', MANOR_DATA_DIR: '/Users/sam/.manor',
      MANOR_WEB_DIST: '/Applications/Manor.app/Contents/Resources/web', MANOR_ROUTINES: 'on',
    })
    // Somebody who set these keeps them.
    expect(bundledServerEnv({ env: { MANOR_DATA_DIR: '/data', MANOR_ROUTINES: 'off' }, home: '/Users/sam', path: '', port: 1, resourcesPath: '/r' }))
      .toMatchObject({ MANOR_DATA_DIR: '/data', MANOR_ROUTINES: 'off' })
  })

  it('finds the bundle only where the app carries one', () => {
    const resources = temp()
    expect(bundledServerEntry(resources)).toBeNull()
    mkdirSync(path.join(resources, 'server', 'dist'), { recursive: true })
    writeFileSync(path.join(resources, 'server', 'dist', 'main.mjs'), '')
    expect(bundledServerEntry(resources)).toBe(path.join(resources, 'server', 'dist', 'main.mjs'))
  })

  it('takes another port when the usual one is in use', async () => {
    held = createServer()
    const taken = await new Promise<number>((resolve) => held!.listen(0, '127.0.0.1', () => resolve((held!.address() as { port: number }).port)))
    const chosen = await choosePort(taken)
    expect(chosen).not.toBe(taken)
    expect(chosen).toBeGreaterThan(0)
  })

  it('tells a Manor server from a port that is silent', async () => {
    expect(await manorAnswers('http://localhost:1', async () => new Response('ok'))).toBe(true)
    expect(await manorAnswers('http://localhost:1', async () => new Response('no', { status: 404 }))).toBe(false)
    expect(await manorAnswers('http://localhost:1', async () => { throw new Error('refused') })).toBe(false)
  })

  it('waits for a server that comes up late, and gives up on one that never does', async () => {
    let asked = 0
    const late = async () => (++asked < 3 ? Promise.reject(new Error('refused')) : new Response('ok'))
    expect(await waitForManor('http://localhost:1', 1_000, late, 1)).toBe(true)
    expect(asked).toBe(3)
    expect(await waitForManor('http://localhost:1', 20, async () => { throw new Error('refused') }, 5)).toBe(false)
  })
})

// The real bundle, built from the server package and started the way the app starts
// it, with this test's Node standing in for the app's own binary.
it('starts the bundled server on an empty home, waits until it answers, and stops it', async () => {
  const root = temp()
  const home = path.join(root, 'home')
  const resources = path.join(root, 'Resources')
  mkdirSync(home, { recursive: true })
  execFileSync(process.execPath, [path.resolve(__dirname, '../../server/scripts/build-bundle.mjs'), path.join(resources, 'server')], { stdio: 'ignore' })
  const port = await choosePort(0)

  running = await startBundledServer({
    entry: bundledServerEntry(resources)!,
    execPath: process.execPath,
    resourcesPath: resources,
    home,
    port,
    env: { PATH: process.env.PATH ?? '', HOME: home, SHELL: '/bin/sh', MANOR_DRIVER: 'mock' },
  })
  expect(running.origin).toBe(`http://localhost:${port}`)
  expect(await manorAnswers(running.origin)).toBe(true)
  // Its data went to the home folder it was given, and its output to the log Settings lists.
  expect(readFileSync(path.join(home, '.manor', 'local-access-token'), 'utf8').trim()).toHaveLength(43)
  expect(readFileSync(path.join(home, 'Library', 'Logs', 'manor.log'), 'utf8')).toContain('[manor]')

  const gone = new Promise((resolve) => running!.child.once('exit', resolve))
  running.stop()
  await gone
  expect(await manorAnswers(running.origin)).toBe(false)
}, 60_000)

it('says where to look when the server stops while starting', async () => {
  const root = temp()
  const entry = path.join(root, 'broken.mjs')
  writeFileSync(entry, 'process.exit(3)')
  await expect(startBundledServer({
    entry, execPath: process.execPath, resourcesPath: root, home: root, port: await choosePort(0),
    env: { PATH: process.env.PATH ?? '', SHELL: '/bin/sh' },
  })).rejects.toThrow(/stopped while starting \(exit 3\).*manor\.err\.log/)
})
