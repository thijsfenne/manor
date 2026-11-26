import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { Archive02Icon, LoaderCircleIcon, Search01Icon, Tag01Icon } from '@hugeicons/core-free-icons'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { MAIL_LABEL_NAME, type AgentConfig, type MailCard, type MailTriageState, type Project } from '@manor/contracts'
import { EASE_OUT, INSTANT } from '../../motion'
import { MAIL_TABS, mailSearching, mailSenderName, mailTimeLabel, type MailTab } from '../../mail'
import { useMinuteClock } from '../../useMinuteClock'
import { Icon } from '../Icon'
import { ContextMenu } from '../ui/ContextMenu'
import { SegmentedControl } from '../ui/SegmentedControl'
import { MailProjectSquare } from './MailProjectSquare'

const PANEL_ID = 'mail-thread-panel'

/** An archived card's way out: a short fade and a slide aside, its row closing behind it. */
const CARD_AWAY = { opacity: 0, x: -16, height: 0, marginBottom: 0 }
const CARD_LEAVE = { duration: 0.18, ease: EASE_OUT }

/**
 * The default agent's labelling run: how many cards wait for one, else when the last one
 * finished, and the way to start one now.
 */
export function MailTriageButton({ agent, triage, unlabelled, onRun }: {
  agent: AgentConfig
  triage: MailTriageState
  unlabelled: number
  onRun: () => void
}) {
  const now = useMinuteClock()
  const hint = `${agent.name} labels new mail when you open Mail and every morning. Click to run now.`
  const shown = unlabelled > 0 ? `${unlabelled} new` : triage.lastRunAt === null ? null : mailTimeLabel(triage.lastRunAt, now)
  return (
    <button type="button" title={hint} aria-label={hint} aria-busy={triage.running} disabled={triage.running}
      className="flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded-button-sm border-0 bg-transparent px-2 text-meta text-dim hover:bg-surface-2 hover:text-text disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-dim"
      onClick={onRun}>
      <Icon icon={triage.running ? LoaderCircleIcon : Tag01Icon} size={14} className={`flex-none ${triage.running ? 'motion-safe:animate-spin-calm' : ''}`} />
      {shown === null ? null : <span className="tabular-nums">{shown}</span>}
    </button>
  )
}

/** What a click on a card asks for: open it, Cmd or Ctrl to pick it, Shift to pick a range. */
export type MailPick = 'open' | 'toggle' | 'range'

const pickOf = (event: MouseEvent): MailPick =>
  event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'open'

const CHIP_TONE = { reply: 'text-warn', wait: 'text-busy', fyi: 'text-dim', other: 'text-dim' } as const

