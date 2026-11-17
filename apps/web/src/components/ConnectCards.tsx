import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Loading03Icon,
  Plug01Icon,
  RefreshIcon,
  SquareArrowUpRightIcon,
} from '@hugeicons/core-free-icons'
import type { ConnectRecord } from '../state'
import { Icon } from './Icon'

interface ConnectActions {
  open: (connectId: string) => void
  connected: boolean
}

const ConnectContext = createContext<ConnectActions | null>(null)

/** Scopes Open in browser to one chat. Without it the cards still show their status. */
export function ConnectCardProvider({ chatId, open, connected, children }: {
  chatId: string
  open: (chatId: string, connectId: string) => void
  connected: boolean
  children: ReactNode
}) {
  const value = useMemo(() => ({ open: (connectId: string) => open(chatId, connectId), connected }), [chatId, open, connected])
  return <ConnectContext.Provider value={value}>{children}</ConnectContext.Provider>
}

/** "gmail" reads Gmail, "google-drive" reads Google drive. */
export const appLabel = (app: string): string => {
  const words = app.replace(/[_-]+/g, ' ').trim()
  return words.length === 0 ? app : `${words[0]!.toUpperCase()}${words.slice(1)}`
}

/**
 * Accounts an agent needed connected, under the answer of the turn that asked. Nothing
 * opens until the user clicks; the server opens the sign-in on the Mac and the card follows it.
 */
export function ConnectCards({ cards, bubble = false }: { cards: readonly ConnectRecord[]; bubble?: boolean }) {
  if (cards.length === 0) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {cards.map((card) => <ConnectCardRow key={card.connectId} card={card} bubble={bubble} />)}
    </div>
  )
}

function ConnectCardRow({ card, bubble }: { card: ConnectRecord; bubble: boolean }) {
  const actions = useContext(ConnectContext)
  // Held from the click until the server's status line lands, so a double click opens once.
  const [clicked, setClicked] = useState(false)
  useEffect(() => setClicked(false), [card.status, card.reason])

  const button = 'inline-flex flex-none cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-muted [font:inherit] hover:bg-picked hover:text-text disabled:cursor-default disabled:opacity-50'
  const canOpen = actions !== null && actions.connected && !clicked
  const open = () => {
    if (!canOpen) return
    setClicked(true)
    actions.open(card.connectId)
  }
  const nextMessage = card.status === 'connected' && (card.nextMessage === true || card.kind === 'mcp_oauth')
  const detail = card.status === 'failed'
    ? card.reason ?? 'The sign-in did not finish.'
    : nextMessage ? 'Its tools arrive on your next message.' : undefined

  return (
    <div className={`min-w-0 ${bubble ? 'max-w-bubble' : ''}`} data-connect-card={card.status}>
      <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-composer-tray">
        <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-card">
          <Icon icon={Plug01Icon} size={16} className="flex-none text-muted" />
          <span className="min-w-0 flex-1 truncate text-text">
            Connect {appLabel(card.app)}
            {card.alias === undefined ? null : <span className="ml-1.5 text-dim">{card.alias}</span>}
          </span>
          {card.status === 'ready' ? (
            <button type="button" className={button} disabled={!canOpen} onClick={open}>
              <Icon icon={SquareArrowUpRightIcon} size={13} />Open in browser
            </button>
          ) : card.status === 'waiting' ? (
            <>
            <ConnectStatusMark status="waiting" />
            {/* A login starts fresh each time; a Composio link is spent once opened. */}
            {card.kind === 'mcp_oauth' ? (
              <button type="button" className={button} disabled={actions === null || !actions.connected} onClick={() => actions?.open(card.connectId)}>Reopen</button>
            ) : null}
            </>
          ) : card.status === 'connected' ? (
            <ConnectStatusMark status="connected" />
          ) : (
            <>
              <ConnectStatusMark status="failed" />
              {card.final === true ? null : (
                <button type="button" className={button} disabled={!canOpen} onClick={open}>
                  <Icon icon={RefreshIcon} size={13} />Retry
                </button>
              )}
            </>
          )}
        </div>
        {detail === undefined ? null : (
          <p className="m-0 border-t border-line px-2.5 py-1.5 text-meta text-muted">{detail}</p>
        )}
      </div>
    </div>
  )
}

/** Where a sign-in stands, worded the same on a chat card and on the Connectors page. */
export function ConnectStatusMark({ status }: { status: 'waiting' | 'connected' | 'failed' }) {
  const reduceMotion = useReducedMotion()
  if (status === 'connected') {
    return (
      <span className="inline-flex flex-none items-center gap-1 px-1.5 py-0.5 text-ok" role="status">
        <Icon icon={CheckmarkCircle02Icon} size={13} />Connected
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex flex-none items-center gap-1 px-1.5 py-0.5 text-danger" role="status">
        <Icon icon={Alert02Icon} size={13} />Failed
      </span>
    )
  }
  return (
    <span className="inline-flex flex-none items-center gap-1 px-1.5 py-0.5 text-muted" role="status">
      <motion.span
        className="inline-flex"
        {...(reduceMotion === true ? {} : { animate: { rotate: 360 }, transition: { repeat: Infinity, duration: 1.2, ease: 'linear' } })}
      >
        <Icon icon={Loading03Icon} size={13} />
      </motion.span>
      Finish in your browser
    </span>
  )
}
