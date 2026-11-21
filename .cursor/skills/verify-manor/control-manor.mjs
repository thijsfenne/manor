#!/usr/bin/env node
/**
 * Drive the isolated Manor spike only. Never 43179 (live) or 5173 (ordinary Vite).
 *
 *   node .cursor/skills/verify-manor/control-manor.mjs <command>
 *
 * One spike per Session: `launch` gives this Session its own port and keeps the spike
 * warm until `cleanup`, until the Session settles or is archived, or until the live
 * server's sweep finds it idle. A later `launch` rebuilds only what the tree changed.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chatRunning, describeAge, envOf, listCwds, resolveOwner, staleReason, staleVerdict, stopGroup } from './stale-run.mjs'

const SKILL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SKILL_DIR, '../../..')
const EVIDENCE_DIR = join(SKILL_DIR, 'evidence')
// 43182 is verify-manor-mobile's fixture server.
const PORTS = Array.from({ length: 20 }, (_, i) => 43180 + i).filter((port) => port !== 43182)
const FORBIDDEN = ['http://127.0.0.1:43179', 'http://localhost:43179', 'http://127.0.0.1:5173', 'http://localhost:5173']
// Inputs whose change means a rebuild (web) or a restart (server). Stat-only, so a check is cheap.
const WEB_INPUTS = ['apps/web', 'packages', 'pnpm-lock.yaml', 'package.json', 'tsconfig.base.json']
const SERVER_INPUTS = ['apps/server/src', 'apps/server/scripts', 'apps/server/sqlite', 'apps/server/package.json', 'apps/server/tsconfig.json', 'packages', 'pnpm-lock.yaml', 'package.json', 'tsconfig.base.json']
const UNWALKED = new Set(['node_modules', 'dist', '.mcp-build', 'data', '.git', '.review', '.impeccable'])

function fail(message) {
  console.error(message)
  process.exit(1)
}

function assertSafeOrigin(url) {
  const normalized = url.replace(/\/$/, '')
  if (FORBIDDEN.includes(normalized) || /:(43179|5173)$/.test(normalized)) {
    fail(`Refusing ${url}. Drive the spike only. Live Manor is 43179; ordinary Vite is 5173.`)
  }
}

const sessionPortFor = (port) => 9334 + port - 43180
const spikeData = (port) => (port === 43180 ? '/tmp/manor-electron-spike' : `/tmp/manor-electron-spike-${port}`)

const OWNER = resolveOwner()
const entryPath = (port) => join(OWNER.registryDir, `${port}.json`)
const ownedBy = (entry) => entry.chatId === OWNER.chatId && entry.repoRoot === REPO_ROOT

function readEntry(port) {
  try {
    return JSON.parse(readFileSync(entryPath(port), 'utf8'))
  } catch {
    return undefined
  }
}

// `pgids` is what the live server's sweep signals; it never reads the rest.
function saveEntry(entry) {
  const pgids = [entry.server?.pgid, entry.browser?.daemonPid, entry.browser?.browserPid].filter((pid) => Number.isInteger(pid) && pid > 1)
  writeFileSync(entryPath(entry.port), JSON.stringify({ ...entry, pgids }, null, 2) + '\n')
}

const pinnedPort = () => (process.env.MANOR_VERIFY_PORT ? Number(process.env.MANOR_VERIFY_PORT) : undefined)

function ownEntry() {
  mkdirSync(OWNER.registryDir, { recursive: true })
  const pinned = pinnedPort()
  if (pinned !== undefined) {
    if (!PORTS.includes(pinned)) fail(`MANOR_VERIFY_PORT must be one of ${PORTS.join(', ')}.`)
    const entry = readEntry(pinned)
    if (entry && !ownedBy(entry)) fail(`Port ${pinned} holds another Session's spike (${holderOf(entry)}), which is not stale. Leave MANOR_VERIFY_PORT unset to get a port of your own.`)
    return entry
  }
  for (const name of readdirSync(OWNER.registryDir)) {
    if (!/^\d+\.json$/.test(name)) continue
    const entry = readEntry(Number(name.slice(0, -5)))
    if (entry && ownedBy(entry)) return entry
  }
  return undefined
}

const holderOf = (entry) => `${entry.chatId ? `chat ${entry.chatId.slice(0, 8)}` : 'started by hand'}, ${entry.repoRoot}, ${describeAge(Date.now() - (entry.createdAt ?? entry.lastUsedAt ?? Date.now()))} old`

/** Spikes this launch stopped because their run was stale, for the launch report. */
const stoppedStale = []