function MailRow({ card, open, picked, showLabel, project, now, archiveLabel, onSelect, onArchive }: {
  card: MailCard
  /** The thread on the stage. */
  open: boolean
  /** Part of a pick of two or more cards. */
  picked: boolean
  showLabel: boolean
  project: Project | undefined
  now: number
  archiveLabel: string
  onSelect: (pick: MailPick) => void
  onArchive: () => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const select = (event: MouseEvent) => onSelect(pickOf(event))
  const sender = mailSenderName(card.from)
  const time = mailTimeLabel(card.at, now)
  const label = showLabel ? card.label ?? null : null
  const name = [picked ? 'Selected' : null, card.unread ? 'Unread' : null, card.subject, sender, time, label === null ? null : MAIL_LABEL_NAME[label], project?.name ?? null]
    .filter((part) => part !== null).join(', ')
  return (
    <div className={`relative rounded-lg px-3 py-2.5 ${open || picked ? 'bg-user-bg text-text' : 'text-muted hover:bg-surface-2 hover:text-text'}`}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}>
      {/* The whole card is one button; what it says lies over it and lets the press through. */}
      <button type="button" className="absolute inset-0 cursor-pointer rounded-[inherit] border-0 bg-transparent p-0"
        aria-label={name} aria-current={open ? 'true' : undefined} data-mail-card={card.threadId} onClick={select} />
      <div className="pointer-events-none relative flex items-center gap-2">
        <span aria-hidden="true" className={`size-1.5 flex-none rounded-full ${card.unread ? 'bg-busy' : ''}`} />
        <span className={`min-w-0 flex-1 truncate text-[13px] ${card.unread ? 'font-medium text-text' : ''}`}>{card.subject}</span>
      </div>
      <div className="pointer-events-none relative mt-1 flex min-w-0 items-center gap-2 pl-3.5 text-[12px] text-dim">
        <span className="min-w-0 truncate">{sender}</span>
        <span className="flex-none tabular-nums">{time}</span>
        {label === null ? null : (
          // Takes the pointer only to show why the label was given; a press still opens the card.
          <span className={`pointer-events-auto flex-none ${CHIP_TONE[label]}`} title={card.reason} onClick={select}>{MAIL_LABEL_NAME[label]}</span>
        )}
        {project === undefined ? null : (
          <span className="pointer-events-auto flex flex-none items-center" onClick={select}>
            <MailProjectSquare name={project.name} color={project.color} named />
          </span>
        )}
      </div>
      {menu === null ? null : (
        <ContextMenu x={menu.x} y={menu.y} items={[{ label: archiveLabel, icon: Archive02Icon, onSelect: onArchive }]}
          onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

/**
 * Search, the label tabs and one card per listed thread, in the sidebar beside the Mail
 * stage. A search lists every match whatever its label, so it hides the tabs and each row
 * names its label instead.
 */
export function MailSidebar({ cards, projects, selectedId, picked, tab, query, problems, searchRef, onSelect, onArchive, onTab, onQuery }: {
  /** Already narrowed to the tab, or to the search. */
  cards: readonly MailCard[]
  projects: readonly Project[]
  /** The thread on the stage; null while several cards are picked. */
  selectedId: string | null
  /** Two or more listed cards picked at once, else empty. */
  picked: readonly string[]
  tab: MailTab
  query: string
  /** What the host reported about the mailbox or the last triage run. */
  problems: readonly string[]
  searchRef: RefObject<HTMLInputElement>
  onSelect: (threadId: string, pick: MailPick) => void
  /** The right click Archive: the whole pick when the card is in it, else this card alone. */
  onArchive: (threadId: string) => void
  onTab: (tab: MailTab) => void
  onQuery: (query: string) => void
}) {
  const now = useMinuteClock()
  const reduce = useReducedMotion() ?? false
  const searching = mailSearching(query)
  const list = useRef<HTMLUListElement>(null)
  // A selection moved by key can be out of sight; the nearest edge is as far as the list goes.
  useEffect(() => {
    const picked = list.current?.querySelector<HTMLElement>('[aria-current="true"]')
    if (picked === null || picked === undefined) return
    // Focus that was in the list goes along, so no ring stays on the card left behind.
    if (list.current?.contains(document.activeElement) === true) picked.focus({ preventScroll: true })
    picked.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  return (
    <div className="flex min-w-0 flex-col gap-2 pt-0.5">
      <label className="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5 text-muted focus-within:outline-1 focus-within:outline-field-focus">
        <Icon icon={Search01Icon} size={14} className="flex-none" />
        <input ref={searchRef} type="search" value={query} placeholder="Search" aria-label="Search mail"
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-text outline-none placeholder:text-dim [&::-webkit-search-cancel-button]:appearance-none"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.currentTarget.blur()
          }} />
      </label>
      {searching ? null : (
        <SegmentedControl dense label="Mail labels" value={tab} onChange={onTab}
          options={MAIL_TABS.map((option) => ({ ...option, tabId: `mail-tab-${option.value}`, panelId: PANEL_ID }))} />
      )}
      {problems.map((problem) => <p key={problem} role="status" className="m-0 break-words px-3 text-meta text-warn">{problem}</p>)}
      <div {...(searching ? {} : { id: PANEL_ID, role: 'tabpanel', 'aria-labelledby': `mail-tab-${tab}` })}>
        <ul ref={list} aria-label="Mail threads" className="m-0 flex list-none flex-col p-0">
          {/* Keyed on the filter: switching tab or typing swaps the list at once, and only a card
              that leaves the list it was in plays the way out. */}
          <AnimatePresence initial={false} key={searching ? `search\n${query}` : tab}>
            {cards.map((card) => (
              <motion.li key={card.threadId} className="mb-0.5 overflow-hidden"
                exit={reduce ? { opacity: 0, transition: INSTANT } : { ...CARD_AWAY, transition: CARD_LEAVE }}>
                <MailRow card={card} open={card.threadId === selectedId} picked={picked.includes(card.threadId)}
                  showLabel={searching} now={now} project={projects.find((project) => project.id === card.projectId)}
                  archiveLabel={picked.includes(card.threadId) ? `Archive ${picked.length} mails` : 'Archive'}
                  onSelect={(pick) => onSelect(card.threadId, pick)} onArchive={() => onArchive(card.threadId)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </div>
    </div>
  )
}
