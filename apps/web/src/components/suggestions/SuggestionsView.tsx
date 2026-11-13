import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import {
  CancelCircleIcon,
  Clock01Icon,
  Flag02Icon,
  Idea01Icon,
  Tick02Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import type { WorkflowSuggestion } from '@manor/contracts'
import { ACTIVE, OCCURRENCE_BAR, WATCHING, byWeight, occurrenceCount, statusStamp } from '@manor/client-runtime/suggestions'
import { EASE_TRAVEL, INSTANT, SEGMENTED_SLIDE } from '../../motion'
import { Icon } from '../Icon'
import { Markdown } from '../Markdown'
import { Button } from '../ui/Button'
export { suggestionPrompt } from '../../suggestionPrompt'
export { OCCURRENCE_BAR, occurrenceCount } from '@manor/client-runtime/suggestions'

interface SuggestionsViewProps {
  ledger: { available: boolean; suggestions: WorkflowSuggestion[] } | null
  canDiscuss: boolean
  onRefresh: () => boolean
  onDiscuss: (suggestion: WorkflowSuggestion) => void
}

const GROUPS: ReadonlyArray<{
  key: string
  label: string
  icon: Parameters<typeof Icon>[0]['icon']
  holds: (status: WorkflowSuggestion['status']) => boolean
}> = [
  { key: 'decide', label: 'Needs a decision', icon: Flag02Icon, holds: (status) => ACTIVE.has(status) },
  { key: 'watching', label: 'Watching', icon: ViewIcon, holds: (status) => WATCHING.has(status) },
  {
    key: 'history',
    label: 'History',
    icon: Clock01Icon,
    holds: (status) => !ACTIVE.has(status) && !WATCHING.has(status),
  },
]

const statusLabel = (status: WorkflowSuggestion['status']): string =>
  status === 'existing-skill'
    ? 'Existing skill'
    : status.charAt(0).toUpperCase() + status.slice(1)

const statusDate = (statusDetail: string): string | undefined =>
  statusStamp(statusDetail)?.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** Row copy has one line to work with, so markdown marks would spend it on syntax. */
const squash = (text: string): string => text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Progress toward the three-times bar, as the ledger counts it. Filled dots are
 * sightings; the violet is the bar being cleared, so the one chromatic mark in the
 * list always means the same thing. Past three the exact count is spelled out,
 * because "5" and "3" are a different conversation.
 */
function Tally({ count, className = '' }: { count: number | undefined; className?: string }) {
  if (count === undefined) {
    return (
      <span className={`text-meta text-dim ${className}`} title="The ledger does not state a count">
        Not counted
      </span>
    )
  }
  const cleared = count >= OCCURRENCE_BAR
  const filled = Math.min(count, OCCURRENCE_BAR)
  return (
    <span
      className={`flex items-center gap-1.5 ${className}`}
      title={`${count} of ${OCCURRENCE_BAR} occurrences`}
    >
      <span className="flex items-center gap-1" aria-hidden>
        {Array.from({ length: OCCURRENCE_BAR }, (_, index) => (
          <span
            key={index}
            className={`size-1.5 rounded-full ${
              index < filled
                ? cleared
                  ? 'bg-[var(--color-skill)]'
                  : 'bg-muted'
                : // Translucent, not a fill: the selected row wears Inhabited Fill, and an
                  // empty dot painted in that same token vanished on exactly the row you
                  // were reading. A wash of the text colour steps off whatever is behind it.
                  'bg-text/15'
            }`}
          />
        ))}
      </span>
      {count > OCCURRENCE_BAR ? <span className="text-meta tabular-nums text-dim">{count}</span> : null}
      <span className="sr-only">{count} of {OCCURRENCE_BAR} occurrences</span>
    </span>
  )
}

/** History has no progress left to show, so the slot carries the outcome instead. */
function Outcome({ suggestion }: { suggestion: WorkflowSuggestion }) {
  const date = statusDate(suggestion.statusDetail)
  const shipped = suggestion.status === 'shipped'
  const dismissed = suggestion.status === 'dismissed'
  return (
    <span className="flex items-center gap-1.5 text-meta text-dim">
      {shipped ? (
        <Icon icon={Tick02Icon} size={13} className="text-ok" />
      ) : dismissed ? (
        <Icon icon={CancelCircleIcon} size={13} />
      ) : null}
      <span>{date ?? statusLabel(suggestion.status)}</span>
    </span>
  )
}

const rowSlot = (suggestion: WorkflowSuggestion) =>
  ACTIVE.has(suggestion.status) || WATCHING.has(suggestion.status) ? (
    <Tally count={occurrenceCount(suggestion.occurrences)} />
  ) : (
    <Outcome suggestion={suggestion} />
  )

/** What the status means here, said in the ledger's own terms rather than as a word. */
function statusSentence(suggestion: WorkflowSuggestion): string {
  const count = occurrenceCount(suggestion.occurrences)
  const date = statusDate(suggestion.statusDetail)
  if (suggestion.status === 'watching') {
    return count === undefined
      ? 'Watching, below the three-times bar'
      : `Watching, seen ${count} of ${OCCURRENCE_BAR} times`
  }
  if (suggestion.status === 'ready') {
    return count === undefined
      ? 'Ready for a go or no-go'
      : `Ready for a go or no-go, seen ${count} times`
  }
  if (suggestion.status === 'existing-skill') return 'Already covered by an installed skill'
  return date === undefined ? statusLabel(suggestion.status) : `${statusLabel(suggestion.status)} ${date}`
}

function DetailSection({ label, text }: { label: string; text: string }) {
  return (
    <section className="mt-4 border-t border-line pt-4">
      <h3 className="m-0 text-label font-medium text-dim">{label}</h3>
      {/* 14px: the panel's reading size, a step up from the 13px labels around it
          without reaching the 16px the description above already owns. */}
      <div className="mt-1.5 text-[14px] leading-relaxed text-text [&_p]:m-0">
        <Markdown text={text} variant="document" />
      </div>
    </section>
  )
}

function CandidateDetail({
  suggestion,
  canDiscuss,
  onDiscuss,
}: {
  suggestion: WorkflowSuggestion
  canDiscuss: boolean
  onDiscuss: (suggestion: WorkflowSuggestion) => void
}) {
  const decidable = ACTIVE.has(suggestion.status) || WATCHING.has(suggestion.status)
  return (
    <>
      <header className="flex items-start justify-between gap-6 max-[640px]:flex-col">
        <div className="min-w-0">
          <h2 className="m-0 text-[20px] leading-tight font-semibold tracking-[-0.01em]">{suggestion.name}</h2>
          <div className="mt-1.5 flex items-center gap-2.5">
            {decidable ? <Tally count={occurrenceCount(suggestion.occurrences)} /> : null}
            <span className="text-label text-muted">{statusSentence(suggestion)}</span>
          </div>
        </div>
        {decidable ? (
          <Button
            variant="primary"
            size="compact"
            className="flex-none"
            disabled={!canDiscuss}
            title={canDiscuss ? 'Opens a new chat with this candidate' : 'Make a project first; a chat starts in one'}
            onClick={() => onDiscuss(suggestion)}
          >
            Discuss in chat
          </Button>
        ) : null}
      </header>
      <div className="mt-5 text-[16px] leading-relaxed text-text [&_p]:m-0">
        <Markdown text={suggestion.description} variant="document" />
      </div>
      <DetailSection label="Evidence" text={suggestion.occurrences} />
      <DetailSection label="Corrections seen" text={suggestion.corrections} />
      <DetailSection label="Existing coverage" text={suggestion.existingCoverage} />
      <p className="mt-4 mb-0 font-mono text-meta text-dim">{suggestion.id}</p>
    </>
  )
}

function EmptyStage({ title, body, icon = false }: { title: string; body: string; icon?: boolean }) {
  return (
    <div className="mx-auto grid w-full min-h-0 max-w-page flex-1 place-items-center px-8 py-12">
      <div className="max-w-[380px] text-center">
        {icon ? (
          <span className="mx-auto mb-3 grid size-9 place-items-center rounded-lg bg-surface text-[var(--color-skill)]">
            <Icon icon={Idea01Icon} size={18} />
          </span>
        ) : null}
        <h2 className="m-0 text-[16px] font-semibold">{title}</h2>
        <p className="mt-1.5 mb-0 text-label text-muted">{body}</p>
      </div>
    </div>
  )
}

/** The proposal ledger in the memory folder, kept read-only so Manor never mutates existing memory files. */
export function SuggestionsView({ ledger, canDiscuss, onRefresh, onDiscuss }: SuggestionsViewProps) {
  const reduceMotion = useReducedMotion() ?? false
  const listId = useId()
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const [picked, setPicked] = useState<string | null>(null)
  const suggestions = ledger?.suggestions ?? []

  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        candidates: suggestions.filter((suggestion) => group.holds(suggestion.status)).sort(byWeight),
      })).filter((group) => group.candidates.length > 0),
    [suggestions],
  )
  const order = useMemo(() => groups.flatMap((group) => group.candidates.map((candidate) => candidate.id)), [groups])

  // Resolved while rendering rather than in an effect: a ledger that reloads keeps the
  // reader where they were, one that no longer holds the open candidate falls back to
  // the first thing waiting on a decision, and the detail pane is never briefly empty.
  const selectedId = picked !== null && order.includes(picked) ? picked : order[0] ?? null
  const selected = suggestions.find((suggestion) => suggestion.id === selectedId)

  // The record arrives from the side the selection came from: pick something further
  // down the column and it rises into place, pick something above and it drops in.
  // The ref is only written after the commit, so the render that mounts the new
  // record still sees where the reader was standing.
  const previousIndex = useRef(0)
  const index = selectedId === null ? 0 : order.indexOf(selectedId)
  const travellingDown = index >= previousIndex.current
  useEffect(() => {
    previousIndex.current = index
  }, [index])

  const step = (delta: number) => {
    if (selectedId === null) return
    const next = order[Math.min(order.length - 1, Math.max(0, order.indexOf(selectedId) + delta))]
    if (next === undefined || next === selectedId) return
    setPicked(next)
    rows.current.get(next)?.focus()
  }

  const jump = (id: string | undefined) => {
    if (id === undefined) return
    setPicked(id)
    rows.current.get(id)?.focus()
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') step(1)
    else if (event.key === 'ArrowUp') step(-1)
    else if (event.key === 'Home') jump(order[0])
    else if (event.key === 'End') jump(order[order.length - 1])
    else return
    event.preventDefault()
  }

  return (
    <main className="flex h-full min-h-0 flex-col">
      {/* The same column Skills and Connectors put their heading in, down to the
          padding: three tabs of one room, and a title that moved on the way between
          them would say they were three rooms. */}
      <div className="mx-auto flex w-full max-w-page flex-none items-end justify-between gap-6 px-8 pt-10 max-[720px]:px-5 max-[720px]:pt-7 max-[640px]:flex-col max-[640px]:items-stretch max-[640px]:gap-4">
        <div>
          <h1 className="m-0 font-display text-[24px] leading-tight font-semibold tracking-[-0.02em]">Suggestions</h1>
          <p className="mt-1 mb-0 max-w-[590px] text-[16px] leading-relaxed text-muted">
            Repeated workflows that could become skills.
          </p>
        </div>
        <Button variant="secondary" size="compact" className="flex-none max-[640px]:self-start" onClick={onRefresh}>
          Refresh
        </Button>
      </div>

      {ledger === null ? (
        <EmptyStage title="Loading suggestions…" body="Reading the candidate ledger on this Mac." />
      ) : !ledger.available ? (
        <EmptyStage
          title="No memory folder on this host"
          body="Suggestions are read from the memory folder on the Mac."
        />
      ) : suggestions.length === 0 ? (
        <EmptyStage
          icon
          title="No suggestions yet"
          body="No recurring workflow is on record. A candidate appears once a session tags one."
        />
      ) : (
        <div className="mx-auto grid w-full min-h-0 max-w-page flex-1 grid-cols-[minmax(0,236px)_minmax(0,1fr)] gap-5 px-8 pt-6 pb-8 max-[720px]:px-5 max-[720px]:pb-6 max-[640px]:grid-cols-1 max-[640px]:grid-rows-[minmax(0,34vh)_minmax(0,1fr)] max-[640px]:gap-4">
          <div
            role="listbox"
            aria-label="Skill candidates"
            tabIndex={-1}
            /* Pulled left by exactly the row's own padding, so a row label lands on
               the same vertical as the heading above it while the hover fill still
               has somewhere to go. No divider: the pane beside it carries a surface
               of its own, and tone separates the two without drawing a line. */
            className="-ml-2.5 min-h-0 overflow-y-auto outline-none max-[640px]:ml-0"
            onKeyDown={onListKeyDown}
          >
            {groups.map((group) => (
              <div key={group.key} role="group" aria-label={group.label} className="mb-4 last:mb-0">
                <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-bg/95 px-2.5 pt-1 pb-1.5 text-meta text-dim backdrop-blur-[2px]">
                  <span className="flex items-center gap-1.5">
                    <Icon icon={group.icon} size={13} className="flex-none" />
                    {group.label}
                  </span>
                  <span className="tabular-nums">{group.candidates.length}</span>
                </div>
                {group.candidates.map((candidate) => {
                  const isSelected = candidate.id === selectedId
                  return (
                    <button
                      key={candidate.id}
                      ref={(node) => {
                        if (node === null) rows.current.delete(candidate.id)
                        else rows.current.set(candidate.id, node)
                      }}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      id={`${listId}-${candidate.id}`}
                      tabIndex={isSelected ? 0 : -1}
                      className={`relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-left outline-none duration-150 ease-fade focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary motion-safe:transition-colors ${
                        isSelected ? '' : 'hover:bg-surface-2'
                      }`}
                      onClick={() => setPicked(candidate.id)}
                    >
                      {isSelected ? (
                        <motion.span
                          layoutId="suggestion-row"
                          className="absolute inset-0 rounded-lg bg-user-bg"
                          transition={reduceMotion ? INSTANT : SEGMENTED_SLIDE}
                        />
                      ) : null}
                      {/* One line, not two: at this column width a truncated summary
                          loses its verb before it says anything, and the whole
                          description is one row away in the pane beside it. */}
                      <span
                        className="relative min-w-0 flex-1 truncate text-label font-medium text-text"
                        title={squash(candidate.description)}
                      >
                        {candidate.name}
                      </span>
                      <span className="relative flex-none">{rowSlot(candidate)}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>

          {/* `h-fit` opts the panel out of the grid's stretch, so the surface ends
              where the record ends; `max-h-full` puts the scroll back inside it once
              a long candidate outgrows the room. */}
          <div className="h-fit max-h-full min-h-0 overflow-y-auto rounded-xl bg-surface px-6 py-5 max-[720px]:px-5">
            {/* Keyed on the candidate, so the record arrives rather than the old one
                leaving first: browsing the list with the arrow keys would otherwise
                spend a wait-mode exit on every row. */}
            {selected === undefined ? null : (
              <motion.article
                key={selected.id}
                className="max-w-[620px]"
                initial={reduceMotion ? false : { opacity: 0, y: travellingDown ? 8 : -8, filter: 'blur(3px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={
                  reduceMotion ? INSTANT : { duration: 0.18, ease: EASE_TRAVEL, opacity: { duration: 0.12 } }
                }
              >
                <CandidateDetail suggestion={selected} canDiscuss={canDiscuss} onDiscuss={onDiscuss} />
              </motion.article>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
