/**
 * A delivered page's Select opens it in the chat's Browser and asks that Browser to
 * start picking page context once the page is its loaded active tab. One request per
 * chat; a newer one replaces it, and one the Browser never reaches lapses.
 */
const LIFETIME_MS = 20_000

const pending = new Map<string, { url: string; at: number }>()
const listeners = new Set<() => void>()

const normalized = (url: string) => {
  try { return new URL(url).href } catch { return url }
}

export function requestPageSelection(chatId: string, url: string) {
  pending.set(chatId, { url: normalized(url), at: Date.now() })
  for (const listener of listeners) listener()
}

/** True once, for the request that matches this tab; the Browser then starts picking. */
export function takePageSelection(chatId: string, url: string): boolean {
  const request = pending.get(chatId)
  if (request === undefined) return false
  if (Date.now() - request.at > LIFETIME_MS) {
    pending.delete(chatId)
    return false
  }
  if (request.url !== normalized(url)) return false
  pending.delete(chatId)
  return true
}

export function subscribePageSelection(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
