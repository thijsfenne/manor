import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { BubbleChatIcon, CheckListIcon, Note01Icon, QuoteDownIcon, SentIcon } from '@hugeicons/core-free-icons'
import {
  SEARCH_QUERY_MAX,
  searchMatchKind,
  searchMatches,
  searchWords,
  type AgentConfig,
  type Chat,
  type SearchMessageHit,
  type SearchNoteHit,
} from '@manor/contracts'
import type { RemindersState } from '@manor/client-runtime/reminders'
import { personaOf, type ChatListRow, type Inbox } from '../state'
import { rankSearchResults, type SearchChat, type SearchResult } from '@manor/client-runtime/search-ranking'
import { relativeTime } from '../relativeTime'
import type { RequestEvents } from '../useRequest'
import { Icon } from './Icon'
import { Badge } from './ui/Badge'
import { Dialog } from './ui/Dialog'

/**
 * At rest the palette shows the latest threads rather than an empty room, and
 * nine is the cap because ⌘1–⌘9 are the shortcuts a row can wear.
 */
const RECENT_LIMIT = 9

const SEARCH_FAILED = 'Messages and notes could not be searched. Type again to retry.'

/** Typing is a burst; one server search per pause, not per key. */
const SEARCH_DEBOUNCE_MS = 120

interface SearchDialogProps {
  /** The same three lists the sidebar shows, flattened here so one field finds them all. */
  chats: ChatListRow[]
  inbox: Inbox
  runs: Record<string, Chat[]>
  agents: AgentConfig[]
  reminders: RemindersState
  /** Live means the host answers message and note searches. */
  connected: boolean
  search: (query: string, requestId: string) => boolean
  requestEvents: RequestEvents
  onLoadReminders: () => void
  canStartChat: boolean
  /** A chat is open, so a note can open as a panel beside it (⌥Enter). */
  canOpenNoteBeside: boolean
  onStartChat: () => void
  onOpenChat: (chatId: string) => void
  onOpenMessage: (chatId: string, eventId: string) => void
  onOpenNote: (path: string, beside: boolean) => void
  onOpenReminder: (reminderId: string) => void
  onClose: () => void
}

/** The host's answer for one query; `failed` when it could not search, so the palette stops waiting. */
type ServerAnswer = { query: string; messages: SearchMessageHit[]; notes: SearchNoteHit[]; failed?: boolean }

/**
 * The search palette: a card over the whole workspace, opened from the top bar's
 * search button or ⌘K. At rest it lists the latest threads; a query searches chats,
 * messages, notes and reminders into one ranked list (the rule is in `search.ts`).
 * Message content and note bodies are searched on the host, chat titles and reminders
 * here from lists the client already holds. Every route out (a pick, Escape, the
 * backdrop) closes it, and the caller owns what opening each kind means.
 */
