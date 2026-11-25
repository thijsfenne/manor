import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Alert02Icon,
  BubbleChatIcon,
  CheckmarkCircle02Icon,
  DashboardSpeed01Icon,
  Rocket01Icon,
  TaskDone01Icon,
  UserQuestion01Icon,
} from '@hugeicons/core-free-icons'
import { isActionNotice, VISIBLE_NOTICES, type NoticeEntry, type NoticeKind, type NoticeTarget } from '@manor/client-runtime/notices'
import { TOAST_IN, TOAST_OUT, TOAST_TRAVEL, TOAST_VISIBLE_MS } from '../motion'
import { noticeStore } from '../notices'
import { Icon } from './Icon'
import { Button } from './ui/Button'
import { NoticeCard } from './ui/NoticeCard'

/** Chat news stays a little longer than an action's confirmation: it is read, not glanced at. */
const NEWS_VISIBLE_MS = 6_000

const MARKS: Record<NoticeKind, { icon: typeof Alert02Icon; tone: string }> = {
  done: { icon: CheckmarkCircle02Icon, tone: 'text-ok' },
  ready: { icon: TaskDone01Icon, tone: 'text-ok' },
  reply: { icon: BubbleChatIcon, tone: 'text-muted' },
  waiting: { icon: UserQuestion01Icon, tone: 'text-warn' },
  proposal: { icon: Rocket01Icon, tone: 'text-warn' },
  failed: { icon: Alert02Icon, tone: 'text-danger' },
  limit: { icon: DashboardSpeed01Icon, tone: 'text-warn' },
  success: { icon: CheckmarkCircle02Icon, tone: 'text-ok' },
  error: { icon: Alert02Icon, tone: 'text-danger' },
}

/** Something the house itself reports in the stack: a provider update, a Session's commit. */
export interface HouseNotice {
  key: string
  node: ReactNode
  dismiss: () => void
}

/**
 * The window's one notice stack: chat news, action confirmations and the house's own
 * progress cards in a single column, newest on top, at most three at once. News fades
 * on its own unless the pointer rests on the stack or it waits on the user; Esc, with
 * the pointer or focus on the stack, dismisses the top one.
 */
export function NoticeStack({ house, onOpen, className, style }: {
  house: readonly HouseNotice[]
  onOpen: (target: NoticeTarget) => void
  className: string
  style?: CSSProperties
}) {
  const reduce = useReducedMotion() ?? false
  const entries = useSyncExternalStore(noticeStore.subscribe, noticeStore.get, noticeStore.get)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  // The house's cards are ongoing work and always show; news fills what is left.
  const visible = entries.slice(0, Math.max(1, VISIBLE_NOTICES - house.length))
  const engaged = hovered || focused

  const topKey = visible[0]?.key
  const houseDismiss = house[0]?.dismiss
  useEffect(() => {
    if (!engaged) return
    const dismissTop = topKey === undefined ? houseDismiss : () => noticeStore.dismiss(topKey)
    if (dismissTop === undefined) return
    // Bubbling, so a dialog or menu that owns Escape handles it first and keeps it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      dismissTop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engaged, topKey, houseDismiss])

  const items = [
    ...visible.map((entry) => ({
      key: entry.key,
      node: <EntryCard entry={entry} paused={engaged} onOpen={onOpen} />,
    })),
    ...house,
  ]

  return (
    <div
      className={`pointer-events-none fixed z-[calc(var(--z-settings)+1)] flex flex-col gap-2 ${className}`}
      style={style}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    >
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.div
            key={item.key}
            layout={reduce ? false : 'position'}
            className="no-drag pointer-events-auto"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -TOAST_TRAVEL }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, y: -TOAST_TRAVEL / 2, transition: TOAST_OUT }}
            transition={reduce ? { duration: 0.12 } : TOAST_IN}
          >
            {item.node}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

function EntryCard({ entry, paused, onOpen }: { entry: NoticeEntry; paused: boolean; onOpen: (target: NoticeTarget) => void }) {
  const { key, kind, sticky, target } = entry
  // A fresh timer each time the pointer leaves: the card gets its full time again
  // after being read, rather than vanishing the moment attention moves on.
  useEffect(() => {
    if (sticky || paused) return
    const timer = setTimeout(() => noticeStore.dismiss(key), isActionNotice(kind) ? TOAST_VISIBLE_MS : NEWS_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [key, kind, sticky, paused])
  const mark = MARKS[kind]
  return (
    <NoticeCard
      mark={<Icon icon={mark.icon} size={16} className={mark.tone} />}
      title={entry.title}
      body={entry.body}
      alert={kind === 'failed' || kind === 'error' || sticky}
      onDismiss={() => noticeStore.dismiss(key)}
      {...(target === null ? {} : {
        action: (
          <Button variant="secondary" size="small" onClick={() => {
            noticeStore.dismiss(key)
            onOpen(target)
          }}>
            Open
          </Button>
        ),
      })}
    />
  )
}
