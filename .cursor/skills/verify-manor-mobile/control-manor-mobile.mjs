#!/usr/bin/env node
/**
 * Drive the isolated Manor iOS app on the Simulator.
 * Never live Manor (43179), never the desktop spike UI, never the maintainer's phone.
 *
 *   node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs <command>
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
  utimesSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { chatRunning, cwdOf, describeAge, envOf, groupMembers, parseElapsed, resolveOwner, staleReason, staleVerdict, stopGroup } from '../verify-manor/stale-run.mjs'
import { DEFAULT_IDLE_MS, DEFAULT_LEASE_PATH, DEFAULT_SHUTDOWN_IDLE_MS, DEFAULT_STALL_MS, addPids, alive, describeHolder, holderIdleMs, idleWatchVerdict, leaveQueue, markUse, processStart, readLease, release, tryAcquire, waitForLease, yieldIfIdle } from './lease.mjs'

const SKILL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SKILL_DIR, '../../..')
const RUN_DIR = join(SKILL_DIR, '.run')
const STATE_PATH = join(RUN_DIR, 'state.json')
const BUNDLE_ID = 'com.thijsfenne.manor'
const FIXTURE_PORT = Number(process.env.MANOR_MOBILE_VERIFY_PORT ?? 43182)
const FIXTURE_WS = process.env.MANOR_MOBILE_VERIFY_WS ?? `ws://127.0.0.1:${FIXTURE_PORT}/ws`
const METRO_PORT = 8088
// Optional. Unset, or a name this Mac does not have, picks an available iPhone instead.
const SIMULATOR_NAME = process.env.MANOR_MOBILE_VERIFY_SIMULATOR
const SIMULATOR_DEVICES = join(homedir(), 'Library/Developer/CoreSimulator/Devices')
// A cold Metro cache bundles in about 35s on this Mac; the budget leaves room for a slow disk.
const BUNDLE_TIMEOUT_MS = Number(process.env.MANOR_MOBILE_VERIFY_BUNDLE_TIMEOUT_MS ?? 240_000)
const RENDER_TIMEOUT_MS = Number(process.env.MANOR_MOBILE_VERIFY_RENDER_TIMEOUT_MS ?? 180_000)
const AUTH_ON = process.env.MANOR_MOBILE_VERIFY_AUTH === 'on'
// Visible once the first screen has rendered: the house chrome, or the gate when auth is on.
const READY_LABEL = AUTH_ON ? 'Welcome home' : 'Open menu'
// One run at a time owns the simulator and the fixed ports; another lease file is for testing the lease itself.
const LEASE_PATH = resolve(process.env.MANOR_MOBILE_VERIFY_LEASE ?? DEFAULT_LEASE_PATH)
/** A duration override from the environment; unset, blank, negative or not a number gives `fallback`. */
const envMs = (name, fallback) => {
  const ms = process.env[name]?.trim() ? Number(process.env[name]) : NaN
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback
}
// launch waits as long as the queue moves and gives up only after this long behind the same run.
const STALL_MS = envMs('MANOR_MOBILE_VERIFY_STALL_MS', DEFAULT_STALL_MS)
// A holder left undriven this long gives the simulator to a waiting launch, even while its chat works.
const IDLE_MS = envMs('MANOR_MOBILE_VERIFY_IDLE_MS', DEFAULT_IDLE_MS)
// A run undriven this long with nobody queued has its simulator, Metro and fixture shut down by its idle watch.
const SHUTDOWN_IDLE_MS = envMs('MANOR_MOBILE_VERIFY_SHUTDOWN_MS', DEFAULT_SHUTDOWN_IDLE_MS)
// The longest the idle watch sleeps, so it ends soon after its run is cleaned up or its checkout removed.
const WATCH_MAX_SLEEP_MS = 60_000
const MAC_BLOCKER =
  'blocked: this worker cannot run an iOS Simulator. Need a Mac cloud worker / private Mac worker (Xcode + Simulator). Linux, Expo web, and browser screenshots are not mobile proof.'

const FORBIDDEN_WS = [
  'ws://127.0.0.1:43179/ws',
  'ws://localhost:43179/ws',
  'wss://127.0.0.1:43179/ws',
]

function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}

function assertSafeWs(url = FIXTURE_WS) {
  const normalized = url.replace(/\/$/, '')
  if (FORBIDDEN_WS.includes(normalized) || /:(43179)(\/|$)/.test(normalized)) {
    fail(`Refusing ${url}. Never drive live Manor on 43179.`)
  }
  if (/tailnet\.ts\.net/i.test(normalized) || /^wss:\/\//i.test(normalized)) {
    fail(`Refusing ${url}. Never point verification at the maintainer's live Tailscale house.`)
  }
}

function loadState() {
  if (!existsSync(STATE_PATH)) return {}
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
}

