import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ACTIVE_MAX_MS, addPids, describeHolder, holderIdleMs, holderStale, idleWatchVerdict, markUse, processStart, readLease, release, tryAcquire, waitForLease, yieldIfIdle } from './lease.mjs'

const LEASE_URL = new URL('./lease.mjs', import.meta.url).href
const folders = []
const children = []
after(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

/** A fresh folder holding this test's lease path and a checkout that exists. */
const fresh = () => {
  const folder = mkdtempSync(join(tmpdir(), 'verify-mobile-lease-'))
  folders.push(folder)
  return { path: join(folder, 'lease.json'), checkout: folder }
}

/** A process that stands in for a detached fixture or Metro process of a run. */
const detached = () => {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' })
  children.push(child)
  return child
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve()
  : new Promise((resolve) => child.once('exit', resolve))

const kill = async (child) => {
  child.kill('SIGKILL')
  await exited(child)
}

/**
 * A separate node process running `body` with the lease module as `lease`. It prints JSON
 * lines through `say`; `next` waits for the next line that passes a test.
 */
const nodeChild = (body) => {
  const script = `import * as lease from '${LEASE_URL}'\nconst say = (value) => console.log(JSON.stringify(value))\n${body}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  const lines = []
  const listeners = new Set()
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, end)))
      buffer = buffer.slice(end + 1)
      for (const listener of listeners) listener()
    }
  })
  let read = 0
  const next = (test = () => true, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error('no matching line from the child')) }, timeoutMs)
    const check = () => {
      while (read < lines.length) {
        const line = lines[read++]
        if (test(line)) {
          clearTimeout(timer)
          listeners.delete(check)
          resolve(line)
          return
        }
      }
    }
    listeners.add(check)
    check()
  })
  return { child, lines, next }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const me = (runId, checkout, pid) => ({ runId, checkout, chatId: null, pid })

describe('lease', () => {
  it('lets a second run wait while the first holds, then take over on release', async () => {
    const { path, checkout } = fresh()
    const launcher = detached()
    const metro = detached()
    assert.equal(tryAcquire(path, { runId: 'A', checkout, chatId: '1a2b3c4d-0000', pid: launcher.pid }).acquired, true)
    assert.equal(addPids(path, 'A', [metro.pid]), true)
    await kill(launcher)

    const b = nodeChild(`
      const result = await lease.waitForLease(${JSON.stringify(path)}, { runId: 'B', checkout: ${JSON.stringify(checkout)}, chatId: null }, {
        pollMs: 50, stallMs: 20000, onWait: (info) => say({ wait: info }),
      })
      say({ result })
    `)
    const first = await b.next()
    assert.equal(first.wait.holder.runId, 'A')
    assert.equal(first.wait.position, 1)
    await delay(400)
    assert.equal(b.lines.some((line) => line.result), false, 'B must not get the lease while A holds it')
    assert.equal(readLease(path).holder.runId, 'A')

    assert.equal(release(path, 'A'), true)
    const { result } = await b.next((line) => line.result)
    assert.equal(result.acquired, true)
    assert.equal(result.lease.runId, 'B')
    assert.equal(result.reclaimed, undefined)
    assert.equal(readLease(path).waiters.length, 0)
  })

  it('reclaims the lease of a run whose processes were killed', async () => {
    const { path, checkout } = fresh()
    const metro = detached()
    assert.equal(tryAcquire(path, me('A', checkout, metro.pid)).acquired, true)
    const b = detached()
    assert.equal(tryAcquire(path, me('B', checkout, b.pid)).acquired, false)
    await kill(metro)
    const result = tryAcquire(path, me('B', checkout, b.pid))
    assert.equal(result.acquired, true)
    assert.equal(result.reclaimed.reason, 'dead')
    assert.equal(result.reclaimed.holder.runId, 'A')
  })

  it('reclaims the lease of a live run whose checkout was removed', () => {
    const { path, checkout } = fresh()
    const gone = mkdtempSync(join(tmpdir(), 'verify-mobile-checkout-'))
    folders.push(gone)
    const metro = detached()
    tryAcquire(path, me('A', gone, metro.pid))
    rmSync(gone, { recursive: true })
    const result = tryAcquire(path, me('B', checkout, detached().pid))
    assert.equal(result.acquired, true)
    assert.equal(result.reclaimed.reason, 'checkout-gone')
  })

  it('gives up after stallMs behind the same run, names the holder and leaves the queue', async () => {
    const { path, checkout } = fresh()
    tryAcquire(path, me('A', checkout, detached().pid))
    const b = detached()
    const result = await waitForLease(path, me('B', checkout, b.pid), { stallMs: 300, pollMs: 50 })
    assert.equal(result.acquired, false)
    assert.equal(result.timedOut, true)
    assert.equal(result.holder.runId, 'A')
    assert.ok(result.stalledMs >= 300)
    assert.ok(result.waitedMs >= result.stalledMs)
    assert.equal(readLease(path).waiters.some((waiter) => waiter.pid === b.pid), false)
  })

  it('restarts the standstill clock when the holder changes', async () => {
    const { path, checkout } = fresh()
    tryAcquire(path, me('A', checkout, detached().pid))
    const d = detached()
    assert.equal(tryAcquire(path, me('D', checkout, d.pid)).position, 1)
    const stallMs = 3000
    const started = Date.now()
    const holders = []
    let settled = false
    const waiting = waitForLease(path, me('W', checkout, detached().pid), {
      stallMs, pollMs: 20, onWait: ({ holder }) => holders.push(holder?.runId ?? null),
    }).finally(() => { settled = true })
    // Halfway to the limit A hands over to D, the waiter's elder in the queue.
    await delay(stallMs / 2)
    assert.equal(release(path, 'A'), true)
    assert.equal(tryAcquire(path, me('D', checkout, d.pid)).acquired, true)
    // Past the limit counted from the start, well before it counted from the change.
    await delay(started + stallMs + 300 - Date.now())
    assert.equal(settled, false, 'the waiter must still wait, now behind D')
    assert.equal(holders[0], 'A')
    assert.equal(holders.at(-1), 'D')
    assert.equal(release(path, 'D'), true)
    const result = await waiting
    assert.equal(result.acquired, true)
    assert.equal(result.lease.runId, 'W')
    assert.ok(Date.now() - started > stallMs)
  })

  it('keeps waiting while the holder is used and gives up once it is not', async () => {
    const { path, checkout } = fresh()
    tryAcquire(path, me('A', checkout, detached().pid))
    const stallMs = 2000
    const started = Date.now()
    let settled = false
    const waiting = waitForLease(path, me('W', checkout, detached().pid), { stallMs, pollMs: 20 })
      .finally(() => { settled = true })
    // A drives the simulator every fifth of the limit, until twice the limit.
    for (let i = 0; i < 10; i++) {
      await delay(stallMs / 5)
      assert.equal(markUse(path, 'A'), true)
    }
    assert.ok(Date.now() - started > 2 * stallMs)
    assert.equal(settled, false, 'the waiter must still wait while A is used')
    const stopped = Date.now()
    const result = await waiting
    assert.equal(result.timedOut, true)
    assert.equal(result.holder.runId, 'A')
    assert.ok(Date.now() - stopped >= stallMs / 2)
  })

  it('serves waiters in arrival order and drops a waiter that died', async () => {
    const { path, checkout } = fresh()
    tryAcquire(path, me('A', checkout, detached().pid))
    const b = detached()
    const c = detached()
    assert.equal(tryAcquire(path, me('B', checkout, b.pid)).position, 1)
    assert.equal(tryAcquire(path, me('C', checkout, c.pid)).position, 2)
    release(path, 'A')

    const refused = tryAcquire(path, me('C', checkout, c.pid))
    assert.equal(refused.acquired, false)
    assert.equal(refused.holder, null)
    assert.equal(refused.position, 2)
    assert.equal(tryAcquire(path, me('B', checkout, b.pid)).acquired, true)

    const d = detached()
    assert.equal(tryAcquire(path, me('D', checkout, d.pid)).position, 2)
    await kill(c)
    release(path, 'B')
    const result = tryAcquire(path, me('D', checkout, d.pid))
    assert.equal(result.acquired, true)
    assert.deepEqual(readLease(path).waiters, [])
  })

  it('lets exactly one of many processes racing for a free lease take it', async () => {
    const { path, checkout } = fresh()
    const startAt = Date.now() + 1000
    const racers = Array.from({ length: 8 }, (_, index) => nodeChild(`
      while (Date.now() < ${startAt}) await new Promise((resolve) => setTimeout(resolve, 1))
      const result = lease.tryAcquire(${JSON.stringify(path)}, { runId: 'run-${index}', checkout: ${JSON.stringify(checkout)}, chatId: null })
      say({ runId: 'run-${index}', acquired: result.acquired })
      setInterval(() => {}, 1000)
    `))
    try {
      const results = await Promise.all(racers.map((racer) => racer.next()))
      const winners = results.filter((result) => result.acquired)
      assert.equal(winners.length, 1)
      const lease = readLease(path)
      assert.equal(lease.holder.runId, winners[0].runId)
      assert.equal(lease.waiters.length, 7)
    } finally {
      await Promise.all(racers.map((racer) => kill(racer.child)))
    }
  })

  it('calls a holder dead when its pid now belongs to a different process', () => {
    const { checkout } = fresh()
    const pid = detached().pid
    const start = processStart(pid)
    assert.notEqual(start, '')
    assert.equal(holderStale({ checkout, pids: [{ pid, start }] }), undefined)
    assert.equal(holderStale({ checkout, pids: [{ pid, start: 'Mon Jan  1 00:00:00 2001' }] }), 'dead')
    assert.equal(processStart(999_999), '')
  })

  it('ignores a release by another run and lets the same run join at once past the queue', () => {
    const { path, checkout } = fresh()
    const launcher = detached()
    tryAcquire(path, me('A', checkout, launcher.pid))
    tryAcquire(path, me('B', checkout, detached().pid))
    assert.equal(release(path, 'B'), false)
    assert.equal(readLease(path).holder.runId, 'A')

    const relaunch = detached()
    const result = tryAcquire(path, me('A', checkout, relaunch.pid))
    assert.equal(result.acquired, true)
    assert.deepEqual(result.lease.pids.map((entry) => entry.pid), [launcher.pid, relaunch.pid])
    assert.equal(readLease(path).waiters.length, 1)
  })

  it('marks use only for the run that holds the lease', () => {
    const { path, checkout } = fresh()
    tryAcquire(path, me('A', checkout, detached().pid), { now: () => 1000 })
    assert.equal(readLease(path).holder.usedAt, 1000)
    const command = detached()
    assert.equal(markUse(path, 'B', { pid: command.pid, now: () => 2000 }), false)
    assert.equal(readLease(path).holder.usedAt, 1000)
    assert.equal(markUse(path, 'A', { pid: command.pid, now: () => 3000 }), true)
    const { holder } = readLease(path)
    assert.equal(holder.usedAt, 3000)
    assert.deepEqual(holder.active, { pid: command.pid, start: processStart(command.pid) })
  })

  it('counts a holder idle only while no command of it runs', async () => {
    const command = detached()
    const holder = { runId: 'A', acquiredAt: 1000, usedAt: 5000, active: { pid: command.pid, start: processStart(command.pid) } }
    assert.equal(holderIdleMs(holder, { now: () => 65_000 }), 0)
    await kill(command)
    assert.equal(holderIdleMs(holder, { now: () => 65_000 }), 60_000)
    assert.equal(holderIdleMs({ runId: 'A', acquiredAt: 1000 }, { now: () => 65_000 }), 64_000)
  })

  it('stops counting a command as use once it has run longer than ACTIVE_MAX_MS', () => {
    const command = detached()
    const holder = { runId: 'A', acquiredAt: 1000, usedAt: 5000, active: { pid: command.pid, start: processStart(command.pid) } }
    assert.equal(holderIdleMs(holder, { now: () => 5000 + ACTIVE_MAX_MS - 1 }), 0)
    assert.equal(holderIdleMs(holder, { now: () => 5000 + ACTIVE_MAX_MS + 60_000 }), ACTIVE_MAX_MS + 60_000)
  })

  it('hands an idle holder to exactly one cleanup, which a dead cleanup passes on', async () => {
    const { path, checkout } = fresh()
    tryAcquire(path, me('A', checkout, detached().pid), { now: () => 1000 })
    const first = detached()
    const second = detached()
    assert.equal(yieldIfIdle(path, 'A', 60_000, { pid: first.pid, now: () => 30_000 }), false, 'used within the limit')
    const command = detached()
    markUse(path, 'A', { pid: command.pid, now: () => 1000 })
    assert.equal(yieldIfIdle(path, 'A', 60_000, { pid: first.pid, now: () => 120_000 }), false, 'a command is running')
    await kill(command)
    assert.equal(yieldIfIdle(path, 'B', 60_000, { pid: first.pid, now: () => 120_000 }), false, 'B does not hold it')
    assert.equal(yieldIfIdle(path, 'A', 60_000, { pid: first.pid, now: () => 120_000 }), true)
    assert.deepEqual(readLease(path).holder.yielding, { pid: first.pid, start: processStart(first.pid) })
    assert.equal(yieldIfIdle(path, 'A', 60_000, { pid: second.pid, now: () => 120_000 }), false, 'another cleanup is handing it over')
    await kill(first)
    assert.equal(yieldIfIdle(path, 'A', 60_000, { pid: second.pid, now: () => 1000 }), true, 'the handover of a dead cleanup is taken over')
    assert.equal(readLease(path).holder.yielding.pid, second.pid)
  })

  it('refuses markUse once the holder is being handed over', () => {
    const { path, checkout } = fresh()
    tryAcquire(path, me('A', checkout, detached().pid), { now: () => 1000 })
    assert.equal(yieldIfIdle(path, 'A', 0, { pid: detached().pid, now: () => 2000 }), true)
    assert.equal(markUse(path, 'A', { pid: detached().pid, now: () => 3000 }), false)
    const { holder } = readLease(path)
    assert.equal(holder.usedAt, 1000)
    assert.equal(holder.active, undefined)
  })

  it('lets a run rejoin and use its lease after the cleanup that handed it over died', async () => {
    const { path, checkout } = fresh()
    const cleanup = detached()
    tryAcquire(path, me('A', checkout, detached().pid), { now: () => 1000 })
    yieldIfIdle(path, 'A', 0, { pid: cleanup.pid, now: () => 2000 })
    tryAcquire(path, me('A', checkout, detached().pid))
    assert.equal(markUse(path, 'A'), false, 'the handover is still running')
    await kill(cleanup)
    tryAcquire(path, me('A', checkout, detached().pid))
    assert.equal(markUse(path, 'A'), true)
  })

  describe('idle watch', () => {
    const TEN = 10 * 60_000

    it('shuts a run down once it is undriven past the limit with nobody queued', () => {
      const { path, checkout } = fresh()
      tryAcquire(path, me('A', checkout, detached().pid), { now: () => 1000 })
      assert.deepEqual(idleWatchVerdict(readLease(path), 'A', TEN, { now: () => 1000 + TEN }), { action: 'wait', ms: 1000 }, 'at the limit, not past it')
      assert.deepEqual(idleWatchVerdict(readLease(path), 'A', TEN, { now: () => 1000 + 4 * 60_000 }), { action: 'wait', ms: TEN - 4 * 60_000 + 1 }, 'sleeps the rest of the limit')
      assert.deepEqual(idleWatchVerdict(readLease(path), 'A', TEN, { now: () => 1001 + TEN }), { action: 'shutdown' })
    })

    it('never shuts down a run that has a command running', async () => {
      const { path, checkout } = fresh()
      tryAcquire(path, me('A', checkout, detached().pid), { now: () => 1000 })
      const command = detached()
      markUse(path, 'A', { pid: command.pid, now: () => 1000 })
      assert.equal(idleWatchVerdict(readLease(path), 'A', TEN, { now: () => 1000 + 2 * TEN }).action, 'wait')
      await kill(command)
      assert.equal(idleWatchVerdict(readLease(path), 'A', TEN, { now: () => 1000 + 2 * TEN }).action, 'shutdown')
    })

    it('leaves a queued lease to the queue, and counts a dead waiter as nobody', async () => {
      const { path, checkout } = fresh()
      tryAcquire(path, me('A', checkout, detached().pid), { now: () => 1000 })
      const waiter = detached()
      tryAcquire(path, me('B', checkout, waiter.pid))
      assert.equal(idleWatchVerdict(readLease(path), 'A', TEN, { now: () => 1000 + 2 * TEN }).action, 'wait')
      await kill(waiter)
      assert.equal(idleWatchVerdict(readLease(path), 'A', TEN, { now: () => 1000 + 2 * TEN }).action, 'shutdown')
    })

    it('stops watching a run that no longer holds the lease', () => {
      const { path, checkout } = fresh()
      const late = { now: () => 1000 + 2 * TEN }
      assert.equal(idleWatchVerdict(readLease(path), 'A', TEN, late).action, 'stop', 'nobody holds it')
      tryAcquire(path, me('B', checkout, detached().pid), { now: () => 1000 })
      assert.equal(idleWatchVerdict(readLease(path), 'A', TEN, late).action, 'stop', 'another run holds it: its simulator is not ours')
    })

    it('leaves a handover in progress to the cleanup that started it', () => {
      const { path, checkout } = fresh()
      tryAcquire(path, me('A', checkout, detached().pid), { now: () => 1000 })
      yieldIfIdle(path, 'A', 0, { pid: detached().pid, now: () => 2000 })
      assert.equal(idleWatchVerdict(readLease(path), 'A', TEN, { now: () => 1000 + 2 * TEN }).action, 'wait')
    })

    it('takes over a handover whose cleanup died instead of waiting on it forever', async () => {
      const { path, checkout } = fresh()
      tryAcquire(path, me('A', checkout, detached().pid), { now: () => 1000 })
      const cleanup = detached()
      yieldIfIdle(path, 'A', 0, { pid: cleanup.pid, now: () => 2000 })
      const late = { now: () => 1000 + 2 * TEN }
      assert.equal(idleWatchVerdict(readLease(path), 'A', TEN, late).action, 'wait', 'the cleanup is alive')
      await kill(cleanup)
      assert.equal(idleWatchVerdict(readLease(path), 'A', TEN, late).action, 'shutdown')
    })

    it('has yieldIfIdle refuse a shutdown while someone queues, and take it once they are gone', async () => {
      const { path, checkout } = fresh()
      tryAcquire(path, me('A', checkout, detached().pid), { now: () => 1000 })
      const waiter = detached()
      tryAcquire(path, me('B', checkout, waiter.pid))
      const now = () => 1000 + 2 * TEN
      assert.equal(yieldIfIdle(path, 'A', TEN, { pid: detached().pid, now, ifUnqueued: true }), false)
      assert.equal(readLease(path).holder.yielding, undefined)
      await kill(waiter)
      assert.equal(yieldIfIdle(path, 'A', TEN, { pid: detached().pid, now, ifUnqueued: true }), true)
    })
  })

  it('describes the holder for a waiting message', () => {
    const acquiredAt = new Date(2026, 10, 18, 14, 2).getTime()
    const holder = { runId: 'A', checkout: '/work/manor', chatId: '1a2b3c4d-5e6f', acquiredAt, pids: [] }
    assert.equal(describeHolder(holder, acquiredAt + 12 * 60_000), 'chat 1a2b3c4d, checkout /work/manor, since 14:02 (12 minutes)')
    assert.equal(describeHolder({ ...holder, chatId: null }, acquiredAt), 'a run started by hand, checkout /work/manor, since 14:02 (0 minutes)')
  })
})
