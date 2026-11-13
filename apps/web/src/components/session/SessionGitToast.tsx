import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ServerMessage } from '@manor/contracts'
import { TOAST_IN, TOAST_OUT, TOAST_TRAVEL, TOAST_VISIBLE_MS } from '../../motion'
import { ToastPill } from '../ui/ToastPill'
import type { SessionGitResult } from './SessionSections'

export interface SessionGitNotice {
  key: string
  text: string
  tone: 'running' | 'done' | 'failed'
}

export type SessionCommits = Extract<ServerMessage, { type: 'session_commits' }>['commits']

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
/** One key from start to end, so the pill turns its spinner into the outcome in place. */
const commitKey = (chatId: string, root: string) => `commit:${chatId}:${root}`

/**
 * A Session's Commit as the window's toast: a spinner for as long as the host says it
 * runs (never while the connection is down, when that cannot be known), then what it
 * ended in. A Commit finishes after its dialog closed, so its failure is a toast too;
 * the detail and the way back into the dialog stay under its Branch line. A Push
 * shows only when it went through: its refusal is answered in the panel that asked.
 * Only an answer that arrives while this hook runs counts.
 */
export function useSessionGitToast(results: Readonly<Record<string, SessionGitResult>>, commits: SessionCommits, live: boolean) {
  const seen = useRef(results)
  const [ended, setEnded] = useState<SessionGitNotice | null>(null)
  // A running pill the user hid; its outcome still shows.
  const [hidden, setHidden] = useState<string | null>(null)

  useEffect(() => {
    const before = seen.current
    seen.current = results
    const fresh = Object.values(results).find((result) => before[result.chatId] !== result && (result.ok || result.action === 'commit'))
    if (fresh === undefined) return
    setHidden(null)
    setEnded({
      key: fresh.action === 'commit' ? commitKey(fresh.chatId, fresh.root) : fresh.requestId ?? `${fresh.chatId}:${fresh.action}:${fresh.text}`,
      text: fresh.text,
      tone: fresh.ok ? 'done' : 'failed',
    })
  }, [results])

  // A Commit that starts again replaces what its last one ended in, at once.
  const seenCommits = useRef(commits)
  useEffect(() => {
    const before = seenCommits.current
    seenCommits.current = commits
    const started = commits
      .filter((commit) => !before.some((earlier) => earlier.chatId === commit.chatId && earlier.root === commit.root))
      .map((commit) => commitKey(commit.chatId, commit.root))
    if (started.length === 0) return
    setEnded((current) => current !== null && started.includes(current.key) ? null : current)
    setHidden((current) => current !== null && started.includes(current) ? null : current)
  }, [commits])

  useEffect(() => {
    if (ended === null) return
    const timer = setTimeout(() => setEnded(null), TOAST_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [ended])

  const first = live ? commits[0] : undefined
  const running: SessionGitNotice | null = first === undefined ? null
    : { key: commitKey(first.chatId, first.root), text: `Committing ${plural(first.files, 'file')}…`, tone: 'running' }
  const notice = ended ?? (running !== null && running.key !== hidden ? running : null)
  return {
    notice,
    dismiss: () => {
      if (ended !== null) setEnded(null)
      else if (running !== null) setHidden(running.key)
    },
  }
}

/** Top centre of the window, under the provider-update toast when both are up. */
export function SessionGitToast({ notice, onDismiss }: { notice: SessionGitNotice | null; onDismiss: () => void }) {
  const reduce = useReducedMotion() ?? false
  return (
    <AnimatePresence mode="wait">
      {notice === null ? null : (
        <motion.div
          key={notice.key}
          className="no-drag pointer-events-auto"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -TOAST_TRAVEL }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, y: -TOAST_TRAVEL / 2, transition: TOAST_OUT }}
          transition={reduce ? { duration: 0.12 } : TOAST_IN}
        >
          <ToastPill done={notice.tone === 'done'} failed={notice.tone === 'failed'} label={notice.text}
            dismissLabel={notice.tone === 'running' ? 'Hide progress' : 'Dismiss'} onDismiss={onDismiss} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
