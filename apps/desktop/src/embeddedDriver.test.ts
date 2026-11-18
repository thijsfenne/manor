import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EmbeddedDriver, embeddedDriverPath } from './embeddedDriver'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: string[] = []
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal)
    queueMicrotask(() => { this.signalCode = signal; this.emit('exit', null, signal); this.emit('close', null, signal) })
    return true
  }
}

function fakeSpawn() {
  const children: FakeChild[] = []
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; othersGone: boolean }[] = []
  const spawn = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ command, args, env, othersGone: children.every((child) => child.signalCode !== null) })
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcess
  }
  return { children, calls, spawn }
}

describe('embeddedDriverPath', () => {
  it('finds the driver only where the release build put it', () => {
    const resources = mkdtempSync(path.join(os.tmpdir(), 'manor-res-'))
    expect(embeddedDriverPath(resources)).toBeNull()
    mkdirSync(path.join(resources, 'cua-driver'))
    writeFileSync(path.join(resources, 'cua-driver', 'cua-driver'), '')
    expect(embeddedDriverPath(resources)).toBe(path.join(resources, 'cua-driver', 'cua-driver'))
  })
})

describe('EmbeddedDriver', () => {
  it('starts the daemon in embedded mode on a private socket and keeps HOME', () => {
    const fake = fakeSpawn()
    const driver = new EmbeddedDriver('/app/cua-driver', { HOME: '/Users/sam' }, fake.spawn)
    driver.start()
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.args).toEqual(['serve', '--embedded', '--socket', driver.socket, '--host-bundle-id', 'com.thijsfenne.manor'])
    expect(fake.calls[0]?.env).toMatchObject({
      HOME: '/Users/sam', CUA_DRIVER_EMBEDDED: '1', CUA_DRIVER_PARENT_LIVENESS_STDIN: '1',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: '0', CUA_DRIVER_RS_UPDATE_CHECK: '0',
    })
    driver.stop()
  })

  it('restarts by stopping the old daemon first and removing its socket', async () => {
    const fake = fakeSpawn()
    const driver = new EmbeddedDriver('/app/cua-driver', {}, fake.spawn)
    driver.start()
    writeFileSync(driver.socket, '')
    await driver.restart()
    expect(fake.children[0]?.signals).toEqual(['SIGTERM'])
    expect(fake.calls).toHaveLength(2)
    // The daemon refuses a socket path that exists.
    expect(existsSync(driver.socket)).toBe(false)
    driver.stop()
    expect(fake.children[1]?.signals).toEqual(['SIGTERM'])
    expect(existsSync(path.dirname(driver.socket))).toBe(false)
  })

  it('does not bring a stopped daemon back', async () => {
    const fake = fakeSpawn()
    const driver = new EmbeddedDriver('/app/cua-driver', {}, fake.spawn)
    driver.start()
    driver.stop()
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(fake.calls).toHaveLength(1)
  })

  it('shares one restart between calls that overlap', async () => {
    const fake = fakeSpawn()
    const driver = new EmbeddedDriver('/app/cua-driver', {}, fake.spawn)
    driver.start()
    await Promise.all([driver.restart(), driver.restart()])
    expect(fake.calls).toHaveLength(2)
    // The replacement removes the socket path, so it may only start once the old daemon is gone.
    expect(fake.calls[1]?.othersGone).toBe(true)
    driver.stop()
  })

  it('tries again after a spawn that failed without an exit', async () => {
    const fake = fakeSpawn()
    const driver = new EmbeddedDriver('/app/cua-driver', {}, fake.spawn)
    driver.start()
    fake.children[0]?.emit('error', new Error('spawn ENOENT'))
    fake.children[0]?.emit('close', -2, null)
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(fake.calls).toHaveLength(2)
    driver.stop()
  })
})
