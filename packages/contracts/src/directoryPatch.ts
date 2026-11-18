import type { ServerMessage } from './index.js'

/**
 * The directory is the whole sidebar, broadcast again on every message, turn end and
 * title change while usually one or two chats moved. The server diffs each socket's
 * next listing against the last one that socket received (`diffDirectory`), and the
 * client rebuilds the whole listing from its own copy (`applyDirectoryPatch`), so
 * everything past the socket keeps reading an ordinary `directory`.
 */
export type DirectoryMessage = Extract<ServerMessage, { type: 'directory' }>
export type DirectoryPatchMessage = Extract<ServerMessage, { type: 'directory_patch' }>

interface ListPatch<T> {
  changed: T[]
  order?: string[]
}

type WholeFields = Pick<DirectoryMessage, 'awaitingInput' | 'runningTurns' | 'nativeSubagents' | 'backgroundChatIds' | 'backgroundWork'>

// Directory items are never mutated once built, so an encoding holds for as long as
// its item lives, and a base diffed for every socket in a broadcast is encoded once.
const encodings = new WeakMap<object, string>()

function encoded(item: object): string {
  let text = encodings.get(item)
  if (text === undefined) {
    text = JSON.stringify(item)
    encodings.set(item, text)
  }
  return text
}

function diffList<T extends { id: string }>(base: readonly T[], next: readonly T[]): ListPatch<T> {
  const before = new Map(base.map((item) => [item.id, item]))
  const changed = next.filter((item) => {
    const old = before.get(item.id)
    return old === undefined || (old !== item && encoded(old) !== encoded(item))
  })
  const moved = base.length !== next.length || next.some((item, index) => base[index]?.id !== item.id)
  return moved ? { changed, order: next.map((item) => item.id) } : { changed }
}

function applyList<T extends { id: string }>(base: T[], patch: ListPatch<T>): T[] {
  if (patch.changed.length === 0 && patch.order === undefined) return base
  const changed = new Map(patch.changed.map((item) => [item.id, item]))
  if (patch.order === undefined) return base.map((item) => changed.get(item.id) ?? item)
  const before = new Map(base.map((item) => [item.id, item]))
  return patch.order.flatMap((id) => {
    const item = changed.get(id) ?? before.get(id)
    return item === undefined ? [] : [item]
  })
}

/** The small fields travel whole on both messages, and one a listing left out stays out. */
function wholeFields(message: WholeFields): WholeFields {
  const fields: WholeFields = {}
  if (message.awaitingInput !== undefined) fields.awaitingInput = message.awaitingInput
  if (message.runningTurns !== undefined) fields.runningTurns = message.runningTurns
  if (message.nativeSubagents !== undefined) fields.nativeSubagents = message.nativeSubagents
  if (message.backgroundChatIds !== undefined) fields.backgroundChatIds = message.backgroundChatIds
  if (message.backgroundWork !== undefined) fields.backgroundWork = message.backgroundWork
  return fields
}

/** What turns `base` into `next` for a client that already holds `base`. */
export function diffDirectory(base: DirectoryMessage, next: DirectoryMessage): DirectoryPatchMessage {
  return {
    type: 'directory_patch',
    projects: diffList(base.projects, next.projects),
    chats: diffList(base.chats, next.chats),
    workHandoffs: diffList(base.workHandoffs, next.workHandoffs),
    ...(next.subagents === undefined ? {} : { subagents: diffList(base.subagents ?? [], next.subagents) }),
    ...wholeFields(next),
  }
}

/**
 * The whole listing a patch stands for. Unchanged items are the base's own objects,
 * and a list with nothing changed is the base's own array, so a renderer keyed on
 * identity redraws only what moved.
 */
export function applyDirectoryPatch(base: DirectoryMessage, patch: DirectoryPatchMessage): DirectoryMessage {
  return {
    type: 'directory',
    projects: applyList(base.projects, patch.projects),
    chats: applyList(base.chats, patch.chats),
    workHandoffs: applyList(base.workHandoffs, patch.workHandoffs),
    ...(patch.subagents === undefined ? {} : { subagents: applyList(base.subagents ?? [], patch.subagents) }),
    ...wholeFields(patch),
  }
}
