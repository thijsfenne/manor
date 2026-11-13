import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureScratchDir, ScratchLifecycle, sweepScratch } from '../src/scratch.js'

describe('sweepScratch', () => {
  it('removes dead chats and expired inputs while preserving live work', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-scratch-sweep-'))
    const live = await ensureScratchDir(root, 'chat/live')
    const title = await ensureScratchDir(root, 'title_chat/live')
    const summary = await ensureScratchDir(root, 'summary_chat/live')
    const memory = await ensureScratchDir(root, 'memory_chat/live')
    const dead = await ensureScratchDir(root, 'chat-dead')
    const attachments = path.join(live, 'attachments')
    await mkdir(attachments)
    const old = path.join(attachments, 'old.png')
    const fresh = path.join(attachments, 'fresh.png')
    await Promise.all([writeFile(old, 'old'), writeFile(fresh, 'fresh'), writeFile(path.join(live, 'notes.md'), 'keep')])
    await utimes(old, new Date(0), new Date(0))

    const result = await sweepScratch({
      scratchRoot: root,
      liveChatIds: ['chat/live'],
      now: 10_000,
      retentionMs: 5_000,
    })

    expect(result).toEqual({ directoriesRemoved: 1, attachmentsRemoved: 1 })
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(path.join(live, 'notes.md'))).toBe(true)
    expect(existsSync(title)).toBe(true)
    expect(existsSync(summary)).toBe(true)
    expect(existsSync(memory)).toBe(true)
  })

  it('does not reclaim resources protected by active jobs', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-scratch-active-'))
    const live = await ensureScratchDir(root, 'chat-active')
    const deletedTitle = await ensureScratchDir(root, 'title_deleted-chat')
    const attachments = path.join(live, 'attachments')
    await mkdir(attachments)
    const old = path.join(attachments, 'old.png')
    await writeFile(old, 'old')
    await utimes(old, new Date(0), new Date(0))

    const result = await sweepScratch({
      scratchRoot: root,
      liveChatIds: ['chat-active'],
      protectedThreadIds: ['chat-active', 'title_deleted-chat'],
      now: 10_000,
      retentionMs: 5_000,
    })

    expect(result).toEqual({ directoriesRemoved: 0, attachmentsRemoved: 0 })
    expect(existsSync(old)).toBe(true)
    expect(existsSync(deletedTitle)).toBe(true)
  })

  it('keeps old picture copies when the window is set to keep them', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-scratch-keep-'))
    const live = await ensureScratchDir(root, 'chat-keep')
    const attachments = path.join(live, 'attachments')
    await mkdir(attachments)
    const old = path.join(attachments, 'old.png')
    await writeFile(old, 'old')
    await utimes(old, new Date(0), new Date(0))
    const gone = await ensureScratchDir(root, 'deleted-chat')

    const result = await sweepScratch({ scratchRoot: root, liveChatIds: ['chat-keep'], now: 10_000, retentionMs: null })

    // A deleted chat's folder still goes; only the age rule is off.
    expect(result).toEqual({ directoriesRemoved: 1, attachmentsRemoved: 0 })
    expect(existsSync(old)).toBe(true)
    expect(existsSync(gone)).toBe(false)
  })

  it('does not activate a scratch directory midway through a sweep', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-scratch-lifecycle-'))
    const lifecycle = new ScratchLifecycle(root)
    let releaseScope: () => void = () => undefined
    const scopeGate = new Promise<void>((resolve) => {
      releaseScope = resolve
    })
    let scopeStarted = false
    const sweeping = lifecycle.sweep(async () => {
      scopeStarted = true
      await scopeGate
      return { liveChatIds: [] }
    })
    while (!scopeStarted) await Promise.resolve()

    let activated = false
    const activating = lifecycle.ensure('new-chat').then((dir) => {
      activated = true
      return dir
    })
    await Promise.resolve()
    expect(activated).toBe(false)

    releaseScope()
    const [, dir] = await Promise.all([sweeping, activating])
    expect(existsSync(dir)).toBe(true)
  })

  it('treats a missing scratch root as an empty sweep', async () => {
    await expect(
      sweepScratch({ scratchRoot: path.join(os.tmpdir(), 'manor-scratch-missing'), liveChatIds: [] }),
    ).resolves.toEqual({ directoriesRemoved: 0, attachmentsRemoved: 0 })
  })
})
