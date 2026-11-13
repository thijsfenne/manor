import { useEffect, useMemo } from 'react'
import { forgetClosedWorkChanges } from './workChanges'
import { projectWorkHandoffs, rowsOf, type ThreadShape, type TurnRow } from './state'
import type { useChatDialogs } from './useChatDialogs'
import type { Manor } from './useWorkspace'

/**
 * The open chat's transcript rows with its Work handoffs projected in, and the turns in
 * it that are running. Keeps the handoffs' checkout status and Request changes notes
 * current while they can still change.
 */
export function useOpenChatRows(
  manor: Manor,
  openChatId: string | undefined,
  thread: ThreadShape,
  baseRows: ReturnType<typeof rowsOf>,
  bornChat: ReturnType<typeof useChatDialogs>['bornChat'],
) {
  const { workspace, status } = manor
  /**
   * A chat between its own snapshot and its first written event. The snapshot is
   * authoritative and, for a chat that was made a moment ago, empty: the message that
   * created it is still on its way to being durable. Rendering that gap as "Empty
   * thread" makes the line the user just sent blink out and come back, which is what
   * a newly created chat looked like. So the message stays on screen, dimmed, exactly
   * as an ordinary unsent one does, until a row of any kind exists to replace it.
   */
  const rawRows = useMemo(
    () =>
      bornChat !== null && openChatId === bornChat.chatId && baseRows.length === 0
        ? rowsOf({ ...thread, pending: [{ key: 'pending:new-chat', ...bornChat.sent }] })
        : baseRows,
    [baseRows, thread, bornChat, openChatId],
  )
  const rows = useMemo(
    () => projectWorkHandoffs(rawRows, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus),
    [rawRows, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus],
  )
  // Recheck pending Work when its folders change or this client reconnects.
  const pendingWorkCheckouts = JSON.stringify(rows.flatMap((row) => {
    if (row.kind !== 'work_handoff' || row.acceptedAt !== null || row.status !== 'Working') return []
    const project = workspace.projects.find((project) => project.id === row.projectId)
    return [{ projectId: row.projectId, repoPaths: project?.repoPaths ?? [] }]
  }))
  useEffect(() => {
    if (status !== 'live') return
    const targets: { projectId: string }[] = JSON.parse(pendingWorkCheckouts)
    for (const projectId of new Set(targets.map((target) => target.projectId))) manor.askProjectCheckout(projectId)
  }, [pendingWorkCheckouts, status, manor.askProjectCheckout])
  // Request changes feedback is only kept for a result that can still change.
  useEffect(() => {
    if (status === 'live') forgetClosedWorkChanges(workspace.workHandoffs, workspace.chats)
  }, [status, workspace.workHandoffs, workspace.chats])

  const running = useMemo(
    () => rows.filter((row): row is TurnRow => row.kind === 'turn' && row.live?.state === 'running'),
    [rows],
  )
  return { rows, running }
}
