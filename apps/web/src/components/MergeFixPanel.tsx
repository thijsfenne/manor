import { useEffect, useState } from 'react'
import { WORK_RESULT_CONNECTION_LOST, mergeFixLines, workMergeFix, type WorkResult } from '../state'
import { useRequest } from '../useRequest'
import { Button } from './ui/Button'
import type { WorkResultActions } from './WorkResultBody'

const LINE_TONE = { add: 'text-ok', remove: 'text-danger', meta: 'text-dim', context: 'text-muted' } as const

/**
 * The conflict fix Manor holds before it merges a confirmed Session: the lead rewrote a
 * conflicted change instead of keeping both sides, so the user reads the fix and approves it.
 * Nothing shows for a clean rebase or a fix that kept both sides; Manor merged those.
 */
export function MergeFixPanel({ result, actions, onOpenSession }: {
  result: WorkResult
  actions?: WorkResultActions
  onOpenSession?: () => void
}) {
  const fix = workMergeFix(result)
  const request = useRequest(actions?.requestEvents ?? NO_EVENTS)
  const { pending, cancel } = request
  const [error, setError] = useState<string | null>(null)
  const connected = actions?.connected === true

  useEffect(() => {
    if (!connected && pending) {
      cancel()
      setError(WORK_RESULT_CONNECTION_LOST)
    }
  }, [connected, pending, cancel])

  if (fix === undefined) return null
  const approveFix = actions?.approveFix
  const approve = () => {
    if (approveFix === undefined) return
    setError(null)
    request.start((requestId) => approveFix(result.handoffId, fix.tip, requestId), { onNotice: (notice) => setError(notice.text) })
  }
  const into = result.completion?.mergeInto ?? 'its branch'
  const files = fix.files.length === 1 ? fix.files[0] : `${fix.files.length} files`

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="m-0 text-[13px] leading-[1.45] text-muted">
        The lead resolved a conflict in {files} while rebasing onto {into}. Read the fix; approving it merges the Session.
      </p>
      <pre
        aria-label="Conflict fix"
        className="m-0 max-h-60 overflow-auto rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-[12px] leading-[1.5]"
      >
        {mergeFixLines(fix.diff).map((line, index) => (
          <div key={index} className={LINE_TONE[line.kind]}>{line.text === '' ? ' ' : line.text}</div>
        ))}
        {fix.truncated === true ? <div className="text-dim">… the rest is in the Session’s diff</div> : null}
      </pre>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onOpenSession === undefined ? null : (
          <Button size="compact" variant="ghost" onClick={onOpenSession} className="mr-auto">Open Session</Button>
        )}
        {approveFix === undefined ? null : (
          <Button size="compact" variant="primary" disabled={pending || !connected} onClick={approve}>
            {pending ? 'Approving…' : 'Approve fix and merge'}
          </Button>
        )}
      </div>
      {error === null ? null : <p role="alert" className="m-0 text-[13px] text-danger">{error}</p>}
    </div>
  )
}

const NO_EVENTS = { subscribe: () => () => undefined }