function saveState(next) {
  mkdirSync(RUN_DIR, { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2) + '\n')
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

function isDarwin() {
  return process.platform === 'darwin'
}

function hasXcode() {
  try {
    execFileSync('xcrun', ['--find', 'simctl'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

async function wsProbe(url) {
  assertSafeWs(url)
  try {
    const wsMod = await import(join(SKILL_DIR, 'node_modules/ws/index.js'))
    const WebSocket = wsMod.default
    return await new Promise((resolvePromise) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        socket.terminate()
        resolvePromise({ ok: false, reason: 'timeout' })
      }, 2000)
      socket.on('open', () => {
        clearTimeout(timer)
        socket.close()
        resolvePromise({ ok: true, reason: 'open' })
      })
      socket.on('error', (err) => {
        clearTimeout(timer)
        resolvePromise({ ok: false, reason: err.message })
      })
    })
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

async function live43179() {
  try {
    const res = await fetch('http://127.0.0.1:43179/', { redirect: 'manual' })
    return res.status
  } catch {
    return 0
  }
}

function simctl(...args) {
  // stderr is piped so a probe like `get_app_container` on a missing app stays quiet; the thrown error carries it.
  return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * The simulator the drive commands act on: the one this run saved when it is booted, never a
 * different device. Without a saved one, `launch` may adopt any booted simulator (`adopt`).
 */
function bootedUdid({ adopt = false, only } = {}) {
  try {
    const devices = JSON.parse(simctl('list', 'devices', 'booted', '-j')).devices
    const booted = Object.values(devices).flat().filter((device) => device.state === 'Booted')
    if (only) return booted.find((device) => device.udid === only)?.udid ?? ''
    const saved = loadState().simulatorUdid
    if (saved && !adopt) return booted.find((device) => device.udid === saved)?.udid ?? ''
    return booted[0]?.udid ?? ''
  } catch {
    return ''
  }
}

function appInstalled(udid) {
  try {
    simctl('get_app_container', udid, BUNDLE_ID, 'data')
    return true
  } catch {
    return false
  }
}

/** Pids listening on a TCP port. Empty when nothing listens or `lsof` is missing. */
function portOwners(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

/** The run this launch belongs to, written into state.json with the first process it starts. */
function runIdentity() {
  const state = loadState()
  // A run from before markers that still has a live process stays unmarked: a marker on
  // only part of it would make cleanup skip the rest.
  if (state.runId || pidAlive(state.fixturePid) || pidAlive(state.metroPid)) return state
  const owner = resolveOwner()
  const identity = {
    runId: `mobile-${randomUUID().slice(0, 8)}`,
    chatId: owner.chatId,
    dataDir: dirname(owner.registryDir),
    repoRoot: REPO_ROOT,
    startedAt: Date.now(),
  }
  saveState({ ...state, ...identity })
  return { ...state, ...identity }
}

const MARKER_VAR = 'MANOR_VERIFY_MOBILE'
const OWNER_VAR = 'MANOR_VERIFY_MOBILE_CHAT'

/**
 * What every process of a run carries in its environment: the run, and the chat that owns
 * it. They outlive the checkout, so a run whose worktree was removed can still be judged.
 */
const runMarks = ({ runId, chatId }) => ({ ...(runId ? { [MARKER_VAR]: runId } : {}), ...(runId && chatId ? { [OWNER_VAR]: chatId } : {}) })

function psField(field, pid) {
  try {
    return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/**
 * Whether the run a state file describes is stale right now, and how old it is. Always read
 * fresh from disk and the process list, since its owner may have resumed meanwhile.
 * Undefined when the file is gone or belongs to a different run than `runId`.
 */
function runVerdict(statePath, runId) {
  try {
    const latest = JSON.parse(readFileSync(statePath, 'utf8'))
    if (latest.runId !== runId) return undefined
    const now = Date.now()
    const ageMs = Math.max(0, now - (latest.startedAt ?? now), ...[latest.fixturePid, latest.metroPid].filter(Boolean).map((pid) => parseElapsed(psField('etime', pid))))
    const ownerRunning = latest.chatId ? chatRunning(latest.chatId, latest.dataDir ?? dirname(resolveOwner().registryDir)) : null
    return { verdict: staleVerdict({ ageMs, idleMs: now - statSync(statePath).mtimeMs, ownerRunning }), ageMs, ownerRunning }
  } catch {
    return undefined
  }
}

/** The verify-manor-mobile folder of the checkout a listener runs from, found through its working directory. */
function ownerSkillDirOf(pid) {
  for (let dir = cwdOf(pid); dir && dir !== '/'; dir = dirname(dir)) {
    for (const candidate of [dir, join(dir, '.cursor/skills/verify-manor-mobile')]) {
      if (existsSync(join(candidate, 'control-manor-mobile.mjs'))) return candidate
    }
  }
  return undefined
}

/** Runs stopped for being stale during this launch, for its report. */
const stoppedStale = []

/** A process of this skill, of any checkout: the run marker, or the variables a run from before markers set. */
const ofThisSkill = (env) => env.includes(`${MARKER_VAR}=`) || env.includes('MANOR_MOBILE_VERIFY_PORT=') || env.includes('EXPO_PUBLIC_MANOR_WS=ws://')

/**
 * Stops the run behind a listener whose checkout was removed under it. Its state file and
 * its `cleanup` went with the checkout, so the processes themselves are all there is to go
 * on. The listener's group is stopped only when every member carries this skill's own
 * variables (a group that also holds anything else is left alone), never the caller's own
 * group, and never while the chat the run names has a turn running. All of it is asked
 * again before every signal. Answers the line for the report, or undefined when the
 * listener is not such a run or may not be stopped.
 */
async function stopOrphan(port, what, pid) {
  const cwd = cwdOf(pid)
  const group = Number(psField('pgid', pid))
  if (cwd === undefined || group === Number(psField('pgid', process.pid))) return undefined
  const chatId = new RegExp(`${OWNER_VAR}=([0-9a-f-]{36})`).exec(envOf(pid))?.[1]
  const judge = () => {
    const members = groupMembers(group)
    // Once the listener has exited the rest of its group still has to be this skill's alone.
    const here = cwdOf(pid)
    if (here !== undefined && (here !== cwd || !members.includes(pid))) return undefined
    if (!members.every((member) => ofThisSkill(envOf(member)))) return undefined
    // The run names its chat, not the data folder that chat lives in.
    const ownerRunning = chatId ? chatRunning(chatId, undefined) : null
    return staleVerdict({ ageMs: 0, idleMs: 0, ownerRunning, checkoutGone: !existsSync(cwd) })
  }
  const verdict = judge()
  if (verdict === undefined) return undefined
  const who = `${chatId ? `chat ${chatId.slice(0, 8)}, ` : ''}checkout ${cwd}, ${describeAge(parseElapsed(psField('etime', pid)))} old`
  await stopGroup(group, ofThisSkill, () => judge() !== undefined)
  for (let waited = 0; waited < 8_000 && portOwners(port).length > 0; waited += 250) await sleep(250)
  if (portOwners(port).length > 0) return undefined
  return `Stopped the stale verify run on ${what.toLowerCase()} port ${port} (${who}): ${staleReason(verdict)}. Its process group was stopped.`
}

/**
 * Runs another checkout's own `cleanup`, told which run it may stop: a replacement run in the
 * same checkout is left alone. Returns the last line it printed, for a refusal.
 */
function cleanupIn(ownerDir, runId, extra = []) {
  const cleanup = spawnSync(process.execPath, [join(ownerDir, 'control-manor-mobile.mjs'), 'cleanup', '--expect', runId, ...extra], { cwd: ownerDir, encoding: 'utf8', timeout: 60_000 })
  return (cleanup.stderr || cleanup.stdout || 'no output').trim().split('\n').at(-1)
}

/**
 * Why a port is held, and by whom, as `{ message, wait }`. A leftover run holds the fixed
 * ports until somebody cleans it up: when it is stale (over a day old, or its owning chat
 * has no running turn) its own checkout's `cleanup` stops it, which signals only the groups
 * that run recorded and claimed. A run whose checkout is gone is stale as well and has no
 * cleanup left, so its own group is stopped. A verify run that is not stale comes back with
 * `wait: true`, its listener `pid` and `who` it is, so launch waits for it; anything else is a
 * refusal with its owner named.
 * Returns undefined once the port is free.
 */
async function holderOrFree(port, what) {
  const listeners = portOwners(port)
  if (listeners.length === 0) return undefined
  const ownerDir = ownerSkillDirOf(listeners[0])
  const unknown = { message: `${what} port ${port} is already in use (pid ${listeners.join(', ')}) by a process that is not a verify-manor-mobile run Manor can identify. Manor does not touch it. Free the port by hand and retry.` }
  if (ownerDir === undefined) {
    const line = await stopOrphan(port, what, listeners[0])
    if (line === undefined) return unknown
    stoppedStale.push(line)
    console.error(line)
    return undefined
  }
  if (ownerDir === SKILL_DIR) return unknown
  let theirs
  try {
    theirs = JSON.parse(readFileSync(join(ownerDir, '.run/state.json'), 'utf8'))
  } catch {
    return unknown
  }
  // The listener must sit in a process group that run started and claimed.
  const group = Number(psField('pgid', listeners[0]))
  const leaders = [theirs.fixturePid, theirs.metroPid].filter((pid, at) => pid && (at === 0 ? theirs.claimedFixture : theirs.claimedMetro))
  if (!leaders.includes(group)) return unknown
  const statePath = join(ownerDir, '.run/state.json')
  const judged = runVerdict(statePath, theirs.runId)
  if (judged === undefined) return unknown
  const { verdict, ageMs, ownerRunning } = judged
  const who = `${theirs.chatId ? `chat ${theirs.chatId.slice(0, 8)}` : 'started by hand'}, checkout ${theirs.repoRoot ?? dirname(dirname(dirname(ownerDir)))}, ${describeAge(ageMs)} old`
  if (verdict === undefined) {
    const why = ownerRunning === true ? 'its owner has a turn running' : ownerRunning === false ? 'its owner used it in the last 15 minutes' : 'it is under a day old and names no chat to check'
    return { message: `${what} port ${port} is held by a verify run that is not stale (${who}): ${why}.`, wait: true, pid: listeners[0], who }
  }
  let failure
  if (theirs.runId) {
    failure = cleanupIn(ownerDir, theirs.runId)
  } else {
    // A run from before markers: only the group the listener sits in, and only while a member
    // still carries this skill's own variables. Its saved pids are not trusted beyond that.
    await stopGroup(group, ofThisSkill, () => runVerdict(statePath, theirs.runId)?.verdict !== undefined)
    try {
      const latest = JSON.parse(readFileSync(statePath, 'utf8'))
      for (const [pid, claimed, extra] of [['fixturePid', 'claimedFixture', []], ['metroPid', 'claimedMetro', ['metroPort']]]) {
        if (latest[pid] === group) for (const key of [pid, claimed, ...extra]) delete latest[key]
      }
      writeFileSync(statePath, JSON.stringify(latest, null, 2) + '\n')
    } catch { /* state already gone */ }
  }
  for (let waited = 0; waited < 8_000 && portOwners(port).length > 0; waited += 250) await sleep(250)
  if (portOwners(port).length > 0) {
    return { message: `${what} port ${port} is held by a stale verify run (${who}), but stopping it in ${ownerDir} did not free the port${failure ? `: ${failure}` : ''}.` }
  }
  const line = `Stopped the stale verify run on ${what.toLowerCase()} port ${port} (${who}): ${staleReason(verdict, ageMs, theirs.chatId)}. ${theirs.runId ? 'Its own cleanup ran' : 'Its process group was stopped'} in ${ownerDir}.`
  stoppedStale.push(line)
  console.error(line)
  return undefined
}

/** A fixed port must be free for this run: a stale leftover is cleared, anything else refuses with its owner named. */
async function assertPortFree(port, what) {
  const holder = await holderOrFree(port, what)
  if (holder !== undefined) fail(holder.message)
}

/** The exit-3 message once launch has waited STALL_MS without progress: `what` stood still, and what to do instead of stopping that run. */
const gaveUp = (what, who) =>
  `${what} (${who}), which should not happen. Do not stop that run and do not ask the user what to do: finish and report the work without screenshots, and say in the report that the phone verify run was stuck behind ${who}.`

/**
 * Before launch starts anything: waits until a fixed port is free, polling every 5 s. Only a
 * verify run that is not stale is waited for (a run started by an older copy of this script
 * holds no lease), as long as the port changes hands: the standstill clock restarts when its
 * listener pid changes, and the wait exits 3 after STALL_MS behind the same listener. Its line
 * is printed on the first try, on every new listener and otherwise at most once a minute. A
 * true refusal fails at once. Every poll marks `runId` in use, since waiting for the port at the
 * head of the queue is holding the lease; a refusal means the lease moved on, and the launch
 * fails before it starts anything and leaves the lease alone.
 */
async function waitForPort(port, what, runId) {
  const started = Date.now()
  let behind
  let stalledSince
  let reportedAt
  const stillHolds = () => {
    if (markUse(LEASE_PATH, runId)) return
    fail(`This launch lost the phone verify lease while it waited for ${what.toLowerCase()} port ${port}. Run \`launch\` again; it waits its turn.`)
  }
  for (;;) {
    // Checked before the probe, which may stop a stale run, and again before the launch goes on.
    stillHolds()
    const holder = await holderOrFree(port, what)
    stillHolds()
    if (holder === undefined) return
    if (!holder.wait) fail(holder.message)
    const changed = holder.pid !== behind
    if (changed) {
      behind = holder.pid
      stalledSince = Date.now()
    }
    const stalledMs = Date.now() - stalledSince
    if (stalledMs >= STALL_MS) fail(gaveUp(`The same run held ${what.toLowerCase()} port ${port} for ${describeAge(stalledMs)}`, holder.who), 3)
    if (changed || Date.now() - reportedAt >= 60_000) {
      reportedAt = Date.now()
      console.error(`${holder.message} Waited ${describeAge(Date.now() - started)}; launch keeps waiting while the port changes hands and gives up only when the same run holds it for ${describeAge(STALL_MS)}. That run is not stopped.`)
    }
    await sleep(Math.min(5000, STALL_MS - (Date.now() - stalledSince)))
  }
}

/**
 * The `blocked` hook of the lease wait, for a holder that is still alive. First the standing
 * stale rule on its own state file; then a holder nobody has driven for IDLE_MS, whether or
 * not its chat has a turn running. Either way its checkout's `cleanup` stops it (which also
 * frees the lease); a holder that is in use, or has a command running, is never touched.
 */
async function stopStaleHolder(holder) {
  const ownerDir = join(holder.checkout, '.cursor/skills/verify-manor-mobile')
  const judged = runVerdict(join(ownerDir, '.run/state.json'), holder.runId)
  if (judged?.verdict !== undefined) {
    cleanupIn(ownerDir, holder.runId)
    // Its cleanup may have found the owner back at work and left it alone.
    if (readLease(LEASE_PATH).holder?.runId !== holder.runId) {
      const line = `Stopped the stale verify run holding the phone verify lease (${describeHolder(holder)}): ${staleReason(judged.verdict, judged.ageMs, holder.chatId)}. Its own cleanup ran in ${ownerDir}.`
      stoppedStale.push(line)
      console.error(line)
      return
    }
  }
  const idle = holderIdleMs(holder)
  if (idle <= IDLE_MS) return
  cleanupIn(ownerDir, holder.runId, ['--idle'])
  // Its cleanup leaves a run alone that was driven again meanwhile.
  if (readLease(LEASE_PATH).holder?.runId === holder.runId) return
  const line = `Stopped the idle verify run holding the phone verify lease (${describeHolder(holder)}): not used for ${describeAge(idle)}. Its own cleanup ran in ${ownerDir}.`
  stoppedStale.push(line)
  console.error(line)
}

/**
 * Called first by every command that drives the simulator: only the run that holds the phone
 * verify lease may touch its screen, so anything else exits 3. Marks the run in use on the
 * lease now and again when this command exits, so a waiting launch measures its idle time
 * from the end of the last command. Also refreshes state.json's mtime, the idle clock of the
 * stale rule.
 */
function requireLease() {
  const { runId } = loadState()
  if (!runId || !markUse(LEASE_PATH, runId)) {
    const { holder } = readLease(LEASE_PATH)
    const held = holder ? `it is held by ${describeHolder(holder)}` : 'nobody holds it'
    fail(`This run does not hold the phone verify lease (${held}). The simulator screen belongs to another run. Run \`launch\`, which waits its turn.`, 3)
  }
  process.on('exit', () => {
    try { markUse(LEASE_PATH, runId) } catch { /* the command's own outcome is what counts */ }
  })
  const now = new Date()
  utimesSync(STATE_PATH, now, now)
}

function tailOf(path, lines = 15) {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return '(no log)'
  }
}

// ---------------------------------------------------------------------------
// Dependencies. Per-chat worktrees have `node_modules` stripped when idle, so every
// piece the launcher needs is installed here from the lockfile, never changing it.
// ---------------------------------------------------------------------------

/** Where `tsx` lives for the fixture. Any workspace package that lists it works. */
function findTsx() {
  for (const dir of ['apps/server', 'packages/contracts']) {
    const bin = join(REPO_ROOT, dir, 'node_modules/.bin/tsx')
    if (existsSync(bin)) return bin
  }
  return ''
}

function mobileDepsInstalled() {
  return existsSync(join(REPO_ROOT, 'apps/mobile/node_modules/expo/package.json')) && Boolean(findTsx())
}

function skillDepsInstalled() {
  return existsSync(join(SKILL_DIR, 'node_modules/ws/index.js'))
}

function runInstall(command, args, cwd, label) {
  mkdirSync(RUN_DIR, { recursive: true })
  const log = join(RUN_DIR, 'install.log')
  console.error(`Installing ${label} (log: ${log})`)
  const res = spawnSync(command, args, { cwd, stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')] })
  if (res.status !== 0) {
    fail(`Installing ${label} failed (exit ${res.status ?? res.signal}). Last log lines:\n${tailOf(log, 20)}`)
  }
}

/**
 * Installs what the launcher needs when it is missing: the mobile app, its workspace
 * dependencies and `tsx` (pnpm, frozen lockfile), and the skill-local `ws` (npm ci).
 * A no-op in a checkout that already has them.
 */
function ensureDependencies() {
  if (!mobileDepsInstalled()) {
    runInstall(
      'pnpm',
      ['install', '--frozen-lockfile', '--filter', '@manor/mobile...'],
      REPO_ROOT,
      'mobile dependencies (pnpm install --frozen-lockfile --filter @manor/mobile...)',
    )
    if (!mobileDepsInstalled()) fail('Mobile dependencies are still missing after pnpm install. See .run/install.log')
  }
  if (!skillDepsInstalled()) {
    runInstall('npm', ['ci', '--no-audit', '--no-fund'], SKILL_DIR, 'skill dependencies (npm ci)')
    if (!skillDepsInstalled()) fail('Skill dependency `ws` is still missing after npm ci. See .run/install.log')
  }
}

async function startFixture() {
  const state = loadState()
  if (state.fixturePid && pidAlive(state.fixturePid)) return state.fixturePid
  await assertPortFree(FIXTURE_PORT, 'Fixture')
  mkdirSync(RUN_DIR, { recursive: true })
  const run = runIdentity()
  const logFd = openSync(join(RUN_DIR, 'fixture.log'), 'a')
  const child = spawn(findTsx(), [join(SKILL_DIR, 'fixture-server.mjs')], {
    cwd: SKILL_DIR,
    env: {
      ...process.env,
      MANOR_MOBILE_VERIFY_PORT: String(FIXTURE_PORT),
      MANOR_MOBILE_VERIFY_HOST: '127.0.0.1',
      ...runMarks(run),
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  saveState({ ...loadState(), fixturePid: child.pid, claimedFixture: true })
  return child.pid
}

async function waitForFixture() {
  for (let i = 0; i < 40; i += 1) {
    const probe = await wsProbe(FIXTURE_WS)
    if (probe.ok) return
    await sleep(250)
  }
  fail(`Fixture never opened ${FIXTURE_WS}. See .run/fixture.log`)
}

const METRO_LOG = join(RUN_DIR, 'metro.log')

/** Env that points the app at the fixture and keeps live Manor out, for Metro and for the native build alike. */
function fixtureAppEnv() {
  return {
    ...process.env,
    EXPO_PUBLIC_MANOR_WS: FIXTURE_WS,
    EXPO_PUBLIC_SUPABASE_URL: '',
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
    // The fixture has no owner login; without this the app stops at "Welcome home".
    // MANOR_MOBILE_VERIFY_AUTH=on keeps that gate up to prove the sign-in screen
    // itself; its auth client still talks to the fixture origin only.
    EXPO_PUBLIC_MANOR_AUTH: AUTH_ON ? 'on' : 'off',
    EXPO_NO_DOTENV: '1',
    CI: '1',
  }
}

async function startMetro() {
  const state = loadState()
  if (state.metroPid && pidAlive(state.metroPid)) return state.metroPid
  await assertPortFree(METRO_PORT, 'Metro')
  mkdirSync(RUN_DIR, { recursive: true })
  const run = runIdentity()
  const logFd = openSync(METRO_LOG, 'a')
  const child = spawn(
    'pnpm',
    // `--clear` because Metro's file map cache is shared with ordinary dev runs, which
    // list `.env.local`; reusing it puts the live socket back into the fixture bundle.
    ['--filter', '@manor/mobile', 'exec', 'expo', 'start', '--dev-client', '--host', 'lan', '--port', String(METRO_PORT), '--clear'],
    {
      cwd: REPO_ROOT,
      env: { ...fixtureAppEnv(), ...runMarks(run) },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    },
  )
  child.unref()
  saveState({ ...loadState(), metroPid: child.pid, claimedMetro: true, metroPort: METRO_PORT })
  return child.pid
}

async function waitForMetro() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${METRO_PORT}/status`)
      if ((await res.text()).includes('packager-status:running')) return
    } catch {
      /* not listening yet */
    }
    const pid = loadState().metroPid
    if (pid && !pidAlive(pid)) {
      fail(`Metro exited before it was ready. Last log lines:\n${tailOf(METRO_LOG)}`)
    }
    await sleep(500)
  }
  fail(`Metro did not become ready on ${METRO_PORT} within 120s. Last log lines:\n${tailOf(METRO_LOG)}`)
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

/** Every Manor dev client already on disk, any simulator, newest first. Works while the device is shut down. */
function installedDevClients() {
  const found = []
  for (const udid of safeReaddir(SIMULATOR_DEVICES)) {
    const apps = join(SIMULATOR_DEVICES, udid, 'data/Containers/Bundle/Application')
    for (const id of safeReaddir(apps)) {
      const dir = join(apps, id)
      let meta = ''
      try {
        meta = readFileSync(join(dir, '.com.apple.mobile_container_manager.metadata.plist')).toString('latin1')
      } catch {
        continue
      }
      if (!meta.includes(BUNDLE_ID)) continue
      const app = safeReaddir(dir).find((name) => name.endsWith('.app'))
      if (app) found.push({ udid, path: join(dir, app), mtime: statSync(join(dir, app)).mtimeMs })
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function availableIphones() {
  const raw = JSON.parse(simctl('list', 'devices', 'available', '-j')).devices
  return Object.entries(raw).flatMap(([runtime, devices]) =>
    devices
      .filter((device) => device.isAvailable !== false && /^iPhone/.test(device.name))
      .map((device) => ({ ...device, runtime })),
  )
}

/**
 * The configured name when this Mac has it, otherwise the best available iPhone. A device
 * that already carries the dev client wins, then the plain "Pro" size, so the common case
 * needs no install.
 */
function pickSimulator() {
  const iphones = availableIphones()
  if (iphones.length === 0) {
    fail('No iPhone simulator is available. Install an iOS Simulator runtime in Xcode > Settings > Components.')
  }
  const withApp = new Set(installedDevClients().map((client) => client.udid))
  if (SIMULATOR_NAME) {
    const named = iphones.filter((device) => device.name === SIMULATOR_NAME)
    if (named.length > 0) return named.find((device) => withApp.has(device.udid)) ?? named[0]
    console.error(`Simulator "${SIMULATOR_NAME}" does not exist on this Mac; picking an available iPhone instead.`)
  }
  const score = (device) => (withApp.has(device.udid) ? 100 : 0) + (/ Pro$/.test(device.name) ? 10 : 0)
  const pick = [...iphones].sort((a, b) => score(b) - score(a) || b.runtime.localeCompare(a.runtime))[0]
  console.error(`Using simulator ${pick.name} (${pick.udid}).`)
  return pick
}

function bootSimulator() {
  const state = loadState()
  const booted = bootedUdid({ adopt: true })
  if (booted) {
    // A second `launch` finds the simulator this run booted; it stays ours to shut down.
    const ours = Boolean(state.claimedSimulator) && state.simulatorUdid === booted
    saveState({ ...state, simulatorUdid: booted, claimedSimulator: ours })
    return booted
  }
  const device = pickSimulator()
  try {
    simctl('boot', device.udid)
  } catch {
    // already booting; bootstatus below waits either way
  }
  try {
    execFileSync('xcrun', ['simctl', 'bootstatus', device.udid], { stdio: 'ignore', timeout: 180_000 })
  } catch {
    // fall through to the state poll, which names the failure
  }
  if (bootedUdid({ only: device.udid })) {
    saveState({ ...loadState(), simulatorUdid: device.udid, claimedSimulator: true })
    return device.udid
  }
  fail(`Simulator ${device.name} (${device.udid}) did not boot.`)
}

// ---------------------------------------------------------------------------
// Dev client. An Xcode 27 build without a scene manifest stops at launch with SIGTRAP
// ("UIScene life cycle is required for apps built with this SDK"). apps/mobile now adopts
// the scene lifecycle, so only a dev client built before that needs the workaround: a
// copy whose recorded SDK is lowered and re-signed.
// ---------------------------------------------------------------------------

function recordedSdk(binary) {
  try {
    const out = execFileSync('xcrun', ['vtool', '-show-build', binary], { encoding: 'utf8' })
    return Number(/sdk (\d+)/.exec(out)?.[1] ?? 0)
  } catch {
    return 0
  }
}

function adoptsSceneLifecycle(appPath) {
  try {
    execFileSync('plutil', ['-extract', 'UIApplicationSceneManifest', 'xml1', '-o', '-', join(appPath, 'Info.plist')], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/** True when the build records an SDK that demands a UIScene delegate and has none. */
function needsSdkPatch(appPath) {
  return recordedSdk(join(appPath, 'Manor')) >= 27 && !adoptsSceneLifecycle(appPath)
}

/** Copies the app into `.run` with the lowered SDK, re-signed. Returns the copy's path. */
function patchedCopy(appPath) {
  const dest = join(RUN_DIR, 'devclient/Manor.app')
  rmSync(dirname(dest), { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  execFileSync('ditto', [appPath, dest])
  const dylibs = []
  for (const name of ['Manor', 'Manor.debug.dylib']) {
    const file = join(dest, name)
    if (!existsSync(file)) continue
    execFileSync('xcrun', ['vtool', '-set-build-version', 'iossim', '16.4', '26.4', '-replace', '-output', `${file}.patched`, file], {
      stdio: 'ignore',
    })
    renameSync(`${file}.patched`, file)
    if (name.endsWith('.dylib')) dylibs.push(file)
  }
  for (const file of [...dylibs, dest]) execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'ignore' })
  return dest
}

function installedAppPath(udid) {
  try {
    return simctl('get_app_container', udid, BUNDLE_ID, 'app').trim()
  } catch {
    return ''
  }
}

function buildDevClient(udid) {
  const log = join(RUN_DIR, 'build.log')
  console.error(`No Manor dev client exists on this Mac. Building it with Xcode (several minutes, log: ${log}).`)
  const fd = openSync(log, 'a')
  // Only an installed app counts as success; the exit status of the build's own launch does not.
  spawnSync('pnpm', ['--filter', '@manor/mobile', 'exec', 'expo', 'run:ios', '--device', udid, '--no-bundler'], {
    cwd: REPO_ROOT,
    env: fixtureAppEnv(),
    stdio: ['ignore', fd, fd],
    timeout: 30 * 60_000,
  })
  if (!installedAppPath(udid)) {
    fail(`Building the Manor dev client failed. Last log lines:\n${tailOf(log, 25)}`)
  }
}

/**
 * Leaves a launchable dev client on the simulator: reuses it, copies one from another
 * simulator, or builds it, and applies the SDK workaround whenever the build needs it.
 */
function ensureDevClient(udid) {
  let source = installedAppPath(udid)
  if (!source) {
    const elsewhere = installedDevClients().find((client) => client.udid !== udid)
    if (elsewhere) {
      console.error(`Installing the Manor dev client from simulator ${elsewhere.udid}.`)
      source = elsewhere.path
      if (!needsSdkPatch(source)) {
        simctl('install', udid, source)
        return
      }
    } else {
      buildDevClient(udid)
      source = installedAppPath(udid)
      if (!needsSdkPatch(source)) return
    }
  } else if (!needsSdkPatch(source)) {
    return
  }
  console.error('Applying the Xcode 27 UIScene workaround (lowered SDK, re-signed copy).')
  simctl('install', udid, patchedCopy(source))
}

function launchApp(udid) {
  try {
    // The dev client opens the fixture bundle directly instead of its server picker. A
    // running app would keep the bundle it loaded earlier, so it restarts on this one.
    simctl('launch', '--terminate-running-process', udid, BUNDLE_ID, '--initialUrl', `http://127.0.0.1:${METRO_PORT}`)
  } catch (err) {
    fail(`Could not launch ${BUNDLE_ID} on ${udid}. ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Launches the app and returns only once it has rendered: Metro reports the iOS bundle,
 * then (with Maestro) the first screen is visible. A cold bundle takes about 35s; a
 * screenshot before that shows the splash.
 */
async function launchAndWait(udid) {
  const offset = existsSync(METRO_LOG) ? statSync(METRO_LOG).size : 0
  launchApp(udid)
  const deadline = Date.now() + BUNDLE_TIMEOUT_MS
  for (;;) {
    // Metro colours its lines when FORCE_COLOR is inherited, which splits "iOS Bundled 35ms" with escape codes.
    const fresh = (existsSync(METRO_LOG) ? readFileSync(METRO_LOG).subarray(offset).toString('utf8') : '').replace(/\x1b\[[0-9;]*m/g, '')
    if (/iOS Bundled \d+ms/.test(fresh)) break
    if (/Metro error|SyntaxError|Unable to resolve/.test(fresh)) {
      fail(`Metro could not build the iOS bundle. Last log lines:\n${tailOf(METRO_LOG, 25)}`)
    }
    if (Date.now() > deadline) {
      fail(
        `The app did not request the iOS bundle within ${BUNDLE_TIMEOUT_MS / 1000}s (raise MANOR_MOBILE_VERIFY_BUNDLE_TIMEOUT_MS). Last Metro log lines:\n${tailOf(METRO_LOG)}`,
      )
    }
    await sleep(500)
  }
  await waitForFirstScreen()
}

/**
 * A fresh simulator puts the notification permission alert and the dev client's onboarding
 * sheet (then its dev menu) over the first screen, which would end up in every screenshot.
 * Each Maestro pass dismisses whichever is up, waits for the ready label, then dismisses and
 * asserts once more, because the alert can arrive a moment after the first render. One pass
 * is one Maestro start (about 10s), so the whole check lives in a single flow.
 */
async function waitForFirstScreen() {
  const dismiss = (label, when = label) => [
    '- runFlow:',
    '    when:',
    `      visible: "${when}"`,
    '    commands:',
    `      - tapOn: "${label}"`,
  ]
  const overlays = [
    ...dismiss('Allow'),
    ...dismiss('Continue'),
    // Continuing the onboarding opens the dev menu; "Go home" only exists in that sheet.
    ...dismiss('Close', 'Go home'),
  ]
  const ready = (timeout) => [
    '- extendedWaitUntil:',
    `    visible: "${escapeYaml(READY_LABEL)}"`,
    `    timeout: ${timeout}`,
  ]
  const flow = () => writeTempFlow([...overlays, ...ready(4000), ...overlays, ...ready(4000)])
  const deadline = Date.now() + RENDER_TIMEOUT_MS
  let lastOutput = ''
  while (Date.now() < deadline) {
    try {
      runMaestro(flow(), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
      return
    } catch (err) {
      lastOutput = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n')
    }
  }
  if (lastOutput) console.error(`Last Maestro output:\n${lastOutput}`)
  fail(
    `The app loaded its bundle but "${READY_LABEL}" was not visible within ${RENDER_TIMEOUT_MS / 1000}s (MANOR_MOBILE_VERIFY_RENDER_TIMEOUT_MS). Take a screenshot to see what it shows; check .run/metro.log for a red screen.`,
  )
}

async function cmdLaunch() {
  assertSafeWs()
  if (!isDarwin() || !hasXcode()) fail(MAC_BLOCKER, 2)
  // Two chats can share one checkout and so one state file: a live run of another chat is not
  // joined, and a dead one's state is removed so this launch gets an identity of its own.
  const saved = loadState()
  const mine = resolveOwner().chatId
  if (saved.chatId && mine && saved.chatId !== mine) {
    if (pidAlive(saved.fixturePid) || pidAlive(saved.metroPid)) {
      fail(`This checkout's phone verify run belongs to chat ${saved.chatId.slice(0, 8)} and is still running; launch does not join or stop it. Do not ask the user what to do: finish and report the work without screenshots, and say in the report that the phone verify run was busy.`, 3)
    }
    unlinkSync(STATE_PATH)
  }
  const { runId, chatId } = runIdentity()
  if (!runId) fail('This checkout still has a live verify run from before run markers. Run `control-manor-mobile.mjs cleanup` first, then launch again.')
  // Queues behind the run that holds the simulator and the fixed ports; that run is never stopped while it is in use.
  const lease = await waitForLease(LEASE_PATH, { runId, checkout: REPO_ROOT, chatId }, {
    stallMs: STALL_MS,
    onWait: ({ holder, position, waitedMs }) =>
      console.error(`launch waits for the phone verify lease, place ${position} in the queue, held by ${describeHolder(holder)}. Waited ${describeAge(waitedMs)}; launch keeps waiting while the queue moves or the run in front is being used, and gives up only after ${describeAge(STALL_MS)} without any of that. That run is not stopped.`),
    blocked: stopStaleHolder,
  })
  if (lease.timedOut) fail(gaveUp(`The run in front neither used the phone verify simulator nor gave it up for ${describeAge(lease.stalledMs)}`, describeHolder(lease.holder)), 3)
  // In use from here: a waiting launch never stops a run while this launcher runs. Refused when
  // this launch joined its own run while a cleanup hands that run over; it fails before the exit
  // hook below exists, so it neither releases nor marks the lease under that cleanup. Not exit
  // 3: the handover takes seconds, and the next launch simply queues.
  if (!markUse(LEASE_PATH, runId)) {
    fail('This checkout\'s phone verify run is being handed to a waiting run after it sat idle. Run `launch` again in a few seconds; it waits its turn.')
  }
  armIdleWatch(runId)
  let reclaimedLease
  if (lease.reclaimed) {
    const why = lease.reclaimed.reason === 'checkout-gone' ? 'its checkout no longer exists' : 'its processes are gone'
    reclaimedLease = `Took over the phone verify lease from a run that left it (${describeHolder(lease.reclaimed.holder)}): ${why}.`
    console.error(reclaimedLease)
  }
  // A launch that ends with nothing running must not hold up the queue; a run left running keeps
  // the lease, idle from the moment this launch ended.
  process.on('exit', () => {
    try {
      // A lease that moved on is the next run's, and one in a handover is that cleanup's to release.
      if (!markUse(LEASE_PATH, runId)) return
      const state = loadState()
      if (!pidAlive(state.fixturePid) && !pidAlive(state.metroPid)) {
        // Nothing of this run is left to need a device it booted, and the idle watch has no lease to go on: shut it down before others may adopt it.
        if (state.claimedSimulator && state.simulatorUdid) {
          try { simctl('shutdown', state.simulatorUdid) } catch { /* not booted any more */ }
          // The claim ends with the boot: a later retry must not shut down a device somebody else booted.
          const { claimedSimulator, simulatorUdid, ...rest } = loadState()
          saveState(rest)
        }
        release(LEASE_PATH, runId)
      }
    } catch { /* once this launcher is gone, the next in line takes over a lease nothing keeps alive */ }
  })
  // A run starting afresh is as old as this moment, not as the launch that once queued for it.
  const ours = loadState()
  if (!pidAlive(ours.fixturePid) && !pidAlive(ours.metroPid)) saveState({ ...ours, startedAt: Date.now() })
  // Before anything slow: a stale run from another checkout may hold the fixed ports.
  if (!pidAlive(ours.fixturePid)) await waitForPort(FIXTURE_PORT, 'Fixture', runId)
  if (!pidAlive(ours.metroPid)) await waitForPort(METRO_PORT, 'Metro', runId)
  requireMaestro()
  ensureDependencies()
  holdWith(runId, await startFixture())
  await waitForFixture()
  const udid = bootSimulator()
  ensureDevClient(udid)
  holdWith(runId, await startMetro())
  await waitForMetro()
  await launchAndWait(udid)
  console.log(JSON.stringify({ ok: true, fixture: FIXTURE_WS, udid, bundleId: BUNDLE_ID, ...(stoppedStale.length === 0 ? {} : { stoppedStale }), ...(reclaimedLease ? { reclaimedLease } : {}) }, null, 2))
}

/**
 * Starts the detached idle watch of this run unless one already runs: it is what shuts the
 * simulator down when no Session is left to call `cleanup`. It outlives the launcher like the
 * fixture and Metro do, takes no part in the lease, and ends by itself once the run is gone.
 */
function armIdleWatch(runId) {
  const state = loadState()
  if (state.idleWatch && alive(state.idleWatch)) return
  const child = spawn(process.execPath, [join(SKILL_DIR, 'control-manor-mobile.mjs'), 'idle-watch', '--run', runId], {
    cwd: SKILL_DIR,
    // The watcher starts in another folder, so it gets the lease path as launch resolved it.
    env: { ...process.env, MANOR_MOBILE_VERIFY_LEASE: LEASE_PATH },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const idleWatch = { pid: child.pid, start: processStart(child.pid) }
  saveState({ ...loadState(), idleWatch })
}

/**
 * The idle watch: sleeps until the run could be idle for SHUTDOWN_IDLE_MS, then asks the run's own
 * `cleanup --idle-after` to stop it. Everything is decided by the lease (see idleWatchVerdict) and
 * again, atomically, inside that cleanup, so a run driven meanwhile or a launch queued meanwhile
 * keeps its simulator. Ends once this checkout's run is no longer the one it watches, which it
 * notices within WATCH_MAX_SLEEP_MS, also when the checkout was removed. Nothing signals it.
 */
async function cmdIdleWatch() {
  const runId = flag('--run')
  // A state file caught mid-write reads as still ours; the next look settles it.
  const watching = () => { try { return loadState().runId === runId } catch { return true } }
  while (runId && watching()) {
    const verdict = idleWatchVerdict(readLease(LEASE_PATH), runId, SHUTDOWN_IDLE_MS)
    if (verdict.action === 'stop') return
    if (verdict.action === 'shutdown') {
      cleanupIn(SKILL_DIR, runId, ['--idle', '--idle-after', String(SHUTDOWN_IDLE_MS)])
      // A cleanup that left the run alone (driven again, or a queue appeared) is asked again after a pause.
      await sleep(5000)
      continue
    }
    await sleep(Math.min(verdict.ms, WATCH_MAX_SLEEP_MS))
  }
}

/** Records a process launch just started on the lease, so the run keeps it after the launcher exits. */
function holdWith(runId, pid) {
  if (!addPids(LEASE_PATH, runId, [pid])) {
    fail(`This launch no longer holds the phone verify lease (${describeHolder(readLease(LEASE_PATH).holder)}). Run \`control-manor-mobile.mjs cleanup\`, then launch again.`)
  }
}

async function cmdDoctor() {
  const state = loadState()
  const lease = readLease(LEASE_PATH)
  const report = {
    platform: process.platform,
    xcode: hasXcode(),
    fixtureWs: FIXTURE_WS,
    fixturePid: state.fixturePid ?? null,
    fixtureAlive: pidAlive(state.fixturePid),
    fixtureOpen: false,
    live43179Http: await live43179(),
    simulatorUdid: isDarwin() && hasXcode() ? bootedUdid() : '',
    appInstalled: false,
    metroPid: state.metroPid ?? null,
    metroAlive: pidAlive(state.metroPid),
    mobileDepsInstalled: mobileDepsInstalled(),
    skillDepsInstalled: skillDepsInstalled(),
    maestro: maestroBin() || null,
    javaHome: javaHome() || null,
    lease: {
      path: LEASE_PATH,
      holder: lease.holder ? describeHolder(lease.holder) : null,
      ours: Boolean(state.runId) && lease.holder?.runId === state.runId,
      waiting: lease.waiters.length,
      idleMinutes: lease.holder ? Math.floor(holderIdleMs(lease.holder) / 60_000) : null,
    },
    blocker: null,
  }
  if (!isDarwin() || !hasXcode()) {
    report.blocker = MAC_BLOCKER
    console.log(JSON.stringify(report, null, 2))
    fail(MAC_BLOCKER, 2)
  }
  assertSafeWs()
  const probe = await wsProbe(FIXTURE_WS)
  report.fixtureOpen = probe.ok
  report.appInstalled = Boolean(report.simulatorUdid) && appInstalled(report.simulatorUdid)
  console.log(JSON.stringify(report, null, 2))
  if (report.live43179Http === 200) {
    console.error('Note: live43179Http 200 is normal. Do not drive that port or its websocket.')
  }
  if (!report.fixtureOpen) fail('Doctor failed: fixture websocket is not open')
  if (!report.simulatorUdid) fail('Doctor failed: no booted iOS Simulator')
  if (!report.appInstalled) fail('Doctor failed: Manor custom dev client is not installed on the booted simulator')
}

/** Maestro is rarely on PATH inside a Session shell; its installer puts it in ~/.maestro/bin. */
function maestroBin() {
  try {
    const found = execFileSync('which', ['maestro'], { encoding: 'utf8' }).trim()
    if (found) return found
  } catch {
    /* not on PATH */
  }
  const known = [join(homedir(), '.maestro/bin/maestro'), '/opt/homebrew/bin/maestro', '/usr/local/bin/maestro']
  return known.find((bin) => existsSync(bin)) ?? ''
}

/** Maestro needs a JDK, and Homebrew's openjdk is keg-only so it is never on PATH. */
function javaHome() {
  const candidates = [
    process.env.JAVA_HOME,
    '/opt/homebrew/opt/openjdk@21',
    '/opt/homebrew/opt/openjdk',
    '/usr/local/opt/openjdk@21',
    '/usr/local/opt/openjdk',
  ]
  const found = candidates.find((home) => home && existsSync(join(home, 'bin/java')))
  if (found) return found
  try {
    return execFileSync('/usr/libexec/java_home', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function maestroEnv() {
  const home = javaHome()
  const path = [home && join(home, 'bin'), join(homedir(), '.maestro/bin'), process.env.PATH].filter(Boolean).join(':')
  return { ...process.env, ...(home ? { JAVA_HOME: home } : {}), PATH: path }
}

function writeTempFlow(steps) {
  mkdirSync(RUN_DIR, { recursive: true })
  const path = join(RUN_DIR, 'drive.yaml')
  const body = [`appId: ${BUNDLE_ID}`, '---', ...steps].join('\n') + '\n'
  writeFileSync(path, body)
  return path
}

/** Exits with an install hint when Maestro or its JDK is missing. Returns the Maestro binary. */
function requireMaestro() {
  const bin = maestroBin()
  if (!bin) {
    fail(
      'Maestro was not found on PATH or in ~/.maestro/bin. Install it on the Mac (https://maestro.mobile.dev) then retry. Do not substitute Expo web.',
    )
  }
  if (!javaHome()) {
    fail('Maestro needs a JDK and none was found. Run: brew install openjdk@21 (it lands in /opt/homebrew/opt/openjdk@21).')
  }
  return bin
}

function runMaestro(flowPath, options = { stdio: 'inherit' }) {
  const bin = requireMaestro()
  return execFileSync(bin, [...onSimulator(), 'test', flowPath], { env: maestroEnv(), ...options })
}

/** Pins Maestro to the booted simulator; without a pin it may pick a connected iPhone. */
function onSimulator() {
  const udid = bootedUdid()
  if (!udid) fail('No booted simulator')
  return ['--device', udid]
}

function cmdTap() {
  requireLease()
  const name = flag('--name')
  if (!name) fail('tap requires --name (accessibility label)')
  runMaestro(writeTempFlow([`- tapOn: "${escapeYaml(name)}"`]))
}

/** Long-press by accessibility label or visible text, the way a message bubble opens its action sheet. */
function cmdLongPress() {
  requireLease()
  const name = flag('--name')
  if (!name) fail('long-press requires --name (accessibility label or visible text)')
  runMaestro(writeTempFlow([`- longPressOn: "${escapeYaml(name)}"`]))
}

function cmdFill() {
  requireLease()
  const name = flag('--name')
  const value = flag('--value')
  if (!name || value === undefined) fail('fill requires --name and --value')
  runMaestro(
    writeTempFlow([
      `- tapOn: "${escapeYaml(name)}"`,
      `- eraseText`,
      `- inputText: "${escapeYaml(value)}"`,
    ]),
  )
}

async function cmdHome() {
  requireLease()
  if (!isDarwin() || !hasXcode()) fail(MAC_BLOCKER, 2)
  const udid = bootedUdid()
  if (!udid) fail('No booted simulator')
  await launchAndWait(udid)
}

function cmdScreenshot() {
  requireLease()
  const path = flag('--path')
  if (!path) fail('screenshot requires --path')
  if (!isDarwin() || !hasXcode()) fail(MAC_BLOCKER, 2)
  const dest = resolve(path)
  mkdirSync(dirname(dest), { recursive: true })
  const udid = bootedUdid()
  if (!udid) fail('No booted simulator')
  execFileSync('xcrun', ['simctl', 'io', udid, 'screenshot', dest], { stdio: 'pipe' })
  console.log(JSON.stringify({ path: dest, ...writePreview(dest) }))
}

// The agent reads `<name>.preview.png` (about one pixel per point); the full-size file at --path is the evidence.
const PREVIEW_WIDTH = 400

function pngSize(path) {
  const png = readFileSync(path)
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
}

function writePreview(dest) {
  const size = pngSize(dest)
  if (Number(size.split('x')[0]) <= PREVIEW_WIDTH) return { size, preview: dest, previewSize: size }
  const preview = dest.replace(/(\.png)?$/i, '.preview.png')
  execFileSync('sips', ['--resampleWidth', String(PREVIEW_WIDTH), dest, '--out', preview], { stdio: 'pipe' })
  return { size, preview, previewSize: pngSize(preview) }
}

/**
 * One line per labelled or texted element, in screen order:
 * `"label" text="…" value="…" hint="…" [selected] [disabled] [x1,y1][x2,y2]` (points).
 */
function compactHierarchy(node, lines = []) {
  const a = node.attributes ?? {}
  const label = a.accessibilityText || a.title || ''
  const parts = []
  if (label) parts.push(JSON.stringify(label))
  for (const [key, name] of [['text', 'text'], ['value', 'value'], ['hintText', 'hint']]) {
    if (a[key] && a[key] !== label && (key === 'text' || a[key] !== a.text)) parts.push(`${name}=${JSON.stringify(a[key])}`)
  }
  if (parts.length > 0 && a.bounds !== '[0,0][0,0]') {
    for (const state of ['selected', 'checked', 'focused']) if (a[state] === 'true') parts.push(`[${state}]`)
    if (a.enabled === 'false') parts.push('[disabled]')
    const line = `${parts.join(' ')} ${a.bounds ?? ''}`.trim()
    // React Native repeats a label on the wrapper and its text; one line is enough.
    if (lines.at(-1) !== line) lines.push(line)
  }
  for (const child of node.children ?? []) compactHierarchy(child, lines)
  return lines
}

function cmdSnapshot() {
  requireLease()
  const path = flag('--path')
  const bin = maestroBin()
  if (!bin) fail('snapshot needs Maestro (`maestro hierarchy`); not found on PATH or in ~/.maestro/bin')
  const xml = execFileSync(bin, [...onSimulator(), 'hierarchy'], { encoding: 'utf8', env: maestroEnv(), maxBuffer: 64 * 1024 * 1024 })
  // Without --path the screen comes back as compact text, ready to grep; the full dump is evidence.
  if (!path) {
    console.log(compactHierarchy(JSON.parse(xml.slice(xml.indexOf('{')))).join('\n'))
    return
  }
  const dest = resolve(path)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, xml)
  console.log(dest)
}

function cmdWait() {
  const ms = Number(flag('--ms') ?? 800)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function killClaimed(pid, claimed, runId) {
  if (!claimed || !pid) return
  // A run with a marker is signalled while any member of its group carries it, even after
  // the leader has gone; a pid the system has handed to something else since is left alone.
  if (runId) {
    if (groupMembers(pid).some((member) => envOf(member).includes(`${MARKER_VAR}=${runId}`))) signalGroup(pid, false)
    return
  }
  if (pidAlive(pid)) signalGroup(pid, true)
}

function signalGroup(pid, fallbackToPid) {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    if (!fallbackToPid) return
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

function cmdCleanup() {
  const state = loadState()
  // `--expect <runId>` is how another checkout's launch asks this one to stop the run it inspected.
  const expected = flag('--expect')
  if (expected && state.runId !== expected) {
    console.log(`left alone: this checkout's run is not ${expected}.`)
    return
  }
  // With `--idle` the run must still hold the lease and be undriven for IDLE_MS, decided once
  // and under the lease lock: from then on its drive commands are refused, so there is nothing
  // to ask again, and a second cleanup for the same run is left out.
  // `--idle-after <ms>` is the idle watch asking, with its own limit, and then a queue also keeps the run.
  const idleOnly = expected !== undefined && process.argv.includes('--idle')
  const idleAfter = flag('--idle-after') === undefined ? IDLE_MS : Number(flag('--idle-after'))
  if (idleOnly && !yieldIfIdle(LEASE_PATH, expected, idleAfter, { ifUnqueued: flag('--idle-after') !== undefined })) {
    console.log('left alone: that run is no longer stale.')
    return
  }
  // Asked again before each signal: the owner may have resumed since the launch that called this looked.
  const due = () => !expected || idleOnly || runVerdict(STATE_PATH, expected)?.verdict !== undefined
  if (!due()) {
    console.log('left alone: that run is no longer stale.')
    return
  }
  // One refusal ends the whole cleanup: a run its owner resumed keeps its Simulator and its state file too.
  const halted = () => {
    console.log('left alone: that run is no longer stale.')
  }
  // Cleanup holds the lease itself until the release below, so no launch takes it, as free or
  // as dead, and adopts the simulator between the kills and the shutdown. It joins this run's
  // lease, or takes one that is free or dead with nobody queued; otherwise another run holds or
  // is queued for the simulator, so this cleanup leaves the queue at once and the simulator to
  // that run. A run from before run markers has no lease: the simulator is ours only when nobody holds one.
  const acquired = state.runId ? tryAcquire(LEASE_PATH, { runId: state.runId, checkout: REPO_ROOT, chatId: state.chatId }).acquired : undefined
  if (acquired === false) leaveQueue(LEASE_PATH, process.pid)
  const simulatorOurs = acquired ?? readLease(LEASE_PATH).holder === null
  killClaimed(state.metroPid, state.claimedMetro, state.runId)
  if (!due()) return halted()
  killClaimed(state.fixturePid, state.claimedFixture, state.runId)
  if (!due()) return halted()
  if (simulatorOurs && state.claimedSimulator && state.simulatorUdid && isDarwin() && hasXcode()) {
    try {
      simctl('shutdown', state.simulatorUdid)
    } catch {
      /* leave an already-booted shared sim alone if shutdown fails */
    }
  }
  rmSync(join(RUN_DIR, 'devclient'), { recursive: true, force: true })
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH)
  // Others queue for the simulator behind this run.
  if (state.runId) release(LEASE_PATH, state.runId)
  console.log(simulatorOurs
    ? 'cleaned claimed fixture, metro, and simulator. Evidence was not deleted.'
    : 'cleaned claimed fixture and metro; left the simulator running because another run holds or is queued for the phone verify lease. Evidence was not deleted.')
}

function flag(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return undefined
  return process.argv[i + 1]
}

function escapeYaml(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

const command = process.argv[2]
const commands = {
  launch: cmdLaunch,
  deps: async () => {
    ensureDependencies()
    console.log('mobile and skill dependencies are installed')
  },
  doctor: cmdDoctor,
  home: cmdHome,
  tap: async () => cmdTap(),
  'long-press': async () => cmdLongPress(),
  fill: async () => cmdFill(),
  screenshot: async () => cmdScreenshot(),
  snapshot: async () => cmdSnapshot(),
  'wait-settle': async () => cmdWait(),
  cleanup: async () => cmdCleanup(),
  'idle-watch': cmdIdleWatch,
}

if (!command || !commands[command]) {
  fail(`Usage: control-manor-mobile.mjs <${Object.keys(commands).join('|')}>`)
}

await commands[command]()
