import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { OWNER_IDLE_MS, STALE_AFTER_MS, chatRunning, describeAge, parseElapsed, staleVerdict } from './stale-run.mjs'

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
