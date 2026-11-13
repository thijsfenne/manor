import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileDmTabMemory, parseDmTabMemory } from './dmTabMemory'

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('DM tab memory', () => {
  it('keeps only well-formed chat snapshots', () => {
    const parsed = parseDmTabMemory({
      dm_1: { urls: ['https://mail.google.com/', 12, 'https://calendar.google.com/'], activeIndex: 4 },
      '': { urls: ['https://example.com/'], activeIndex: 0 },
      junk: { urls: [], activeIndex: 0 },
      other: 'nope',
    })
    expect([...parsed]).toEqual([
      ['dm_1', { urls: ['https://mail.google.com/', 'https://calendar.google.com/'], activeIndex: 1 }],
    ])
  })

  it('reads old snapshots and bounds saved pin counts', () => {
    const parsed = parseDmTabMemory({
      old: { urls: ['https://example.com/'], activeIndex: 0 },
      pinned: { urls: ['https://one.example/', 'https://two.example/'], activeIndex: 1, pinnedCount: 99 },
      invalid: { urls: ['https://three.example/'], activeIndex: 0, pinnedCount: -1 },
    })
    expect(parsed.get('old')).toEqual({ urls: ['https://example.com/'], activeIndex: 0 })
    expect(parsed.get('pinned')?.pinnedCount).toBe(2)
    expect(parsed.get('invalid')?.pinnedCount).toBeUndefined()
  })

  it('round-trips through a file and treats a missing file as empty', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'manor-dm-tabs-'))
    scratch.push(directory)
    const filePath = path.join(directory, 'dm-browser-tabs.json')
    const memory = createFileDmTabMemory(filePath)
    expect(memory.load().size).toBe(0)

    memory.save(new Map([['dm_1', { urls: ['https://mail.google.com/'], activeIndex: 0 }]]))
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      dm_1: { urls: ['https://mail.google.com/'], activeIndex: 0 },
    })
    expect([...createFileDmTabMemory(filePath).load()]).toEqual([
      ['dm_1', { urls: ['https://mail.google.com/'], activeIndex: 0 }],
    ])
  })
})
