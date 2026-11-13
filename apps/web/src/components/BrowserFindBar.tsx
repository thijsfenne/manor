import { useEffect, useRef, useState } from 'react'
import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon, Search01Icon } from '@hugeicons/core-free-icons'
import type { BrowserFindResult, DesktopBrowserBridge } from '@manor/contracts'
import { Icon } from './Icon'
import { IconButton } from './ui/IconButton'

type FindBridge = Required<Pick<DesktopBrowserBridge, 'findInPage' | 'stopFind'>>

/**
 * Find on page, under the address row like Chrome's bar. Typing searches as you go,
 * Enter and Shift+Enter step, Escape closes. `summon` changes on every ⌘F, which puts
 * focus back in the field with its text selected.
 */
export function BrowserFindBar({ bridge, chatId, page, loading, summon, onClose }: {
  bridge: FindBridge
  chatId: string
  /**
   * The document find searches (a sign-in popup while open, else the page) and its load
   * state. A new document or any finished load, a reload too, searches again.
   */
  page: string
  loading: boolean
  summon: number
  onClose(): void
}) {
  const field = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<BrowserFindResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [summon])

  const find = (text: string, forward: boolean, next: boolean) => {
    const id = ++request.current
    setError(null)
    if (text === '') {
      setResult(null)
      void bridge.stopFind(chatId).catch(() => undefined)
      return
    }
    void bridge.findInPage(chatId, text, { forward, next }).then(
      (found) => { if (request.current === id) setResult(found) },
      (reason: unknown) => { if (request.current === id) setError(reason instanceof Error ? reason.message : String(reason)) },
    )
  }

  // A loading page has no count yet; the finished one, reloaded or new, is searched again.
  useEffect(() => {
    if (query === '') return
    if (loading) { request.current += 1; setResult(null) }
    else find(query, true, false)
  }, [page, loading, chatId])
  // The highlight goes when the bar does.
  useEffect(() => () => { void bridge.stopFind(chatId).catch(() => undefined) }, [chatId])

  const step = (forward: boolean) => { if (query !== '') find(query, forward, result !== null) }
  const status = error ?? (result === null ? '' : result.matches === 0 ? 'No results' : `${result.active} of ${result.matches}`)

  return (
    <div role="search" aria-label="Find on page" className="flex min-w-0 items-center gap-2 border-t border-line py-1.5 pr-2 pl-4">
      <Icon icon={Search01Icon} size={14} className="flex-none text-muted" />
      <input ref={field} aria-label="Find on page" placeholder="Find on page" value={query}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-label text-text outline-none placeholder:text-dim"
        onChange={(event) => { setQuery(event.target.value); find(event.target.value, true, false) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose() }
          else if (event.key === 'Enter') { event.preventDefault(); step(!event.shiftKey) }
        }} />
      <span aria-live="polite" className={`flex-none text-meta tabular-nums ${error === null ? 'text-muted' : 'text-danger'}`}>{status}</span>
      <IconButton icon={ArrowUp01Icon} iconSize={14} size={24} label="Previous match"
        disabled={!result?.matches} onClick={() => step(false)} />
      <IconButton icon={ArrowDown01Icon} iconSize={14} size={24} label="Next match"
        disabled={!result?.matches} onClick={() => step(true)} />
      <IconButton icon={Cancel01Icon} iconSize={14} size={24} label="Close find" onClick={onClose} />
    </div>
  )
}
