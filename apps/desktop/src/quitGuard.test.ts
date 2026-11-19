import { describe, expect, it, vi } from 'vitest'
import { createQuitGuard, quitQuestion, readWorking, type QuitQuestion } from './quitGuard'

const answering = (response: Response): typeof fetch => async () => response
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('reading how much work the server has running', () => {
  it('returns the count the server reports', async () => {
    const fetchFn = vi.fn(answering(json({ ok: true, working: 3 })))
    expect(await readWorking('http://localhost:43179', fetchFn)).toBe(3)
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('http://localhost:43179/health')
  })

  it('reads 0 from a server that cannot say, so a quit is never held by it', async () => {
    expect(await readWorking('http://localhost:43179', async () => { throw new Error('refused') })).toBe(0)
    expect(await readWorking('http://localhost:43179', answering(json({ working: 2 }, 500)))).toBe(0)
    expect(await readWorking('http://localhost:43179', answering(json({ ok: true })))).toBe(0)
    expect(await readWorking('http://localhost:43179', answering(json({ working: -1 })))).toBe(0)
    expect(await readWorking('http://localhost:43179', answering(json({ working: 1.5 })))).toBe(0)
    expect(await readWorking('http://localhost:43179', answering(new Response('not json')))).toBe(0)
  })
})

describe('the quit question', () => {
  it('asks nothing when no work runs, and counts chats otherwise', () => {
    expect(quitQuestion(0)).toBeNull()
    expect(quitQuestion(1)).toEqual({
      message: 'Quit Manor while agents are working?',
      detail: 'Agents are still working in 1 chat. Quitting stops them.',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })
    expect(quitQuestion(3)?.detail).toBe('Agents are still working in 3 chats. Quitting stops them.')
  })
})

/** A guard whose read and question resolve when the test says so. */
function guard(working: () => Promise<number>) {
  const answers: ((quit: boolean) => void)[] = []
  const asked: QuitQuestion[] = []
  const quit = vi.fn()
  const quitGuard = createQuitGuard({
    read: working,
    ask: (question) => new Promise((resolve) => { asked.push(question); answers.push(resolve) }),
    quit,
  })
  return { quitGuard, asked, answers, quit }
}

describe('holding a quit while agents work', () => {
  it('quits at once without asking when nothing runs', async () => {
    const { quitGuard, asked, quit } = guard(async () => 0)
    expect(quitGuard.request()).toBe(false)
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(asked).toEqual([])
    expect(quitGuard.request()).toBe(true)
  })

  it('keeps running on Cancel and asks again on a later quit', async () => {
    const { quitGuard, asked, answers, quit } = guard(async () => 2)
    expect(quitGuard.request()).toBe(false)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    answers[0]!(false)
    await Promise.resolve()
    expect(quit).not.toHaveBeenCalled()
    expect(quitGuard.request()).toBe(false)
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    answers[1]!(true)
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(quitGuard.request()).toBe(true)
  })

  it('holds a second quit while the first is still being decided, without asking twice', async () => {
    const { quitGuard, asked, answers, quit } = guard(async () => 1)
    expect(quitGuard.request()).toBe(false)
    expect(quitGuard.request()).toBe(false)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(quitGuard.request()).toBe(false)
    answers[0]!(true)
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(asked).toHaveLength(1)
  })

  it('quits when reading or asking fails', async () => {
    const reading = guard(async () => { throw new Error('broken') })
    reading.quitGuard.request()
    await vi.waitFor(() => expect(reading.quit).toHaveBeenCalledTimes(1))
    const quit = vi.fn()
    createQuitGuard({ read: async () => 1, ask: async () => { throw new Error('no dialog') }, quit }).request()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
  })

  it('asks nothing when the server goes away while its count is being read', async () => {
    let answer: (working: number) => void = () => {}
    const { quitGuard, asked, quit } = guard(() => new Promise((resolve) => { answer = resolve }))
    quitGuard.request()
    quitGuard.release()
    answer(2)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toEqual([])
    expect(quit).not.toHaveBeenCalled()
    expect(quitGuard.request()).toBe(true)
  })

  it('lets every quit pass once the server is gone, even with the question still open', async () => {
    const { quitGuard, asked, answers, quit } = guard(async () => 1)
    quitGuard.request()
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    quitGuard.release()
    expect(quitGuard.request()).toBe(true)
    answers[0]!(false)
    await Promise.resolve()
    expect(quit).not.toHaveBeenCalled()
    expect(quitGuard.request()).toBe(true)
  })
})
