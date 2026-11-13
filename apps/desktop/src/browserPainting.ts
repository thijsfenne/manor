import type { WebContents } from 'electron'

const pages = new WeakMap<WebContents, { users: number; ready: Promise<void>; setPainting: (active: boolean) => Promise<void> }>()

/** The DOM host wakes a parked guest behind the app without changing its viewport. */
export function registerBrowserPainting(contents: WebContents, setPainting: (active: boolean) => Promise<void>): void {
  pages.set(contents, { users: 0, ready: Promise.resolve(), setPainting })
}

/** Overlapping inputs and previews share one wake period. */
export async function keepBrowserPainting(contents: WebContents): Promise<() => void> {
  const page = pages.get(contents)
  if (!page) return () => {}
  if (page.users++ === 0) page.ready = page.ready.catch(() => {}).then(() => page.setPainting(true))
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (--page.users === 0) page.ready = page.ready.catch(() => {}).then(() => page.setPainting(false)).catch(() => {})
  }
  try { await page.ready; return release }
  catch (error) { release(); throw error }
}

export async function withBrowserPainting<T>(contents: WebContents, work: () => Promise<T>): Promise<T> {
  const release = await keepBrowserPainting(contents)
  try { return await work() }
  finally { release() }
}