export function SearchDialog({
  chats,
  inbox,
  runs,
  agents,
  reminders,
  connected,
  search,
  requestEvents,
  onLoadReminders,
  canStartChat,
  canOpenNoteBeside,
  onStartChat,
  onOpenChat,
  onOpenMessage,
  onOpenNote,
  onOpenReminder,
  onClose,
}: SearchDialogProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [answer, setAnswer] = useState<ServerAnswer | null>(null)
  const asked = useRef<{ requestId: string; query: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  // A query also finds archived chats, which stay openable until they expire; the
  // resting list keeps to the threads the sidebar shows.
  const threads = useMemo(() => collectThreads(chats, inbox, runs), [chats, inbox, runs])
  const searchable = useMemo(
    () => [...threads, ...inbox.archived
      .filter((entry) => !threads.some((thread) => thread.chatId === entry.chat.id))
      .map((entry) => ({ chatId: entry.chat.id, title: entry.chat.title, lastMessageAt: entry.chat.lastMessageAt, projectName: entry.noProject === true ? 'No project' : entry.projectName }))],
    [threads, inbox.archived],
  )
  const needle = query.trim().slice(0, SEARCH_QUERY_MAX)

  // Reminders arrive only when something asks; the palette asks once as it opens.
  const remindersAvailable = reminders.available
  const remindersLoaded = reminders.snapshot !== null
  useEffect(() => {
    if (remindersAvailable && !remindersLoaded) onLoadReminders()
  }, [remindersAvailable, remindersLoaded, onLoadReminders])

  useEffect(() => requestEvents.subscribe((response) => {
    const pending = asked.current
    if (pending === null || !('requestId' in response) || response.requestId !== pending.requestId) return
    if (response.type === 'search_results') {
      setAnswer({ query: response.query, messages: response.messages, notes: response.notes })
    } else if (response.type === 'notice' && response.kind === 'error') {
      setAnswer({ query: pending.query, messages: [], notes: [], failed: true })
    }
  }), [requestEvents])

  useEffect(() => {
    if (needle === '' || !connected) {
      asked.current = null
      return
    }
    const timer = window.setTimeout(() => {
      const requestId = crypto.randomUUID()
      asked.current = { requestId, query: needle }
      if (search(needle, requestId)) return
      asked.current = null
      setAnswer({ query: needle, messages: [], notes: [], failed: true })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [needle, connected, search])

  const words = useMemo(() => searchWords(needle), [needle])
  const recent = useMemo(
    () => (needle === '' ? [...threads].sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, RECENT_LIMIT) : []),
    [threads, needle],
  )
  const results = useMemo(() => {
    if (needle === '') return []
    // Until the host answers this query, the last answer stands where its own title or
    // snippet still matches, so rows do not blink out and back between keystrokes. Each
    // field is checked on its own: a kept row is one the host would also return.
    const current = answer?.query === needle
    const matches = (text: string | undefined) => text !== undefined && searchMatchKind(text, words) !== null
    const messages = answer === null ? [] : current ? answer.messages
      : answer.messages.filter((hit) => matches(hit.snippet))
    const notes = answer === null ? [] : current ? answer.notes
      : answer.notes.filter((hit) => matches(hit.title) || matches(hit.snippet))
    return rankSearchResults(needle, {
      chats: searchable,
      messages,
      notes,
      reminders: reminders.snapshot?.reminders ?? [],
      lists: reminders.snapshot?.lists ?? [],
    })
  }, [needle, words, answer, searchable, reminders.snapshot])
  const waiting = needle !== '' && connected && answer?.query !== needle
  const failed = needle !== '' && answer?.query === needle && answer.failed === true

  const rows: number = needle === '' ? recent.length : results.length
  const rowCount = rows + (canStartChat ? 1 : 0)
  const activeIndex = Math.min(active, Math.max(0, rowCount - 1))
  const optionId = (index: number) => `${listId}-${index}`
  // Named the way the transcript names the same message, a Single Session's voice included.
  const authorOf = (agentId: string | undefined) => (agentId === undefined ? 'You' : personaOf(agents, agentId).name)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const pick = (result: SearchResult, beside: boolean) => {
    if (result.kind === 'chat') onOpenChat(result.chatId)
    else if (result.kind === 'message') onOpenMessage(result.chatId, result.eventId)
    else if (result.kind === 'note') onOpenNote(result.path, beside && canOpenNoteBeside)
    else onOpenReminder(result.reminderId)
  }

  const activate = (index: number, beside = false) => {
    if (index < rows) {
      if (needle === '') {
        const thread = recent[index]
        if (thread !== undefined) onOpenChat(thread.chatId)
      } else {
        const result = results[index]
        if (result !== undefined) pick(result, beside)
      }
      return
    }
    if (index === rows && canStartChat) onStartChat()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Tab walks the list like the arrows do instead of leaving the field: the
    // palette has exactly one place to type, so focus never needs to move.
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault()
      if (rowCount > 0) setActive((activeIndex + 1) % rowCount)
      return
    }
    if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault()
      if (rowCount > 0) setActive((activeIndex - 1 + rowCount) % rowCount)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      activate(activeIndex, event.altKey)
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key >= '1' && event.key <= '9') {
      // The palette owns the whole number row while open, including an empty slot;
      // otherwise ⌘1/⌘2 would navigate the workspace behind this dialog.
      event.preventDefault()
      const thread = needle === '' ? recent[Number(event.key) - 1] : undefined
      if (thread !== undefined) onOpenChat(thread.chatId)
      return
    }
    if (event.metaKey && event.key.toLowerCase() === 'n' && canStartChat) {
      event.preventDefault()
      onStartChat()
    }
  }

  const optionProps = (index: number) => ({
    id: optionId(index),
    type: 'button' as const,
    'data-row': index,
    role: 'option',
    'aria-selected': index === activeIndex,
    tabIndex: -1,
    onMouseMove: () => setActive(index),
  })
  const rowTone = (index: number) => (index === activeIndex ? 'bg-surface-2' : 'bg-transparent')

  return (
    <Dialog
      label="Search"
      still
      onClose={onClose}
      onKeyDown={handleKeyDown}
      scrimClassName="flex justify-center pt-[14vh]"
      className="flex h-fit max-h-full max-w-[600px] flex-col overflow-hidden"
    >
      <input
        ref={inputRef}
        className="w-full border-0 bg-transparent px-4 py-3.5 text-[15px] text-text outline-none placeholder:text-dim [font:inherit]"
        placeholder="Search chats, messages, notes and reminders"
        role="combobox"
        aria-label="Search chats, messages, notes and reminders"
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={rowCount > 0 ? optionId(activeIndex) : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
      />

      <div ref={listRef} className="min-h-0 overflow-y-auto border-t border-line px-2 pt-1 pb-2">
        <div id={listId} role="listbox" aria-label="Search results" aria-busy={waiting}>
          {needle === '' ? (
            recent.length === 0 ? null : (
              <>
                <p className="m-0 px-2.5 pt-2 pb-1 text-[12px] font-medium text-dim">Chats</p>
                {recent.map((thread, index) => (
                  <button
                    key={thread.chatId}
                    {...optionProps(index)}
                    className={`flex h-10 w-full cursor-pointer items-center gap-3 rounded-lg border-0 px-2.5 text-left text-[14px] text-muted [font:inherit] ${rowTone(index)}`}
                    onClick={() => onOpenChat(thread.chatId)}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-text">{thread.title}</span>
                    {thread.projectName !== '' ? (
                      <span className="max-w-[30%] flex-none truncate text-meta text-dim">{thread.projectName}</span>
                    ) : null}
                    <Kbd>⌘{index + 1}</Kbd>
                  </button>
                ))}
              </>
            )
          ) : results.length > 0 ? (
            <div className="pt-1">
              {results.map((result, index) => (
                <button
                  key={result.key}
                  {...optionProps(index)}
                  className={`grid w-full cursor-pointer grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 rounded-lg border-0 px-2.5 py-2 text-left text-[14px] [font:inherit] ${rowTone(index)}`}
                  onClick={(event: MouseEvent) => pick(result, event.altKey)}
                >
                  <ResultRow
                    result={result}
                    words={words}
                    author={result.kind === 'message' ? authorOf(result.agentId) : ''}
                  />
                </button>
              ))}
            </div>
          ) : (
            <p className="m-0 px-2.5 py-3 text-[13px] text-dim" role="status">
              {waiting ? 'Searching…' : failed ? SEARCH_FAILED : 'Nothing matches'}
            </p>
          )}

          {needle !== '' && !connected ? (
            <p className="m-0 px-2.5 pt-2 pb-1 text-meta text-dim" role="status">
              Messages and notes are searched once Manor reconnects.
            </p>
          ) : failed && results.length > 0 ? (
            <p className="m-0 px-2.5 pt-2 pb-1 text-meta text-dim" role="status">{SEARCH_FAILED}</p>
          ) : null}

          {canStartChat ? (
            <>
              <p className="m-0 px-2.5 pt-3 pb-1 text-[12px] font-medium text-dim">Quick actions</p>
              <button
                {...optionProps(rows)}
                className={`flex h-10 w-full cursor-pointer items-center gap-3 rounded-lg border-0 px-2.5 text-left text-[14px] text-text [font:inherit] ${rowTone(rows)}`}
                onClick={onStartChat}
              >
                <Icon icon={SentIcon} size={17} className="opacity-70" />
                <span className="min-w-0 flex-1 truncate font-medium">New Session</span>
                <Kbd>⌘N</Kbd>
              </button>
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}

const KIND_PILL = {
  chat: { label: 'Chat', icon: BubbleChatIcon },
  message: { label: 'Message', icon: QuoteDownIcon },
  note: { label: 'Note', icon: Note01Icon },
  reminder: { label: 'Reminder', icon: CheckListIcon },
} as const

/**
 * One result: its type pill in a fixed first column so every title starts on the
 * same line, the title with its context, and a snippet underneath when the body matched.
 * The project stays plain text at the right edge: a second pill would crowd the row.
 */
function ResultRow({ result, words, author }: {
  result: SearchResult
  words: readonly string[]
  author: string
}) {
  const pill = KIND_PILL[result.kind]
  const title = result.kind === 'message' ? result.chatTitle : result.title
  const meta = result.kind === 'message' ? `${author}, ${relativeTime(result.at)}`
    : result.kind === 'chat' ? relativeTime(result.at)
    : result.kind === 'note' ? result.folder
    : result.listTitle
  const trailing = result.kind === 'chat' || result.kind === 'message' ? result.projectName : ''
  const snippet = result.kind === 'chat' ? undefined : result.snippet
  return (
    <>
      <span className="flex min-w-0">
        <Badge icon={pill.icon} size="inline">{pill.label}</Badge>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 shrink truncate font-medium text-text">
          {result.kind === 'message' ? title : <Highlighted text={title} words={words} />}
        </span>
        {meta === '' ? null : <span className="min-w-0 flex-none truncate text-meta text-dim">{meta}</span>}
        <span className="min-w-0 flex-1" />
        {trailing === '' ? null : <span className="max-w-[30%] flex-none truncate text-meta text-dim">{trailing}</span>}
      </span>
      {snippet === undefined ? null : (
        <span className="col-start-2 min-w-0 truncate text-[13px] text-muted">
          <Highlighted text={snippet} words={words} />
        </span>
      )}
    </>
  )
}

/** `text` with every query word that starts a word in it marked. */
function Highlighted({ text, words }: { text: string; words: readonly string[] }) {
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of searchMatches(text, words)) {
    if (start < at) continue
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark key={start} className="rounded-[3px] bg-find text-text">{text.slice(start, end)}</mark>)
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

/** The shortcut a row answers to, worn on its right edge the way the example does. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="flex-none rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-meta tabular-nums text-dim [font:inherit]">
      {children}
    </kbd>
  )
}

/** Every thread the house already lists, once each, with the project it sits in. */
function collectThreads(chats: ChatListRow[], inbox: Inbox, runs: Record<string, Chat[]>): SearchChat[] {
  const seen = new Set<string>()
  const threads: SearchChat[] = []
  const add = (chatId: string, title: string, lastMessageAt: number, projectName = '') => {
    if (seen.has(chatId)) return
    seen.add(chatId)
    threads.push({ chatId, title, lastMessageAt, projectName })
  }
  for (const entry of [...inbox.unsettled, ...inbox.settled]) {
    add(entry.chat.id, entry.chat.title, entry.chat.lastMessageAt, entry.noProject === true ? 'No project' : entry.projectName)
  }
  for (const list of Object.values(runs)) {
    for (const chat of list) add(chat.id, chat.title, chat.lastMessageAt)
  }
  for (const row of chats) {
    if (row.chat === null) continue
    add(row.chat.id, row.title, row.lastMessageAt ?? 0)
  }
  return threads
}
