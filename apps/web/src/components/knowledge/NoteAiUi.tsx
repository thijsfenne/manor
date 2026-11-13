import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../ui/Button'
import { boundsOf } from './NoteFormatting'
import { insertedSpans, noteAiApply, noteAiLock, noteAiMarks, textLines, type NoteAiMarks } from './noteAi'
import { openSlashMenu } from './slashMenu'
import type { NoteAi } from './useNoteAi'

const CHIPS = ['Make it shorter', 'Make it concrete', 'Translate to English'] as const
const GAP = 8
const WIDTH = 340
/** The old text's fade before the accepted changes go in; the transition in `noteAi.ts`. */
const LEAVE_MS = 220
const SETTLE_MS = 450

const changeCount = (count: number) => `${count} ${count === 1 ? 'change' : 'changes'}`

/** The composer's send button, at the size of a one-line field. */
function Send({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="grid h-7 w-7 flex-none cursor-pointer place-items-center rounded-full border-0 bg-text text-[15px] font-medium text-bg disabled:cursor-default disabled:opacity-[0.3]"
      disabled={disabled}
      title="Send (Enter)"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <span aria-hidden="true">↑</span>
      <span className="sr-only">Send</span>
    </button>
  )
}

const Shimmer = ({ children }: { children: string }) => (
  <span className="shimmer-text text-label" data-text={children}>{children}</span>
)

interface NoteAiLayerProps {
  view: EditorView | null
  /** Bumped on every editor update the layer should look at. */
  version: number
  ai: NoteAi
}

/**
 * The note AI inside the editor: it paints the job's state onto the text, runs the
 * accept sequence, and holds the comment field that sits under a selection.
 *
 * The field appears with the selection but does not take the caret. A selection is
 * also what gets typed over, formatted and copied, and a field that grabbed focus
 * would take all three away. Clicking it is what starts a comment.
 */
