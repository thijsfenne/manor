import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export const SCRATCH_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const directoryName = (threadId: string): string => threadId.replace(/[^a-zA-Z0-9_-]/g, '_')

/** Creates the empty scratch directory one thread's turns run in. */
export async function ensureScratchDir(scratchRoot: string, threadId: string): Promise<string> {
  const dir = path.join(scratchRoot, directoryName(threadId))
  await mkdir(dir, { recursive: true })
  return dir
}

export interface ScratchSweepResult {
  directoriesRemoved: number
  attachmentsRemoved: number
}

export interface ScratchSweepScope {
  liveChatIds: readonly string[]
  protectedThreadIds?: readonly string[]
  /** How old a picture copy may get; null keeps them. Defaults to seven days. */
  retentionMs?: number | null
}

/**
 * Serialises activation and reclamation. A job becomes visible in the service before
 * it asks for its directory, so a sweep either finishes before that activation or
 * takes a fresh protection snapshot after it.
 */
export class ScratchLifecycle {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly scratchRoot: string) {}

  ensure(threadId: string): Promise<string> {
    return this.exclusive(() => ensureScratchDir(this.scratchRoot, threadId))
  }

  sweep(scope: () => Promise<ScratchSweepScope> | ScratchSweepScope): Promise<ScratchSweepResult> {
    return this.exclusive(async () => {
      const current = await scope()
      return sweepScratch({ scratchRoot: this.scratchRoot, ...current })
    })
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: () => void = () => undefined
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }
}

/**
 * Reclaims deleted chats and old materialised inputs without touching working files
 * a live CLI session may still expect. Missing paths are an ordinary empty sweep.
 */
export async function sweepScratch(options: {
  scratchRoot: string
  liveChatIds: readonly string[]
  protectedThreadIds?: readonly string[]
  now?: number
  retentionMs?: number | null
}): Promise<ScratchSweepResult> {
  const now = options.now ?? Date.now()
  const retentionMs = options.retentionMs === undefined ? SCRATCH_ATTACHMENT_RETENTION_MS : options.retentionMs
  const live = new Set(
    options.liveChatIds.flatMap((chatId) => [
      directoryName(chatId),
      directoryName(`title_${chatId}`),
      directoryName(`summary_${chatId}`),
      directoryName(`memory_${chatId}`),
    ]),
  )
  const protectedDirectories = new Set((options.protectedThreadIds ?? []).map(directoryName))
  const entries = await readdir(options.scratchRoot, { withFileTypes: true }).catch(() => [])
  let directoriesRemoved = 0
  let attachmentsRemoved = 0

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const threadRoot = path.join(options.scratchRoot, entry.name)
    if (!live.has(entry.name) && !protectedDirectories.has(entry.name)) {
      await rm(threadRoot, { recursive: true, force: true })
      directoriesRemoved += 1
      continue
    }
    if (protectedDirectories.has(entry.name) || retentionMs === null) continue

    const attachmentRoot = path.join(threadRoot, 'attachments')
    const attachments = await readdir(attachmentRoot, { withFileTypes: true }).catch(() => [])
    for (const attachment of attachments) {
      if (!attachment.isFile()) continue
      const target = path.join(attachmentRoot, attachment.name)
      const info = await stat(target).catch(() => undefined)
      if (info === undefined || now - info.mtimeMs < retentionMs) continue
      await rm(target, { force: true })
      attachmentsRemoved += 1
    }
  }

  return { directoriesRemoved, attachmentsRemoved }
}
