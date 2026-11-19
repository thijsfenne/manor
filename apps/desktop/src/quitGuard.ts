/**
 * The question before a quit that would stop agents at work. Quitting the app stops
 * the bundled server it started, and that server halts every running turn, so `main.ts`
 * holds the quit, asks that server how many chats are working, and asks the user only
 * when that number is above zero. A window on a server somebody else runs never gets
 * a guard: quitting it stops nothing.
 */

/** How many chats the server at this address has working, 0 whenever it cannot say. A silent server never holds a quit. */
export async function readWorking(origin: string, fetchFn: typeof fetch = fetch): Promise<number> {
  try {
    const response = await fetchFn(new URL('/health', origin), { signal: AbortSignal.timeout(1_000) })
    if (!response.ok) return 0
    const body: unknown = await response.json()
    const working = typeof body === 'object' && body !== null && 'working' in body ? body.working : undefined
    return typeof working === 'number' && Number.isInteger(working) && working >= 0 ? working : 0
  } catch {
    return 0
  }
}

/** The texts for `dialog.showMessageBox`, or null when nothing would be stopped. Button 0 quits. */
export function quitQuestion(working: number) {
  if (working <= 0) return null
  return {
    message: 'Quit Manor while agents are working?',
    detail: `Agents are still working in ${working === 1 ? '1 chat' : `${working} chats`}. Quitting stops them.`,
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  }
}

export type QuitQuestion = NonNullable<ReturnType<typeof quitQuestion>>

/**
 * The decision behind `before-quit`, with Electron passed in. `request` answers whether
 * this quit may go on now; when it says no, the caller prevents it, and the guard calls
 * `quit` again itself once the user agreed or nothing was running. A second request
 * while the first is still being decided is held without asking twice. Any failure
 * quits, so the app can always be closed.
 */
export function createQuitGuard(options: {
  read: () => Promise<number>
  /** Shows the question; true when the user chose to quit. */
  ask: (question: QuitQuestion) => Promise<boolean>
  quit: () => void
}) {
  let state: 'idle' | 'deciding' | 'confirmed' = 'idle'

  const decide = async () => {
    let quits = true
    try {
      const question = quitQuestion(await options.read())
      // Released while reading: the server is gone and that path quits on its own.
      if (state !== 'deciding') return
      quits = question === null || await options.ask(question)
    } catch {
      quits = true
    }
    if (state !== 'deciding') return
    if (!quits) {
      state = 'idle'
      return
    }
    state = 'confirmed'
    options.quit()
  }

  return {
    request(): boolean {
      if (state === 'confirmed') return true
      if (state === 'idle') {
        state = 'deciding'
        void decide()
      }
      return false
    },
    /** The server is gone, so nothing is left to protect: every later quit passes. */
    release() {
      state = 'confirmed'
    },
  }
}
