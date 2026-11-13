import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentConfig, RuntimeEvent } from '@manor/contracts'
import { createClaudeDriver } from '../src/drivers/claudeDriver.js'
import { readClaudeProviderUsage } from '../src/drivers/claudeUsage.js'
import { readCodexProviderUsage } from '../src/drivers/codexUsage.js'
import { readGrokProviderUsage } from '../src/drivers/grokUsage.js'
import { cliTreeGone, isSignallableGroupPid, stopAllCliChildren, terminateCliTree, trackCliChild } from '../src/drivers/childTermination.js'

describe('CLI shutdown', () => {
  it('stops a child outside an active chat turn and refuses late starts', async () => {
    class FakeChild extends EventEmitter {
      readonly pid = 99990
      readonly signals: NodeJS.Signals[] = []
      kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        this.signals.push(signal)
        return true
      }
    }

    const active = new FakeChild()
    trackCliChild(active)
    expect(await stopAllCliChildren()).toBe(1)
    expect(active.signals).toEqual(['SIGTERM'])

    const late = new FakeChild()
    trackCliChild(late)
    await vi.waitFor(() => expect(late.signals).toEqual(['SIGTERM']))
    active.emit('close', 0)
    late.emit('close', 0)

    const agent: AgentConfig = {
      id: 'sage', name: 'Sage', color: '#6FA8A0', character: 'You are Sage.',
      driver: 'claude', effort: 'low', allowedTools: [], mcpServers: [],
      memoryScope: false, role: '', description: '', isCos: false,
    }
    let spawns = 0
    const driver = createClaudeDriver({ agents: () => [agent], spawnFn: () => {
      spawns += 1
      throw new Error('spawned after shutdown')
    } })
    const events: RuntimeEvent[] = []
    for await (const event of driver.startTurn({
      agent, threadId: 'background', cwd: '/tmp', repoPaths: [],
      catchUp: [], isFullCatchUp: true, infrastructure: true,
    }).events) events.push(event)
    expect(spawns).toBe(0)
    expect(events).toEqual([{ type: 'error', message: 'server is shutting down' }])

    const noProbeSpawn = () => {
      spawns += 1
      throw new Error('usage probe spawned after shutdown')
    }
    const probeStatuses = await Promise.all([
      readClaudeProviderUsage({ command: 'claude', cwd: '/tmp', spawnFn: noProbeSpawn }),
      readCodexProviderUsage({ command: 'codex', cwd: '/tmp', codexHome: async () => '/tmp', spawnFn: noProbeSpawn }),
      readGrokProviderUsage({ command: 'agent', cwd: '/tmp', usageHome: '/tmp', grokHome: '/tmp', spawnFn: noProbeSpawn }),
    ])
    expect(probeStatuses.map((usage) => usage.status)).toEqual(['unavailable', 'unavailable', 'unavailable'])
    expect(spawns).toBe(0)
  })
})

