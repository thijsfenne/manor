import { useEffect, useState } from 'react'
import type { McpServerConfig, McpServerDraft } from '@manor/contracts'
import { useRequest, type RequestEvents } from '../../useRequest'

interface McpDialogOptions {
  requestEvents: RequestEvents
  onSave: (server: McpServerDraft, requestId: string) => boolean
  onVerify: (serverId: string, requestId: string) => boolean
  onDelete: (serverId: string, requestId: string) => boolean
  onDismissNotice: () => void
  onDialogChange?: (open: boolean) => void
}

export const emptyServerDraft = (): McpServerDraft => ({
  name: '',
  command: '',
  args: [],
  envKeys: [],
  url: '',
  description: '',
  writes: false,
  effectPolicy: 'confirm_writes',
})

export const serverDraftOf = (server: McpServerConfig): McpServerDraft => ({
  id: server.id,
  name: server.name,
  command: server.command,
  args: server.args,
  envKeys: server.envKeys,
  httpHeaders: server.httpHeaders,
  url: server.url ?? '',
  description: server.description,
  writes: server.writes,
  effectPolicy: server.effectPolicy,
})

/**
 * The request lifecycle for the registry dialog, mirroring `useAgentDialog`. The
 * Unlike an agent save, this one waits on a process starting, so the pending state
 * can sit for a second or two and the button says what it is waiting for.
 */
export function useMcpDialog({ requestEvents, onSave, onVerify, onDelete, onDismissNotice, onDialogChange }: McpDialogOptions) {
  const [editing, setEditing] = useState<McpServerDraft | null>(null)
  const [pending, setPending] = useState<'save' | 'verify' | 'delete' | null>(null)
  const { start, cancel } = useRequest(requestEvents)

  useEffect(() => {
    onDialogChange?.(editing !== null)
    return () => onDialogChange?.(false)
  }, [editing, onDialogChange])

  const open = (draft: McpServerDraft) => {
    onDismissNotice()
    cancel()
    setPending(null)
    setEditing(draft)
  }

  return {
    editing,
    pending,
    openNew: () => open(emptyServerDraft()),
    openServer: (server: McpServerConfig) => open(serverDraftOf(server)),
    close: () => {
      onDismissNotice()
      cancel()
      setPending(null)
      setEditing(null)
    },
    save: (draft: McpServerDraft) => {
      const sent = start((requestId) => onSave(draft, requestId), {
        onAck: () => {
          setPending(null)
          setEditing(null)
        },
        onNotice: () => setPending(null),
      })
      if (sent) setPending('save')
      return sent
    },
    verify: () => {
      if (editing?.id === undefined) return false
      const serverId = editing.id
      const sent = start((requestId) => onVerify(serverId, requestId), {
        onAck: () => setPending(null),
        onNotice: () => setPending(null),
      })
      if (sent) setPending('verify')
      return sent
    },
    remove: () => {
      if (editing?.id === undefined) return false
      const serverId = editing.id
      const sent = start((requestId) => onDelete(serverId, requestId), {
        onAck: () => {
          setPending(null)
          setEditing(null)
        },
        onNotice: () => setPending(null),
      })
      if (sent) setPending('delete')
      return sent
    },
  }
}