/** Why another Session's spike is stale right now, or undefined. Reads the process list fresh every time. */
function staleNow(entry) {
  const now = Date.now()
  const ageMs = now - (entry.createdAt ?? entry.lastUsedAt ?? now)
  const ownerRunning = entry.chatId ? chatRunning(entry.chatId, dirname(OWNER.registryDir)) : null
  const verdict = staleVerdict({ ageMs, idleMs: now - (entry.lastUsedAt ?? now), ownerRunning, checkoutGone: !existsSync(entry.repoRoot) })
  return verdict === undefined ? undefined : { verdict, ageMs }
}

/**
 * Stops the spike another Session left on `port` when it is stale: over a day old, or its
 * owning chat has no running turn. It goes through the spike's own marker (stopSpike), the
 * same as its cleanup, and asks again right before every signal, so an owner that resumed
 * meanwhile keeps its spike. A spike that is not stale stays, and the answer names its owner.
 */
async function reclaimStale(port) {
  const entry = readEntry(port)
  if (!entry || ownedBy(entry)) return undefined
  const stale = staleNow(entry)
  if (stale === undefined) return holderOf(entry)
  const stillDue = () => {
    const latest = readEntry(port)
    return latest?.marker === entry.marker && staleNow(latest) !== undefined
  }
  if (!(await stopSpike(entry, stillDue))) return holderOf(readEntry(port) ?? entry)
  // The registration may have been replaced while the old groups wound down.
  if (readEntry(port)?.marker === entry.marker) unlinkSync(entryPath(port))
  const line = `Stopped the stale spike on ${port} (${holderOf(entry)}): ${staleReason(stale.verdict, stale.ageMs, entry.chatId)}.`
  stoppedStale.push(line)
  console.error(line)
  return undefined
}

/** Tries every port for a stale spike, once all are taken; answers who holds the ones that are not stale. */
async function freeStalePorts() {
  const holders = {}
  for (const port of PORTS) {
    const holder = await reclaimStale(port)
    if (holder !== undefined) holders[port] = holder
  }
  return holders
}

function portListening(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]
  } catch {
    return ''
  }
}

/** Claims a port by creating its entry file; undefined when someone else got there first. */
function claim(port) {
  const entry = { version: 1, port, chatId: OWNER.chatId, repoRoot: REPO_ROOT, marker: `${port}-${randomUUID().slice(0, 8)}`, createdAt: Date.now(), lastUsedAt: Date.now() }
  try {
    writeFileSync(entryPath(port), JSON.stringify(entry, null, 2) + '\n', { flag: 'wx' })
    return entry
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return undefined
  }
}

/** The pinned port, or the first one nobody registered or listens on; stale spikes are cleared only when none is left. */
async function claimPort() {
  const pinned = pinnedPort()
  if (pinned !== undefined) return claim(pinned) ?? fail(`Port ${pinned} was just claimed by another Session. Leave MANOR_VERIFY_PORT unset to get a port of your own.`)
  const firstFree = () => {
    for (const port of PORTS) {
      if (existsSync(entryPath(port)) || portListening(port) || portListening(sessionPortFor(port))) continue
      const entry = claim(port)
      if (entry) return entry
    }
    return undefined
  }
  const free = firstFree()
  if (free) return free
  const holders = await freeStalePorts()
  const cleared = firstFree()
  if (cleared) return cleared
  const held = Object.entries(holders).map(([port, who]) => `  ${port}: ${who}`).join('\n')
  fail(`No free spike port in ${PORTS[0]}–${PORTS.at(-1)}. Their owners are alive, so none is stale:\n${held || '  (held by processes without a registry entry; run doctor)'}`)
}

