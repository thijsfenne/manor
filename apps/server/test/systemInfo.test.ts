import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerMessage } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { ManorService } from '../src/service.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { createSystemInfo } from '../src/systemInfo.js'
import { roster, scratchFor } from './helpers.js'

describe('system info logs', () => {
  it('lists only the logs on disk and reveals nothing outside that list', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'manor-home-'))
    mkdirSync(path.join(home, 'Library', 'Logs'), { recursive: true })
    const serverLog = path.join(home, 'Library', 'Logs', 'manor.log')
    writeFileSync(serverLog, 'started\n', 'utf8')
    const open = vi.fn(async () => undefined)
    const manor = new ManorService({
      store: createMemoryStore({ agents: roster }), agents: () => roster, setAgents: () => {},
      mcpServers: () => [], setMcpServers: () => {}, resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor, broadcast: () => {},
      externalFiles: { apps: ['finder'], open },
      systemInfo: createSystemInfo({ memoryDir: null, vaultDir: null, drivers: {}, home }),
    })
    const replies: ServerMessage[] = []
    const reply = (message: ServerMessage) => replies.push(message)

    await manor.handle({ type: 'get_system_info', requestId: 'info' }, reply)
    expect(replies.at(-1)).toMatchObject({
      type: 'system_info',
      info: { memory: { path: null }, logs: [{ label: 'Server log', path: serverLog }] },
    })

    await manor.handle({ type: 'reveal_log', path: serverLog, requestId: 'listed' }, reply)
    expect(open).toHaveBeenCalledWith('finder', serverLog)
    expect(replies.at(-1)).toEqual({ type: 'ack', requestId: 'listed' })

    await manor.handle({ type: 'reveal_log', path: path.join(home, '.ssh', 'id_rsa'), requestId: 'other' }, reply)
    expect(open).toHaveBeenCalledTimes(1)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', text: 'That log is not one Manor lists.' })
  })

  it('says which folders the next start will use and shows a folder in Finder', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'manor-home-'))
    const open = vi.fn(async () => undefined)
    const store = createMemoryStore({ agents: roster })
    const manor = new ManorService({
      store, agents: () => roster, setAgents: () => {},
      mcpServers: () => [], setMcpServers: () => {}, resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor, broadcast: () => {},
      externalFiles: { apps: ['finder'], open },
      systemInfo: createSystemInfo({
        memoryDir: '/data/memory', vaultDir: null, drivers: {}, home,
        folders: async () => {
          const picked = (await store.getHouseSettings()).memoryDir
          return {
            memory: { pinned: false, pending: picked === null || picked === '/data/memory' ? null : picked },
            knowledge: { pinned: true, pending: null },
          }
        },
      }),
    })
    const replies: ServerMessage[] = []
    const reply = (message: ServerMessage) => replies.push(message)

    await manor.handle({ type: 'save_house_settings', settings: { ...await store.getHouseSettings(), memoryDir: '/Users/someone/Notes' } }, reply)
    await manor.handle({ type: 'get_system_info' }, reply)
    expect(replies.at(-1)).toMatchObject({
      type: 'system_info',
      info: {
        memory: { path: '/data/memory', pinned: false, pending: '/Users/someone/Notes' },
        vault: { path: null, pinned: true, pending: null },
      },
    })

    await manor.handle({ type: 'save_house_settings', settings: { ...await store.getHouseSettings(), memoryDir: 'Notes' }, requestId: 'bad' }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', text: 'Give the full path of a folder.' })
    expect((await store.getHouseSettings()).memoryDir).toBe('/Users/someone/Notes')

    await manor.handle({ type: 'reveal_folder', folder: 'memory', requestId: 'shown' }, reply)
    expect(open).toHaveBeenCalledWith('finder', '/data/memory')
    await manor.handle({ type: 'reveal_folder', folder: 'knowledge', requestId: 'none' }, reply)
    expect(open).toHaveBeenCalledTimes(1)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
  })
})