describe('CLI tree termination', () => {
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true } catch { return false }
  }

  it('reaches background work left in the group after the CLI exited', async () => {
    const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-tree-')), 'work.pid')
    const cli = `const work = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      work.unref()
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(work.pid))`
    const root = spawn(process.execPath, ['-e', cli], { detached: true, stdio: 'ignore' })
    await once(root, 'close')
    const work = Number(readFileSync(pidFile, 'utf8'))
    try {
      expect(alive(work)).toBe(true)
      await cliTreeGone(root)
      expect(alive(work)).toBe(false)
    } finally {
      if (alive(work)) process.kill(work, 'SIGKILL')
    }
  })

  it('kills what a tracked CLI left in its group when it exits on its own', async () => {
    const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-tree-')), 'mcp.pid')
    const cli = `const mcp = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      mcp.unref()
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(mcp.pid))`
    // A fresh module: the shutdown test above leaves this one's server shutting down.
    vi.resetModules()
    const fresh = await import('../src/drivers/childTermination.js')
    const root = spawn(process.execPath, ['-e', cli], { detached: true, stdio: 'ignore' })
    fresh.trackCliChild(root)
    await once(root, 'close')
    const mcp = Number(readFileSync(pidFile, 'utf8'))
    try {
      await vi.waitFor(() => expect(alive(mcp)).toBe(false))
    } finally {
      if (alive(mcp)) process.kill(mcp, 'SIGKILL')
    }
  })

  it('reaches work a TERM handler starts in the group on its way out', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'manor-tree-'))
    const [workFile, replacementFile] = [path.join(scratch, 'work.pid'), path.join(scratch, 'replacement.pid')]
    const work = `process.on('SIGTERM', () => {
        const next = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        require('node:fs').writeFileSync(${JSON.stringify(replacementFile)}, String(next.pid))
        setTimeout(() => process.exit(0), 30)
      })
      require('node:fs').writeFileSync(${JSON.stringify(workFile)}, String(process.pid))
      setInterval(() => {}, 1000)`
    const cli = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(work)}], { stdio: 'ignore' }).unref()
      const ready = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(workFile)})) clearInterval(ready) }, 10)`
    const root = spawn(process.execPath, ['-e', cli], { detached: true, stdio: 'ignore' })
    await once(root, 'close')
    const pids = () => [workFile, replacementFile].flatMap((file) => existsSync(file) ? [Number(readFileSync(file, 'utf8'))] : [])
    try {
      await cliTreeGone(root)
      expect(pids()).toHaveLength(2)
      expect(pids().filter(alive)).toEqual([])
    } finally {
      for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  it('does not confirm a tree whose process outlived the KILL', async () => {
    const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    const pid = survivor.pid!
    const signal = process.kill.bind(process)
    // Every signal to it is refused, the way a process stuck in the kernel ignores KILL.
    const refused = vi.spyOn(process, 'kill').mockImplementation((target, name) => {
      if (Math.abs(target) !== pid) return signal(target, name)
      if (name === 0) return true
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    try {
      expect(await cliTreeGone({ pid, kill: () => true, on: () => {} })).toBe(false)
      expect(refused.mock.calls.some(([target, name]) => Math.abs(target) === pid && name === 'SIGKILL')).toBe(true)
    } finally {
      refused.mockRestore()
      survivor.kill('SIGKILL')
    }
  })
})

describe('process group guard', () => {
  it('never signals a group for pid 0 or 1, which would reach the server or every user process', async () => {
    // Never call through: on a regression this would really send kill(-1).
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const signals: NodeJS.Signals[] = []
      const fake = Object.assign(new EventEmitter(), {
        pid: 1,
        kill(signal: NodeJS.Signals = 'SIGTERM') { signals.push(signal); return true },
      })
      await terminateCliTree(fake)
      expect(signals).toEqual(['SIGTERM'])
      expect(kill.mock.calls.some(([pid]) => pid === -1 || pid === 0 || pid === 1)).toBe(false)
      expect([0, 1, -5, Number.NaN, undefined].map(isSignallableGroupPid)).toEqual([false, false, false, false, false])
      expect(isSignallableGroupPid(4242)).toBe(true)
    } finally {
      kill.mockRestore()
    }
  })
})

describe('Stop on a CLI that ignores SIGTERM and hangs mid-stream', () => {
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true } catch { return false }
  }
  const sage = (driver: AgentConfig['driver']): AgentConfig => ({
    id: 'sage', name: 'Sage', color: '#6FA8A0', character: 'You are Sage.', driver, effort: 'low',
    allowedTools: [], mcpServers: [], memoryScope: false, role: '', description: '', isCos: false,
  })

  for (const name of ['claude', 'codex', 'cursor', 'grok'] as const) {
    it(`${name}: ends the turn at once and KILLs the CLI and its grandchild after the grace`, async () => {
      // A fresh module graph: the shutdown test above leaves the shared one refusing spawns.
      vi.resetModules()
      const scratch = mkdtempSync(path.join(os.tmpdir(), 'manor-stop-'))
      const grandFile = path.join(scratch, 'grand.pid')
      const grand = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(grandFile)}, String(process.pid)); setInterval(() => {}, 1000)`
      // TERM-deaf, with a TERM-deaf grandchild holding its stdout open, silent after one line.
      const cli = `process.on('SIGTERM', () => {})
        require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: ['ignore', 'inherit', 'inherit'] })
        process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\\n')
        setInterval(() => {}, 1000)`
      let cliPid = 0
      const spawnFn = () => {
        const child = spawn(process.execPath, ['-e', cli], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
        cliPid = child.pid!
        return child
      }
      const agents = () => [sage(name)]
      const driver = name === 'claude' ? (await import('../src/drivers/claudeDriver.js')).createClaudeDriver({ agents, command: 'fake', spawnFn })
        : name === 'codex' ? (await import('../src/drivers/codexDriver.js')).createCodexDriver({ agents, command: 'fake', personalSkillManifests: async () => [], spawnFn })
          : name === 'cursor' ? (await import('../src/drivers/cursorDriver.js')).createCursorDriver({ agents, command: 'fake', spawnFn })
            : (await import('../src/drivers/grokDriver.js')).createGrokDriver({ agents, command: 'fake', spawnFn })
      const handle = driver.startTurn({
        agent: sage(name), threadId: 'main', cwd: scratch, repoPaths: [], isFullCatchUp: true,
        catchUp: [{ id: 'evt_1', ts: 1, type: 'user_message', text: 'Hi', mentions: ['sage'] }],
      })
      const drained = (async () => { for await (const _ of handle.events) { /* drain */ } })()
      await vi.waitFor(() => expect(existsSync(grandFile)).toBe(true), { timeout: 8_000, interval: 20 })
      const grandPid = Number(readFileSync(grandFile, 'utf8'))
      try {
        const stoppedAt = Date.now()
        handle.stop()
        await drained
        expect(Date.now() - stoppedAt).toBeLessThan(1_000)
        // Both shrugged off the TERM; only the KILL after the grace takes them down.
        expect(alive(cliPid) || alive(grandPid)).toBe(true)
        await vi.waitFor(() => expect([alive(cliPid), alive(grandPid)]).toEqual([false, false]), { timeout: 4_000, interval: 50 })
      } finally {
        for (const pid of [cliPid, grandPid]) if (alive(pid)) process.kill(pid, 'SIGKILL')
      }
    }, 20_000)
  }
})