export function NoteAiLayer({ view, version, ai }: NoteAiLayerProps) {
  const reduce = useReducedMotion() ?? false
  const pop = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  /** The passage a comment is being written on, held once the field has the caret. */
  const [draft, setDraft] = useState<{ from: number; to: number } | null>(null)
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const [, setTick] = useState(0)
  /** A press inside the field, which blurs the editor a moment before the field has focus. */
  const holding = useRef(false)
  const settling = useRef(false)
  const latest = useRef(ai)
  latest.current = ai
  const state = ai.state

  // The job's state, painted on the text. While it is out the note cannot be typed in:
  // the proposal's offsets are read against exactly this document.
  useEffect(() => {
    if (view === null) return
    const locked = state.phase === 'working' || state.phase === 'proposal' || state.phase === 'applying'
    const marks: NoteAiMarks | null | undefined =
      state.phase === 'working' ? { kind: 'working', spans: state.scope === 'note' ? textLines(view.state.doc) : [{ from: state.from, to: state.to }] }
        : state.phase === 'proposal' ? { kind: 'proposal', changes: state.changes, leaving: false }
          : state.phase === 'applying' ? { kind: 'proposal', changes: state.changes, leaving: true }
            : draft !== null ? { kind: 'anchor', spans: [draft] }
              // Accepted text keeps its fading tint until the timer below clears it.
              : settling.current ? undefined : null
    if (marks !== undefined) settling.current = false
    view.dispatch({ effects: [noteAiLock.of(locked), ...(marks === undefined ? [] : [noteAiMarks.of(marks)])] })
    if (state.phase !== 'applying') return

    // Accept: the old text fades where it stands, then the changes go in as one step.
    const timer = window.setTimeout(() => {
      settling.current = true
      view.dispatch({
        changes: [...state.changes],
        effects: [noteAiLock.of(false), noteAiMarks.of({ kind: 'settled', spans: insertedSpans(state.changes) })],
        annotations: noteAiApply.of(true),
      })
      latest.current.applied(view.state.doc.toString())
      window.setTimeout(() => {
        if (!settling.current) return
        settling.current = false
        view.dispatch({ effects: noteAiMarks.of(null) })
      }, SETTLE_MS)
    }, reduce ? 0 : LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [view, state, draft, reduce])

  // A comment is written on the text as it stood. Text replaced under it, a re-read from
  // disk for one, leaves its range pointing at other words, so the comment ends there.
  const doc = view?.state.doc
  useEffect(() => {
    setDraft(null)
    setText('')
  }, [doc])

  useEffect(() => {
    if (view === null) return
    const down = (event: MouseEvent) => { if (event.button === 0) setDragging(true) }
    const up = () => {
      holding.current = false
      setDragging(false)
    }
    view.contentDOM.addEventListener('mousedown', down)
    window.addEventListener('mouseup', up)
    return () => {
      view.contentDOM.removeEventListener('mousedown', down)
      window.removeEventListener('mouseup', up)
    }
  }, [view])

  const selectionJob = state.phase !== 'idle' && state.scope === 'selection'
  const range = view?.state.selection.main ?? null
  const offering = view !== null && range !== null && state.phase === 'idle' && ai.blocked === '' && (
    draft !== null || (!range.empty && (view.hasFocus || holding.current) && !dragging && !view.composing && openSlashMenu(view.state) === null)
  )
  const shown = view !== null && (offering || selectionJob)
  /** The text the field hangs under. */
  const anchor = !shown || range === null ? null
    : state.phase === 'idle' ? draft ?? { from: range.from, to: range.to }
      : state.phase === 'working' ? { from: state.from, to: state.to }
        : state.phase === 'failed' ? { from: state.at, to: state.at }
          : { from: state.changes[0]?.from ?? 0, to: state.changes[0]?.to ?? 0 }

  useEffect(() => {
    if (!shown) return
    const move = () => setTick((tick) => tick + 1)
    window.addEventListener('scroll', move, true)
    window.addEventListener('resize', move)
    return () => {
      window.removeEventListener('scroll', move, true)
      window.removeEventListener('resize', move)
    }
  }, [shown])

  useLayoutEffect(() => {
    const element = pop.current
    if (element === null || view === null || anchor === null) return
    const length = view.state.doc.length
    const start = view.coordsAtPos(Math.min(anchor.from, length), 1)
    const end = view.coordsAtPos(Math.min(anchor.to, length), -1) ?? start
    const box = boundsOf(view)
    if (start === null || end === null) {
      element.style.visibility = 'hidden'
      return
    }
    // The proposed text is a widget after the old text and may wrap further down.
    const added = state.phase === 'proposal' ? view.dom.querySelector('.cm-manor-ai-new')?.getBoundingClientRect() : undefined
    const bottom = Math.max(end.bottom, added?.bottom ?? 0)
    if (bottom < box.top || start.top > box.bottom) {
      element.style.visibility = 'hidden'
      return
    }
    const width = Math.min(WIDTH, box.width - GAP * 2)
    const height = element.offsetHeight
    // The format bar goes above a selection and below it when there is no room; the
    // field then goes under the bar, or over it, so neither ever covers the other.
    const bar = window.document.querySelector('[data-note-toolbar]')?.getBoundingClientRect()
    let top = (bar !== undefined && bar.top >= bottom ? bar.bottom : bottom) + GAP
    if (top + height > window.innerHeight - GAP) {
      const ceiling = bar !== undefined && bar.bottom <= start.top ? bar.top : start.top
      top = Math.max(GAP, ceiling - GAP - height)
    }
    element.style.left = `${Math.round(Math.max(box.left + GAP, Math.min(start.left, box.right - GAP - width)))}px`
    element.style.top = `${Math.round(top)}px`
    element.style.width = `${width}px`
    element.style.visibility = 'visible'
  })

  const cancel = () => {
    setDraft(null)
    setText('')
  }

  const submit = () => {
    const instruction = text.trim()
    if (view === null || draft === null || instruction === '') return
    ai.ask(draft, instruction)
    // The selection has done its work; left standing it would bring the format bar back over the diff.
    view.dispatch({ selection: EditorSelection.cursor(draft.to) })
    cancel()
    view.focus()
  }

  // A selection's proposal answers to the keys from wherever focus is in the note.
  const answering = selectionJob && (state.phase === 'proposal' || state.phase === 'working')
  useEffect(() => {
    if (!answering) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return
      const target = event.target
      const inNote = target instanceof Node && (view?.dom.contains(target) === true || pop.current?.contains(target) === true || target === window.document.body)
      if (!inNote || target instanceof HTMLButtonElement || event.metaKey || event.ctrlKey || event.altKey) return
      const now = latest.current
      if (now.state.phase === 'working') {
        if (event.key !== 'Escape') return
        now.stop()
      } else if (event.key === 'Enter') {
        if (!now.canAccept) return
        now.accept()
      } else now.reject()
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [answering, view])

  let body: ReactNode = null
  if (state.phase === 'idle') {
    body = (
      <>
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder="What should change?"
          aria-label="Comment on the selection"
          className="block max-h-32 w-full resize-none border-0 bg-transparent px-1.5 py-1 text-[14px] leading-normal text-text outline-none placeholder:text-dim"
          onFocus={() => {
            holding.current = false
            if (draft === null && range !== null && !range.empty) setDraft({ from: range.from, to: range.to })
          }}
          onBlur={(event) => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) cancel() }}
          onChange={(event) => {
            setText(event.target.value)
            event.target.style.height = 'auto'
            event.target.style.height = `${event.target.scrollHeight}px`
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              // The selection goes with the comment, or the field would be offered again at once.
              if (view !== null && draft !== null) view.dispatch({ selection: EditorSelection.cursor(draft.to) })
              cancel()
              view?.focus()
            } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="flex flex-wrap gap-1 px-1 pt-0.5 pb-1.5">
          {CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              className="cursor-pointer rounded-full border border-line bg-transparent px-2.5 py-0.5 text-meta text-muted hover:text-text"
              onClick={() => {
                setText(chip)
                field.current?.focus()
              }}
            >
              {chip}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="pl-1.5 text-meta text-dim">Esc to cancel</span>
          <Send disabled={text.trim() === ''} onClick={submit} />
        </div>
      </>
    )
  } else if (state.phase === 'working') {
    body = (
      <div className="px-1.5 py-1">
        <Shimmer>Rewriting…</Shimmer>
        <p className="m-0 mt-1 truncate text-meta text-dim">“{state.instruction}”</p>
      </div>
    )
  } else if (state.phase === 'failed') {
    body = (
      <div className="flex items-start gap-2 px-1.5 py-1">
        <p role="alert" className="m-0 flex-1 text-label text-muted">{state.message}</p>
        <Button size="compact" variant="ghost" onClick={ai.reject}>Dismiss</Button>
      </div>
    )
  } else {
    body = (
      <div className="flex items-center justify-between gap-2 p-0.5">
        <span className="min-w-0 truncate pl-1.5 text-meta text-dim">{ai.model} · {changeCount(state.changes.length)}</span>
        <span className="flex flex-none items-center gap-1.5">
          <Button size="compact" disabled={state.phase === 'applying' || state.accepting} onClick={ai.reject}>Reject</Button>
          <Button size="compact" variant="primary" disabled={!ai.canAccept} onClick={ai.accept}>
            Accept <span aria-hidden="true" className="ml-0.5 text-meta opacity-70">↵</span>
          </Button>
        </span>
      </div>
    )
  }

  return createPortal(
    <AnimatePresence>
      {!shown ? null : (
        <motion.div
          key="note-ai-comment"
          ref={pop}
          role="group"
          aria-label="Ask AI about the selection"
          data-note-ai-comment
          data-version={version}
          // Placed by the layout effect above before the first paint; hidden until then.
          className="invisible fixed top-0 left-0 z-40 rounded-xl border border-line surface-floating p-2 shadow-popover"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0.08 } } : { opacity: 0, y: -2, transition: { duration: 0.1 } }}
          transition={reduce ? { duration: 0.1 } : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          onPointerDownCapture={() => { holding.current = true }}
          // Only the field takes the caret; a press anywhere else leaves it where it is.
          onMouseDown={(event) => { if (!(event.target instanceof HTMLTextAreaElement)) event.preventDefault() }}
        >
          {body}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/**
 * The composer that floats at the foot of a note and edits the whole of it. One line
 * and fully round, on the chat composer's surface, and with no focus state: it sits
 * over the text and should not light up every time the caret passes through.
 */
export function NoteAiComposer({ ai }: { ai: NoteAi }) {
  const [text, setText] = useState('')
  const state = ai.state
  const own = state.phase !== 'idle' && state.scope === 'note'
  const busy = state.phase !== 'idle' && state.phase !== 'failed'

  const submit = () => {
    const instruction = text.trim()
    if (instruction === '' || busy || ai.blocked !== '') return
    ai.ask(null, instruction)
    setText('')
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-[5] flex justify-center px-4">
      <div role="group" aria-label="Ask AI to change this note" className="pointer-events-auto relative flex min-h-11 w-full max-w-[560px] items-center gap-2 rounded-full border border-composer-line py-1.5 pr-1.5 pl-[18px] shadow-composer">
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-[color-mix(in_srgb,var(--color-composer)_82%,transparent)] backdrop-blur-[16px] backdrop-saturate-[1.08]" />
        {own && state.phase === 'working' ? (
          <>
            <span className="min-w-0 flex-1 truncate"><Shimmer>Working on the note…</Shimmer></span>
            <Button size="compact" className="rounded-full" onClick={ai.stop}>Stop</Button>
          </>
        ) : own && state.phase === 'failed' ? (
          <>
            <p role="alert" className="m-0 min-w-0 flex-1 truncate text-label text-muted" title={state.message}>{state.message}</p>
            <Button size="compact" variant="ghost" className="rounded-full" onClick={ai.reject}>Dismiss</Button>
          </>
        ) : own && (state.phase === 'proposal' || state.phase === 'applying') ? (
          <>
            <span className="min-w-0 flex-1 truncate text-meta text-dim">
              {changeCount(state.changes.length)}{state.phase === 'proposal' ? ` · “${state.instruction}”` : ''}
            </span>
            <Button size="compact" className="rounded-full" disabled={state.phase === 'applying' || state.accepting} onClick={ai.reject}>Reject</Button>
            <Button size="compact" variant="primary" className="rounded-full" disabled={!ai.canAccept} onClick={ai.accept}>Accept all</Button>
          </>
        ) : (
          <>
            <input
              value={text}
              placeholder="Ask AI to change this note…"
              aria-label="Ask AI to change this note"
              autoComplete="off"
              disabled={busy || ai.blocked !== ''}
              className="min-w-0 flex-1 border-0 bg-transparent py-1 text-[15px] text-text outline-none placeholder:text-dim disabled:cursor-default"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                submit()
              }}
            />
            <Send disabled={text.trim() === '' || busy || ai.blocked !== ''} onClick={submit} />
          </>
        )}
      </div>
    </div>
  )
}
