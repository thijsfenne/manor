import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from 'react'

export type OpenWebsiteUrl = (url: string, chatId?: string) => boolean

const ExternalLinkContext = createContext<{ open: (url: string) => boolean; chatId?: string; picksPageContext: boolean } | null>(null)

export function ExternalLinkProvider({
  open,
  chatId,
  picksPageContext = false,
  children,
}: {
  open: OpenWebsiteUrl
  chatId?: string
  /** Whether a page `open` sends lands in this chat's own Browser, which hands picked context to its composer. */
  picksPageContext?: boolean
  children: ReactNode
}) {
  const scopedOpen = useCallback((url: string) => open(url, chatId), [open, chatId])
  const value = useMemo(() => ({ open: scopedOpen, chatId, picksPageContext }), [scopedOpen, chatId, picksPageContext])
  return <ExternalLinkContext.Provider value={value}>{children}</ExternalLinkContext.Provider>
}

/** The chat-scoped Browser opener, or null outside a chat; its result says whether it took the URL. */
export function useOpenWebsite(): ((url: string) => boolean) | null {
  return useContext(ExternalLinkContext)?.open ?? null
}

/** The chat whose Browser panel `useOpenWebsite` opens into, or undefined outside one. */
export function useLinkChatId(): string | undefined {
  return useContext(ExternalLinkContext)?.chatId
}

/** Whether this chat's Browser can pick page context from a page it opened. */
export function usePicksPageContext(): boolean {
  return useContext(ExternalLinkContext)?.picksPageContext ?? false
}

/**
 * One website-link policy for every Markdown surface. A chat scopes the click to
 * its right rail Browser; surfaces without a chat and other clients keep native
 * anchor behaviour.
 */
export function ExternalLink({ onClick, href, ...props }: ComponentPropsWithoutRef<'a'>) {
  const open = useOpenWebsite()

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || href === undefined || !isWebsiteUrl(href)) return
    if (open?.(href) === true) event.preventDefault()
  }

  return <a {...props} href={href} onClick={handleClick} />
}

export function isWebsiteUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
