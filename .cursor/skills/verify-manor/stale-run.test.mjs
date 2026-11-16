import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { OWNER_IDLE_MS, STALE_AFTER_MS, chatRunning, cwdOf, describeAge, parseElapsed, staleReason, staleVerdict } from './stale-run.mjs'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

describe('staleVerdict', () => {
  it('calls a run over a day old stale, even without a chat', () => {
    assert.equal(staleVerdict({ ageMs: STALE_AFTER_MS + 1, idleMs: 0, ownerRunning: null }), 'old')
    assert.equal(staleVerdict({ ageMs: 43 * HOUR, idleMs: HOUR, ownerRunning: false }), 'old')
  })

  it('calls a run stale when its owner has no running turn and left it alone for a while', () => {
    assert.equal(staleVerdict({ ageMs: HOUR, idleMs: OWNER_IDLE_MS + 1, ownerRunning: false }), 'owner-gone')
  })

  it('keeps a run whose owner has a running turn, however old it is', () => {
    assert.equal(staleVerdict({ ageMs: 43 * HOUR, idleMs: 40 * HOUR, ownerRunning: true }), undefined)
    assert.equal(staleVerdict({ ageMs: HOUR, idleMs: HOUR, ownerRunning: true }), undefined)
  })

  it('keeps a young run whose owner is between two turns, and a young run nobody can name', () => {
    assert.equal(staleVerdict({ ageMs: HOUR, idleMs: 5 * MINUTE, ownerRunning: false }), undefined)
    assert.equal(staleVerdict({ ageMs: HOUR, idleMs: 10 * HOUR, ownerRunning: null }), undefined)
  })

  it('calls a run whose checkout is gone stale at any age, unless its owner has a turn running', () => {
    assert.equal(staleVerdict({ ageMs: 2 * MINUTE, idleMs: 0, ownerRunning: null, checkoutGone: true }), 'checkout-gone')
    assert.equal(staleVerdict({ ageMs: 2 * MINUTE, idleMs: 0, ownerRunning: false, checkoutGone: true }), 'checkout-gone')
    assert.equal(staleVerdict({ ageMs: 2 * MINUTE, idleMs: 0, ownerRunning: true, checkoutGone: true }), undefined)
    assert.equal(staleReason('checkout-gone', 2 * MINUTE, null), 'its checkout no longer exists')
  })
})

describe('cwdOf', () => {
  it('still names the folder a process runs from after that folder was removed', async () => {
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'stale-run-checkout-')))
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: checkout, stdio: 'ignore' })
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      rmSync(checkout, { recursive: true })
      assert.equal(cwdOf(child.pid), checkout)
      assert.equal(existsSync(checkout), false)
    } finally {
      child.kill('SIGKILL')
    }
    assert.equal(cwdOf(0), undefined)
  })
})

describe('chatRunning', () => {
  // lsof prints real paths, and /var/folders is a symlink on macOS.
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'stale-run-')))
  const chat = '11111111-2222-3333-4444-555555555555'
  const children = []
  after(() => {
    for (const child of children) child.kill('SIGKILL')
    rmSync(data, { recursive: true, force: true })
  })

  // A real process whose working directory is where a provider CLI would run.
  const runIn = async (cwd) => {
    mkdirSync(cwd, { recursive: true })
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' })
    children.push(child)
    await new Promise((resolve) => setTimeout(resolve, 300))
    return child
  }

  it('sees a turn running in the chat scratch folder or a persona folder inside it', async () => {
    assert.equal(chatRunning(chat, data), false)
    const turn = await runIn(join(data, 'scratch', chat, 'sage'))
    assert.equal(chatRunning(chat, data), true)
    assert.equal(chatRunning('99999999-2222-3333-4444-555555555555', data), false)
    turn.kill('SIGKILL')
    await new Promise((resolve) => turn.once('exit', resolve))
    assert.equal(chatRunning(chat, data), false)
  })

  it('finds a chat under any data folder when only the chat is known', async () => {
    const other = '77777777-2222-3333-4444-555555555555'
    assert.equal(chatRunning(other, undefined), false)
    const turn = await runIn(join(data, 'scratch', other))
    assert.equal(chatRunning(other, undefined), true)
    assert.equal(chatRunning(other, '/somewhere/else'), false)
    assert.equal(chatRunning(other, undefined, [`/a/scratch/${other}-not`, `/a/scratch/x${other}`]), false)
    turn.kill('SIGKILL')
    await new Promise((resolve) => turn.once('exit', resolve))
    assert.equal(chatRunning(other, undefined), false)
  })

  it('does not call the owner gone when the process list could not be read', () => {
    assert.equal(chatRunning(chat, data, []), true)
  })
})

describe('describing a run', () => {
  it('reads ps elapsed time and prints an age in words', () => {
    assert.equal(parseElapsed('1-19:02:11'), (24 + 19) * HOUR + 2 * MINUTE + 11_000)
    assert.equal(parseElapsed('05:30'), 5 * MINUTE + 30_000)
    assert.equal(describeAge((24 + 19) * HOUR), '1 day 19 hours')
    assert.equal(describeAge(12 * MINUTE), '12 minutes')
  })
})