async function httpCode(url) {
  try {
    const res = await fetch(url, { redirect: 'manual' })
    return res.status
  } catch {
    return 0
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Signals a group only while one of its members still carries this spike's marker. */
const stopMarked = (pgid, marker, allowed) => stopGroup(pgid, (env) => env.includes(`MANOR_VERIFY_SPIKE=${marker}`), allowed)

function fingerprint(inputs) {
  const hash = createHash('sha1')
  const walk = (rel) => {
    const abs = join(REPO_ROOT, rel)
    let stat
    try { stat = statSync(abs) } catch { return }
    if (stat.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (!UNWALKED.has(name)) walk(join(rel, name))
      }
    } else if (!/\.test\.[cm]?[jt]sx?$/.test(rel)) {
      hash.update(`${rel}\0${stat.size}\0${stat.mtimeMs}\n`)
    }
  }
  for (const input of inputs) walk(input)
  return hash.digest('hex')
}

// The server start script loads apps/server/.env, which holds live mail, calendar,
// Composio, Supabase and vault settings. A variable already set in the environment wins
// over the file, so every key it names is passed in empty: a drafted mail's Submit then
// fails as unavailable instead of sending from the maintainer's account. Names only, never values.
function blankedServerEnv() {
  const file = join(REPO_ROOT, 'apps/server/.env')
  if (!existsSync(file)) return {}
  const names = readFileSync(file, 'utf8').split('\n')
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
    .filter(Boolean)
  return Object.fromEntries(names.map((name) => [name, '']))
}

function fixtureVault() {
  const dir = process.env.MANOR_VERIFY_VAULT_DIR
  if (dir === undefined || dir === '') return undefined
  // Canonical containment: `/tmp/../Users/…` or a symlink out of /tmp must not pass.
  const tmp = realpathSync('/tmp')
  const real = existsSync(dir) ? realpathSync(dir) : ''
  if (!real.startsWith(`${tmp}/`)) fail('MANOR_VERIFY_VAULT_DIR must be an existing fixture folder under /tmp.')
  return real
}

// The calling turn's per-turn capability tokens belong to the live server, never the spike.
function callerEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.includes('CAPABILITY')))
}

