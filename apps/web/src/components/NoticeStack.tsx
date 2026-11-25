import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Alert02Icon,
  Brain02Icon,
  BubbleChatIcon,
  CheckmarkCircle02Icon,
  DashboardSpeed01Icon,
  GitMergeIcon,
  RefreshIcon,
  Rocket01Icon,
  TaskDone01Icon,
  UserQuestion01Icon,
} from '@hugeicons/core-free-icons'
import type { AgentConfig } from '@manor/contracts'
import { isActionNotice, VISIBLE_NOTICES, type AppNotice, type NoticeEntry, type NoticeKind, type NoticeTarget } from '@manor/client-runtime/notices'
import { TOAST_IN, TOAST_OUT, TOAST_TRAVEL, TOAST_VISIBLE_MS } from '../motion'
import { noticeStore } from '../notices'
import { Avatar } from './Avatar'
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
  memory: { icon: Brain02Icon, tone: 'text-muted' },
  merged: { icon: GitMergeIcon, tone: 'text-ok' },
  reopened: { icon: RefreshIcon, tone: 'text-muted' },
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
export function NoticeStack({ house, agents, onOpen, onUndo, className, style }: {
  house: readonly HouseNotice[]
  agents: readonly AgentConfig[]
  onOpen: (target: NoticeTarget) => void
  onUndo: (undo: NonNullable<AppNotice['undo']>) => void
  className: string
  style?: CSSProperties
}) {
  const reduce = useReducedMotion() ?? false
  const entries = useSyncExternalStore(noticeStore.subscribe, noticeStore.get, noticeStore.get)
  const [hovered, setHovered] = useState(false)
  const stackRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  // The house's cards are ongoing work and always show; news fills what is left.
  const visible = entries.slice(0, Math.max(1, VISIBLE_NOTICES - house.length))
  const engaged = hovered || focused

  // A card that leaves from under the pointer (closed, opened, timed out) takes the stack's
  // pointerleave with it, which would hold every later card for good. The next move
  // outside the stack ends the pause instead.
  useEffect(() => {
    if (!hovered) return
    const onMove = (event: PointerEvent) => {
      if (!(event.target instanceof Node && stackRef.current?.contains(event.target))) setHovered(false)
    }
    document.addEventListener('pointermove', onMove)
    return () => document.removeEventListener('pointermove', onMove)
  }, [hovered])
  // Native listeners, because the blur of a focused button whose card React removes fires
  // during React's commit, where its own onBlur never hears it.
  useEffect(() => {
    const stack = stackRef.current
    if (stack === null) return
    const onIn = () => setFocused(true)
    const onOut = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && stack.contains(event.relatedTarget))) setFocused(false)
    }
    stack.addEventListener('focusin', onIn)
    stack.addEventListener('focusout', onOut)
    return () => {
      stack.removeEventListener('focusin', onIn)
      stack.removeEventListener('focusout', onOut)
    }
  }, [])

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
      node: <EntryCard entry={entry} paused={engaged} agents={agents} onOpen={onOpen} onUndo={onUndo} />,
    })),
    ...house,
  ]

  return (
    <div
      ref={stackRef}
      className={`pointer-events-none fixed z-[calc(var(--z-settings)+1)] flex flex-col gap-2 ${className}`}
      style={style}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
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

function EntryCard({ entry, paused, agents, onOpen, onUndo }: {
  entry: NoticeEntry
  paused: boolean
  agents: readonly AgentConfig[]
  onOpen: (target: NoticeTarget) => void
  onUndo: (undo: NonNullable<AppNotice['undo']>) => void
}) {
  const { key, kind, sticky, target, undo } = entry
  // A fresh timer each time the pointer leaves: the card gets its full time again
  // after being read, rather than vanishing the moment attention moves on.
  useEffect(() => {
    if (sticky || paused) return
    const timer = setTimeout(() => noticeStore.dismiss(key), isActionNotice(kind) ? TOAST_VISIBLE_MS : NEWS_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [key, kind, sticky, paused])
  const mark = MARKS[kind]
  const face = entry.face === undefined ? undefined : agents.find((agent) => agent.id === entry.face)
  return (
    <NoticeCard
      mark={face === undefined ? <Icon icon={mark.icon} size={20} className={mark.tone} /> : (
        <span className="grid" title={face.name}>
          <Avatar name={face.name} color={face.color} src={face.avatar} shape={face.avatarShape} tone={face.avatarTone} size={32} />
        </span>
      )}
      title={entry.title}
      body={entry.body}
      dmReply={entry.face !== undefined}
      alert={kind === 'failed' || kind === 'error' || sticky}
      onDismiss={() => noticeStore.dismiss(key)}
      {...(target === null ? {} : {
        onOpen: () => {
          noticeStore.dismiss(key)
          onOpen(target)
        },
      })}
      {...(undo === undefined ? {} : {
        action: <Button size="small" onClick={() => {
          noticeStore.dismiss(key)
          onUndo(undo)
        }}>Undo</Button>,
      })}
    />
  )
}
