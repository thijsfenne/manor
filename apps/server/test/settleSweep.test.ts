import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTO_SETTLE_AFTER_MS, sweepIdleChats } from '../src/settleSweep.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'

const AT = (iso: string) => new Date(iso).getTime()

/**
 * The sweep against a real store. Time is driven rather than waited on: what is under
 * test is the window, and a test that slept two days would not be one.
 */
async function house() {
  const store = createMemoryStore()
  const [project] = await store.listProjects()
  if (project === undefined) throw new Error('the memory store should seed a project')
  return { store, projectId: project.id }
}

const settledAtOf = async (store: Awaited<ReturnType<typeof house>>['store'], chatId: string) =>
  (await store.listChats()).find((chat) => chat.id === chatId)?.settledAt

describe('sweepIdleChats', () => {
  afterEach(() => void vi.useRealTimers())

  it('settles what has gone quiet and leaves everything still moving alone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(AT('2026-08-05T09:00:00Z'))
    const { store, projectId } = await house()
    const stale = await store.createChat({ projectId, title: 'Three days ago' })
    vi.setSystemTime(AT('2026-08-08T08:00:00Z'))
    const fresh = await store.createChat({ projectId, title: 'This morning' })

    vi.setSystemTime(AT('2026-08-08T09:00:00Z'))
    const settled = await sweepIdleChats({ store })

    expect(settled).toContain(stale.id)
    expect(settled).not.toContain(fresh.id)
    expect(await settledAtOf(store, stale.id)).toBe(AT('2026-08-08T09:00:00Z'))
    expect(await settledAtOf(store, fresh.id)).toBeNull()
  })

  // The whole point of `unsettled_at`: a chat the user just pulled back out of the
  // settled list must not be put straight back by the next hour's sweep.
  it('leaves a chat the user picked back up inside the window alone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(AT('2026-08-05T09:00:00Z'))
    const { store, projectId } = await house()
    const rescued = await store.createChat({ projectId, title: 'Old but wanted' })

    // Settled by an earlier sweep, then pulled back out an hour ago.
    await store.setChatSettled(rescued.id, true)
    vi.setSystemTime(AT('2026-08-08T08:00:00Z'))
    await store.setChatSettled(rescued.id, false)

    vi.setSystemTime(AT('2026-08-08T09:00:00Z'))
    const settled = await sweepIdleChats({ store })

    expect(settled).not.toContain(rescued.id)
    expect(await settledAtOf(store, rescued.id)).toBeNull()
  })

  it('settles a rescued chat once the grace has passed too', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(AT('2026-08-01T09:00:00Z'))
    const { store, projectId } = await house()
    const rescued = await store.createChat({ projectId, title: 'Rescued and then forgotten' })
    await store.setChatSettled(rescued.id, true)
    vi.setSystemTime(AT('2026-08-02T09:00:00Z'))
    await store.setChatSettled(rescued.id, false)

    vi.setSystemTime(AT('2026-08-08T09:00:00Z'))

    expect(await sweepIdleChats({ store })).toContain(rescued.id)
  })

  it('never re-settles a chat that is already settled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(AT('2026-08-01T09:00:00Z'))
    const { store, projectId } = await house()
    const put = await store.createChat({ projectId, title: 'Put down by hand' })
    await store.setChatSettled(put.id, true)
    const stamp = await settledAtOf(store, put.id)

    vi.setSystemTime(AT('2026-08-08T09:00:00Z'))
    const settled = await sweepIdleChats({ store })

    expect(settled).not.toContain(put.id)
    // The stamp is when the user settled it, and a sweep must not rewrite that.
    expect(await settledAtOf(store, put.id)).toBe(stamp)
  })

  // A dm and a group are endless threads: they have no inbox to leave, so however
  // long they sit quiet the sweep walks past them.
  it('never settles a dm or a group, however quiet', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(AT('2026-08-01T09:00:00Z'))
    const { store, projectId } = await house()
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const group = await store.createChat({ kind: 'group', memberIds: ['sage', 'smith'], title: 'The two of them' })
    const room = await store.createChat({ projectId, title: 'A room chat, for contrast' })

    vi.setSystemTime(AT('2026-08-08T09:00:00Z'))
    const settled = await sweepIdleChats({ store })

    expect(settled).toContain(room.id)
    expect(settled).not.toContain(dm.id)
    expect(settled).not.toContain(group.id)
    expect(await settledAtOf(store, dm.id)).toBeNull()
    expect(await settledAtOf(store, group.id)).toBeNull()
  })

  // The window is a parameter so a caller can place it; the default is the constant.
  it('takes the window and the clock from its caller', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(AT('2026-08-08T09:00:00Z'))
    const { store, projectId } = await house()
    const chat = await store.createChat({ projectId, title: 'An hour old' })

    expect(await sweepIdleChats({ store, now: AT('2026-08-08T10:00:00Z'), idleMs: 30 * 60 * 1000 })).toContain(chat.id)
    expect(AUTO_SETTLE_AFTER_MS).toBe(48 * 60 * 60 * 1000)
  })
})
