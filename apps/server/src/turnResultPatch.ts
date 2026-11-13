import type { ThreadEvent } from '@manor/contracts'
import type { Store } from './store.js'

type TurnResultEvent = Extract<ThreadEvent, { type: 'turn_result' }>

type PatchStore = Pick<Store, 'loadEvents' | 'replaceEvent'>

const queues = new WeakMap<PatchStore, Map<string, Promise<void>>>()

/**
 * Rewrites a finished turn's `turn_result` after the turn closed, and broadcasts it.
 *
 * The memory judgment and the daily-log writer each add their own field to the same
 * result, seconds after the turn ended and in either order. Each load, replace and
 * emit waits for the previous one in the same chat, so neither can write back a copy
 * read before the other's field landed. `change` returns undefined to leave it as is.
 */
export function patchTurnResult(
  store: PatchStore,
  emit: (event: TurnResultEvent) => void,
  chatId: string,
  turnId: string,
  change: (result: TurnResultEvent) => TurnResultEvent | undefined,
): Promise<void> {
  const chats = queues.get(store) ?? new Map<string, Promise<void>>()
  queues.set(store, chats)
  const patch = async () => {
    const target = [...await store.loadEvents(chatId)].reverse().find(
      (event) => event.type === 'turn_result' && event.turnId === turnId,
    )
    if (target?.type !== 'turn_result') return
    const updated = change(target)
    if (updated === undefined) return
    await store.replaceEvent(chatId, updated)
    emit(updated)
  }
  const queued = (chats.get(chatId) ?? Promise.resolve()).then(patch)
  const settled = queued.catch(() => undefined)
  chats.set(chatId, settled)
  void settled.then(() => {
    if (chats.get(chatId) === settled) chats.delete(chatId)
  })
  return queued
}