function serverEnv(entry) {
  const vault = fixtureVault()
  const home = join(spikeData(entry.port), 'home')
  return {
    ...callerEnv(),
    ...blankedServerEnv(),
    // The memory store sweeps `~/.manor/scratch` under its HOME at startup; on the real
    // HOME that deletes every live chat's scratch folder. The spike gets its own.
    HOME: home,
    // Corepack caches pnpm under HOME; the spike HOME has none and its download fails.
    COREPACK_HOME: process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack'),
    // A stand-in Tailscale CLI comes first, so Settings → Phone never touches the real tailnet.
    PATH: [join(SKILL_DIR, 'stubs/bin'), process.env.PATH].filter(Boolean).join(':'),
    MANOR_STORE: 'memory',
    MANOR_AUTH: 'off',
    MANOR_DRIVER: 'mock',
    MANOR_DATA_DIR: spikeData(entry.port),
    MANOR_HOST: '127.0.0.1',
    MANOR_PORT: String(entry.port),
    MANOR_WEB_DIST: join(runDir(entry.port), 'web-dist'),
    MANOR_VERIFY_SPIKE: entry.marker,
    // `clock --days-ago` writes this file; the preloaded stub reads it, see `stubs/server-clock.mjs`.
    MANOR_VERIFY_CLOCK: clockFile(entry.port),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${join(SKILL_DIR, 'stubs/server-clock.mjs')}`].filter(Boolean).join(' '),
    // The server's own default is `auto`. The spike proves UI on a mock driver, so it
    // never asks unless a proof says otherwise.
    MANOR_EFFECT_MODE: process.env.MANOR_EFFECT_MODE ?? 'full-access',
    // A fixture vault for Knowledge and search proofs, never the real one: only /tmp.
    ...(vault === undefined ? {} : { MANOR_VAULT_DIR: vault }),
  }
}

const runDir = (port) => join(SKILL_DIR, '.run', String(port))
const clockFile = (port) => join(runDir(port), 'clock')

// What a running server was started from. Code is checked before every drive command;
// settings (a launch-only `MANOR_EFFECT_MODE`, say) only decide a restart on launch.
const serverCode = () => fingerprint(SERVER_INPUTS)
function serverSettings(entry) {
  const env = serverEnv(entry)
  const settings = Object.keys(env).filter((key) => key.startsWith('MANOR_') || key in blankedServerEnv()).sort().map((key) => `${key}=${env[key]}`).join('\n')
  return createHash('sha1').update(settings).digest('hex')
}

const webFingerprint = () => fingerprint(WEB_INPUTS)

function daemonFingerprint() {
  const script = process.env.MANOR_VERIFY_INIT_SCRIPT
  if (!script) return 'none'
  const stat = existsSync(script) ? statSync(script) : undefined
  return `${resolve(script)}:${stat?.size}:${stat?.mtimeMs}`
}

// Same build as `vite build`, run in this process: no pnpm start-up, no gzip report.
async function buildWeb(entry) {
  const web = join(REPO_ROOT, 'apps/web')
  const viteRoot = dirname(createRequire(join(web, 'package.json')).resolve('vite/package.json'))
  const { build } = await import(pathToFileURL(join(viteRoot, 'dist/node/index.js')).href)
  Object.assign(process.env, { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_MANOR_WS: '', VITE_MANOR_AUTH: 'off' })
  await build({
    root: web,
    configFile: join(web, 'vite.config.ts'),
    logLevel: 'error',
    build: { outDir: join(runDir(entry.port), 'web-dist'), emptyOutDir: true, reportCompressedSize: false },
  })
}

async function waitForOrigin(origin, timeoutMs = 180_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if ((await httpCode(origin)) === 200) return
    await sleep(100)
  }
  fail(`Spike at ${origin} did not answer 200 within ${timeoutMs}ms`)
}

async function startServer(entry) {
  const origin = `http://127.0.0.1:${entry.port}`
  if (portListening(entry.port)) fail(`Port ${entry.port} is taken by a process this spike did not start. Refusing to drive it.`)
  mkdirSync(join(spikeData(entry.port), 'home'), { recursive: true })
  const code = serverCode()
  const settings = serverSettings(entry)
  const child = spawn('pnpm', ['--filter', '@manor/server', 'start'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    env: serverEnv(entry),
  })
  child.unref()
  // Registered before the wait, so a server that never answers is still ours to stop.
  // The prints are taken before the spawn: an edit during start-up then reads as stale.
  entry.server = { pgid: child.pid, pid: child.pid, code, settings }
  saveEntry(entry)
  await waitForOrigin(origin)
  entry.server.pid = Number(portListening(entry.port) || child.pid)
}

async function startBrowser(entry) {
  const dir = runDir(entry.port)
  const ready = join(dir, 'session.ready')
  if (existsSync(ready)) unlinkSync(ready)
  const child = spawn(process.execPath, [join(SKILL_DIR, 'session-daemon.mjs')], {
    cwd: SKILL_DIR,
    detached: true,
    stdio: 'ignore',
    env: {
      ...callerEnv(),
      MANOR_VERIFY_ORIGIN: `http://127.0.0.1:${entry.port}`,
      MANOR_VERIFY_SESSION_PORT: String(sessionPortFor(entry.port)),
      MANOR_VERIFY_READY: ready,
      MANOR_VERIFY_SPIKE: entry.marker,
    },
  })
  child.unref()
  entry.browser = { daemonPid: child.pid, sessionPort: sessionPortFor(entry.port), fingerprint: '' }
  saveEntry(entry)
  const start = Date.now()
  while (Date.now() - start < 45_000 && !existsSync(ready)) await sleep(100)
  if (!existsSync(ready)) fail('Session daemon did not become ready (Destinations rail never appeared)')
  const { pid, port, browserPid } = JSON.parse(readFileSync(ready, 'utf8'))
  entry.browser = { daemonPid: pid, browserPid, sessionPort: port, fingerprint: daemonFingerprint() }
}

async function daemon(entry, cmd, flags = {}) {
  const res = await fetch(`http://127.0.0.1:${entry.browser.sessionPort}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, flags }),
  })
  return res.json()
}

const serverUp = async (entry) => Boolean(entry.server) && pidAlive(entry.server.pid) && (await httpCode(`http://127.0.0.1:${entry.port}`)) === 200
const browserUp = async (entry) => Boolean(entry.browser) && pidAlive(entry.browser.daemonPid) && (await httpCode(`http://127.0.0.1:${entry.browser.sessionPort}/`)) === 200

/** Answers false when `allowed` refused a signal, so the caller keeps the spike's entry. */
async function stopSpike(entry, allowed) {
  const groups = [entry.browser?.daemonPid, entry.browser?.browserPid, entry.server?.pgid]
  for (const pgid of groups) {
    if (pgid !== undefined && !(await stopMarked(pgid, entry.marker, allowed))) return false
  }
  return true
}

const elapsed = (start) => `${((performance.now() - start) / 1000).toFixed(1)}s`

async function cmdLaunch(flags) {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  // A pinned port another Session's spike holds is the one blocker launch can name up front.
  if (pinnedPort() !== undefined) await reclaimStale(pinnedPort())
  let entry = ownEntry() ?? (await claimPort())
  const origin = `http://127.0.0.1:${entry.port}`
  assertSafeOrigin(origin)
  mkdirSync(runDir(entry.port), { recursive: true })
  if (flags.fresh) {
    await stopSpike(entry)
    rmSync(clockFile(entry.port), { force: true })
    entry = { ...entry, server: undefined, browser: undefined }
  }
  entry.lastUsedAt = Date.now()
  saveEntry(entry)
  const report = {}

  const webPrint = webFingerprint()
  if (entry.web?.fingerprint === webPrint && existsSync(join(runDir(entry.port), 'web-dist/index.html'))) {
    report.web = 'unchanged'
  } else {
    const start = performance.now()
    await buildWeb(entry)
    entry.web = { fingerprint: webPrint }
    report.web = `rebuilt ${elapsed(start)}`
  }
  saveEntry(entry)

  if ((await serverUp(entry)) && entry.server.code === serverCode() && entry.server.settings === serverSettings(entry)) {
    report.server = 'reused'
  } else {
    const start = performance.now()
    const restart = Boolean(entry.server)
    if (entry.server) await stopMarked(entry.server.pgid, entry.marker)
    entry.server = undefined
    saveEntry(entry)
    await startServer(entry)
    report.server = `${restart ? 'restarted' : 'started'} ${elapsed(start)}`
  }
  saveEntry(entry)

  // A reused browser reloads the origin, so a rebuilt SPA or restarted server shows.
  const reuse = (await browserUp(entry)) && entry.browser.fingerprint === daemonFingerprint()
  const start = performance.now()
  if (reuse && (await daemon(entry, 'reset')).ok) {
    report.browser = `reloaded ${elapsed(start)}`
  } else {
    if (entry.browser) {
      await stopMarked(entry.browser.daemonPid, entry.marker)
      await stopMarked(entry.browser.browserPid, entry.marker)
    }
    await startBrowser(entry)
    report.browser = `started ${elapsed(start)}`
  }
  entry.lastUsedAt = Date.now()
  saveEntry(entry)
  console.log(JSON.stringify({ ok: true, origin, chat: OWNER.chatId, ...(stoppedStale.length === 0 ? {} : { stoppedStale }), ...report }, null, 2))
}

/** The spike this Session launched, still current with the tree it was built from. */
async function liveEntry() {
  const entry = ownEntry()
  if (!entry?.browser) fail('No spike for this Session. Run launch first.')
  if (!(await browserUp(entry))) fail('This Session\'s spike is down (stopped as idle, or its Session settled). Run launch again.')
  if (entry.web?.fingerprint !== webFingerprint() || entry.server?.code !== serverCode()) {
    fail('The code changed since launch. Run launch again; it rebuilds only what changed.')
  }
  entry.lastUsedAt = Date.now()
  saveEntry(entry)
  return entry
}

async function session(cmd, flags = {}) {
  const entry = await liveEntry()
  const dest = flags.path ? resolve(String(flags.path)) : undefined
  if (dest) mkdirSync(dirname(dest), { recursive: true })
  const body = await daemon(entry, cmd, { ...flags, ...(dest ? { path: dest } : {}) })
  if (!body.ok) fail(body.error ?? `Session command ${cmd} failed`)
  return body
}

async function cmdDoctor() {
  const entry = ownEntry()
  const live = await httpCode('http://127.0.0.1:43179')
  if (!entry?.server) fail(`Doctor: no spike for this Session yet. Run launch.\n${JSON.stringify({ chat: OWNER.chatId, registry: OWNER.registryDir, live43179Http: live }, null, 2)}`)
  const origin = `http://127.0.0.1:${entry.port}`
  const spike = await httpCode(origin)
  const report = {
    origin,
    chat: OWNER.chatId,
    spikeHttp: spike,
    live43179Http: live,
    sessionHttp: entry.browser ? await httpCode(`http://127.0.0.1:${entry.browser.sessionPort}/`) : 0,
    spikeProcess: envOf(entry.server.pid).includes(`MANOR_VERIFY_SPIKE=${entry.marker}`),
    webCurrent: entry.web?.fingerprint === webFingerprint(),
    serverCurrent: entry.server.code === serverCode(),
    dataDir: spikeData(entry.port),
    registry: entryPath(entry.port),
    forbidden: FORBIDDEN,
  }
  if (spike !== 200) fail(`Doctor failed: spike ${origin} returned ${spike}\n${JSON.stringify(report, null, 2)}`)
  if (!report.spikeProcess) fail(`Doctor failed: ${entry.port} is not this Session's spike\n${JSON.stringify(report, null, 2)}`)
  console.log(JSON.stringify({ ok: true, ...report }, null, 2))
}

// How far behind the spike server's clock runs, for events that must read as older.
async function cmdClock() {
  const entry = await liveEntry()
  const days = Number(flags['days-ago'])
  if (!Number.isFinite(days) || days < 0) fail('clock takes --days-ago <number>; 0 puts the clock back.')
  writeFileSync(clockFile(entry.port), `${days}\n`)
  // The server reads the file at most four times a second.
  await sleep(400)
  console.log(JSON.stringify({ ok: true, daysAgo: days }))
}

async function cmdCleanup() {
  const entry = ownEntry()
  if (entry) {
    await stopSpike(entry)
    if (existsSync(entryPath(entry.port))) unlinkSync(entryPath(entry.port))
  }
  console.log(JSON.stringify({ ok: true, stopped: entry?.port ?? null, evidenceKept: EVIDENCE_DIR }))
}

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    flags[name] = value
  }
  return flags
}

const [command, ...rest] = process.argv.slice(2)
const flags = parseFlags(rest)
if (process.env.MANOR_VERIFY_PORT) assertSafeOrigin(`http://127.0.0.1:${process.env.MANOR_VERIFY_PORT}`)

const passthrough = (cmd) => async () => {
  const result = await session(cmd, flags)
  // A snapshot without --path prints the tree itself, ready to grep.
  if (typeof result.text === 'string') console.log(result.text)
  else {
    const { ok: _ok, ...rest } = result
    console.log(JSON.stringify({ ok: true, ...rest }))
  }
}

const commands = {
  launch: () => cmdLaunch(flags),
  doctor: cmdDoctor,
  home: passthrough('home'),
  open: passthrough('open'),
  snapshot: passthrough('snapshot'),
  screenshot: passthrough('screenshot'),
  click: passthrough('click'),
  fill: passthrough('fill'),
  type: passthrough('type'),
  press: passthrough('press'),
  'wait-settle': passthrough('wait-settle'),
  resize: passthrough('resize'),
  wheel: passthrough('wheel'),
  drag: passthrough('drag'),
  'drop-files': passthrough('drop-files'),
  hover: passthrough('hover'),
  attach: passthrough('attach'),
  scheme: passthrough('scheme'),
  clock: cmdClock,
  cleanup: cmdCleanup,
}

if (!command || !commands[command]) {
  fail(`Unknown command ${command ?? '(none)'}. Use launch|doctor|home|open|snapshot|screenshot|click|hover|fill|attach|type|press|wheel|drag|drop-files|resize|scheme|clock|wait-settle|cleanup`)
}

await commands[command]()
