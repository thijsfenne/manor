import { useEffect, useRef, useState } from 'react'
import { Cancel01Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import type { McpHostStatus, McpServerConfig, McpServerDraft } from '@manor/contracts'
import { connectorCost, formatTokens } from '../../mcp'
import { parseMcpPaste, pasteNote } from '../../mcpPaste'
import { ConfirmStrip } from '../Confirm'
import { Modal, ModalFooter } from '../Modal'
import type { Notice } from '../../state'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { FormField, formHintClass, formInputClass } from '../ui/FormField'
import { Icon } from '../Icon'
import { IconButton } from '../ui/IconButton'

/** A request that never left the browser. Nothing changed, and saying so is the point. */
const OFFLINE = 'Nothing was sent, the connection is down. Try again once it is back.'

interface McpServerDialogProps {
  /** The entry as it stands, or a blank one. */
  initial: McpServerDraft
  /** The saved row when this is an edit, for what the probe last learned about it. */
  saved: McpServerConfig | undefined
  /** Persona names using this connector; registry ownership remains outside the dialog. */
  holders?: readonly string[]
  hostStatus: McpHostStatus | undefined
  notice: Notice | null
  pending: 'save' | 'verify' | 'delete' | null
  onSave: (server: McpServerDraft) => boolean
  onVerify: () => boolean
  onDelete: () => boolean
  onDismissNotice: () => void
  onClose: () => void
}

/**
 * One registry entry. Saving starts the server once and asks it for its tools, so a
 * row here always describes something that actually runs on this machine; that is
 * also why saving is slower than the other dialogs and says so.
 */
export function McpServerDialog({
  initial,
  saved,
  holders = [],
  hostStatus,
  notice,
  pending,
  onSave,
  onVerify,
  onDelete,
  onDismissNotice,
  onClose,
}: McpServerDialogProps) {
  const [draft, setDraft] = useState(initial)
  const [args, setArgs] = useState(() => initial.args.join(' '))
  const [envKeys, setEnvKeys] = useState(() => initial.envKeys)
  const [problem, setProblem] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  // The paste box and what it had to say about what it filled in. Only offered on a
  // new server: an edit already has its values, and re-pasting over them would be a
  // second way to say the same thing.
  const [paste, setPaste] = useState('')
  const [pasteProblem, setPasteProblem] = useState<string | null>(null)
  const [pasteNoted, setPasteNoted] = useState<string | null>(null)
  const wasUnavailable = useRef(saved?.unavailable !== undefined)
  const savedUrl = useRef(saved?.url)
  const verificationStarted = useRef(false)

  const existing = initial.id !== undefined
  const busy = pending !== null
  const command = draft.command.trim()
  const url = (draft.url ?? '').trim()
  const recoveryPending = saved?.unavailable === undefined && wasUnavailable.current
  const canSave = !recoveryPending
    && saved?.unavailable === undefined
    && draft.name.trim() !== ''
    && (command.length > 0) !== (url.length > 0)
    && !busy

  useEffect(() => {
    const unavailable = saved?.unavailable !== undefined
    const recovered = wasUnavailable.current && !unavailable
    const urlChanged = saved !== undefined && saved.url !== savedUrl.current
    wasUnavailable.current = unavailable
    savedUrl.current = saved?.url
    if (saved === undefined || (!recovered && !(verificationStarted.current && urlChanged))) return

    // Composio verification rotates only its server-owned session URL. Keep every
    // form edit around it, while ensuring Save can never revive the previous URL.
    verificationStarted.current = false
    setDraft((current) => ({ ...current, url: saved.url ?? '' }))
    setProblem(null)
    onDismissNotice()
  }, [saved, onDismissNotice])

  useEffect(() => {
    if (pending !== 'verify') verificationStarted.current = false
  }, [pending])

  const edit = (patch: Partial<McpServerDraft>) => {
    setProblem(null)
    onDismissNotice()
    setDraft((current) => ({ ...current, ...patch }))
  }

  /**
   * Fills the form from the snippet a server's README hands out. Parsed as it changes
   * rather than behind a button, but a failure is only reported once the text looks
   * finished, so the box does not complain at the first brace of a slow paste.
   *
   * A successful fill empties the box: the form now holds the truth, and leaving the
   * raw snippet on screen would be a second copy that can disagree with it. It also
   * means a pasted credential does not sit in a textarea for the rest of the session.
   */
  const editPaste = (text: string) => {
    setPaste(text)
    setPasteProblem(null)
    setPasteNoted(null)
    onDismissNotice()
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const parsed = parseMcpPaste(text)
    if (!parsed.ok) {
      if (trimmed.endsWith('}')) setPasteProblem(parsed.message)
      return
    }
    const { draft: filled, ...rest } = parsed.outcome
    // A bare server object carries no name, and overwriting one the user already
    // typed with an empty string would be the paste box eating their work.
    setDraft((current) => ({ ...current, ...filled, name: filled.name || current.name }))
    setArgs(filled.args.join(' '))
    setEnvKeys(filled.envKeys)
    setPaste('')
    setProblem(null)
    setPasteNoted(pasteNote({ draft: filled, ...rest }) ?? null)
  }

  const submit = () => {
    if (!canSave) return
    setProblem(null)
    const server: McpServerDraft = {
      ...draft,
      args: args.split(/\s+/).filter((arg) => arg.length > 0),
      envKeys: envKeys.map((key) => key.trim()).filter((key) => key.length > 0),
    }
    if (!onSave(server)) setProblem(OFFLINE)
  }

  return (
    <Modal title={existing ? `Edit ${initial.name}` : 'New MCP server'} width="wide" onClose={onClose}>
      {existing ? null : (
        <FormField
          label="Paste a config"
          optional
          hint="The JSON block from the server’s README, in any of the usual shapes. Env values are dropped and only their variable names kept; a credential inside an argument is kept as pasted, and flagged."
        >
          <textarea
            className={`${formInputClass} min-h-[76px] resize-y font-mono text-[12px] leading-relaxed`}
            value={paste}
            placeholder={'{"mcpServers": {"context7": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]}}}'}
            onChange={(event) => editPaste(event.target.value)}
          />
        </FormField>
      )}

      {pasteProblem !== null || pasteNoted !== null ? (
        <p
          className={`m-0 -mt-1 px-0.5 text-label ${pasteProblem === null ? 'text-muted' : 'text-danger'}`}
          role="status"
        >
          <span className="[overflow-wrap:anywhere]">{pasteProblem ?? pasteNoted}</span>
        </p>
      ) : null}

      {saved !== undefined ? (
        <section className="rounded-xl border border-line bg-surface-2 px-3.5 py-3">
          <p className="m-0 text-[13px] font-medium text-text">
            {saved.tools.length} {saved.tools.length === 1 ? 'tool' : 'tools'}, about{' '}
            {formatTokens(connectorCost(saved).listedTokens)} tokens per turn as listed names (none on Codex), up to{' '}
            {formatTokens(connectorCost(saved).loadedTokens)} once every schema is loaded,{' '}
            {holders.length === 0 ? 'attached to nobody' : `attached to ${holders.join(', ')}`}
          </p>
          {saved.tools.length === 0 ? null : (
            <details className="mt-1.5 text-label text-dim">
              <summary className="w-fit cursor-pointer text-muted hover:text-text">
                Show tool names
              </summary>
              <p className="mt-2 mb-0 [overflow-wrap:anywhere]">{saved.tools.join(', ')}</p>
            </details>
          )}
        </section>
      ) : null}

      <div className="flex gap-3">
        <FormField
          label="Name"
          className="w-[200px] flex-none"
          hint="Becomes the mcp__<name>__ prefix."
        >
          <input
            className={`${formInputClass} font-mono`}
            autoFocus
            value={draft.name}
            placeholder="supabase"
            onChange={(event) => edit({ name: event.target.value })}
          />
        </FormField>
        <FormField label="Description" optional className="min-w-0 flex-1">
          <input
            className={formInputClass}
            value={draft.description}
            placeholder="Database, migrations and logs."
            onChange={(event) => edit({ description: event.target.value })}
          />
        </FormField>
      </div>

      <FormField
        label="Command"
        hint="The executable Manor starts. Leave empty for an HTTP server. An absolute path is safest on the VPS."
      >
        <input
          className={`${formInputClass} font-mono`}
          value={draft.command}
          placeholder="/usr/local/bin/mcp-server-supabase"
          onChange={(event) => edit({ command: event.target.value })}
        />
      </FormField>

      <FormField
        label="URL"
        optional
        hint="Streamable HTTP endpoint. When set, Manor does not start a process."
      >
        <input
          className={`${formInputClass} font-mono`}
          value={draft.url ?? ''}
          placeholder="http://127.0.0.1:3845/mcp"
          onChange={(event) => edit({ url: event.target.value })}
        />
      </FormField>

      <FormField label="Arguments" optional hint="Separated by spaces.">
        <input
          className={`${formInputClass} font-mono`}
          value={args}
          placeholder="--read-only"
          onChange={(event) => {
            setArgs(event.target.value)
            setProblem(null)
            onDismissNotice()
          }}
        />
      </FormField>

      <FormField
        label="Environment keys"
        optional
        custom
      >
        {envKeys.length === 0 ? null : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {envKeys.map((key, index) => {
              const trimmed = key.trim()
              const known = hostStatus?.env.find((entry) => entry.key === trimmed)
              return (
                <li key={index} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-1">
                  <input
                    aria-label={`Environment key ${index + 1}`}
                    className="min-w-0 flex-1 border-0 bg-transparent px-1.5 py-1 font-mono text-[13px] text-text outline-none placeholder:text-dim"
                    value={key}
                    placeholder="SUPABASE_ACCESS_TOKEN"
                    onChange={(event) => {
                      setEnvKeys((current) => current.map((value, at) => (at === index ? event.target.value : value)))
                      setProblem(null)
                      onDismissNotice()
                    }}
                  />
                  {trimmed.length === 0 ? null : (
                    <span className={`flex-none text-[12px] ${known?.present ? 'text-text' : 'text-dim'}`}>
                      {known === undefined ? 'checked on save' : known.present ? 'found on this machine' : 'not set'}
                    </span>
                  )}
                  <IconButton
                    className="h-7 w-7"
                    icon={Cancel01Icon}
                    iconSize={12}
                    label={`Remove environment key ${index + 1}`}
                    onClick={() => setEnvKeys((current) => current.filter((_, at) => at !== index))}
                  />
                </li>
              )
            })}
          </ul>
        )}
        <Button
          size="small"
          className="mt-0.5 inline-flex w-fit items-center gap-1.5"
          onClick={() => setEnvKeys((current) => [...current, ''])}
        >
          <Icon icon={PlusSignIcon} size={12} />
          Add key
        </Button>
      </FormField>

      {existing ? (
        <section className="flex flex-col gap-2">
          {saved?.unavailable === undefined ? null : (
            <div className="flex flex-col gap-0.5 px-0.5" role="status">
              <span className="text-[13px] font-medium text-danger">Unavailable</span>
              <span className="text-label text-muted [overflow-wrap:anywhere]">{saved.unavailable}</span>
            </div>
          )}
          <div className="flex items-center gap-3 rounded-xl border border-line px-3.5 py-2.5">
            <Button
              disabled={busy}
              onClick={() => {
                verificationStarted.current = true
                if (!onVerify()) {
                  verificationStarted.current = false
                  setProblem(OFFLINE)
                }
              }}
            >
              {pending === 'verify'
                ? saved?.unavailable === undefined ? 'Testing…' : 'Reconnecting…'
                : saved?.unavailable === undefined ? 'Test connection' : 'Reconnect'}
            </Button>
            <span className="min-w-0 text-[12px] text-muted">{hostCheckLabel(hostStatus?.check ?? null)}</span>
          </div>
        </section>
      ) : null}

      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox
          className="mt-[3px]"
          checked={draft.writes}
          onChange={(writes) => edit({ writes })}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] text-text">This server can change things</span>
          <span className={formHintClass}>
            Shows a warning wherever it is attached. It does not narrow any sandbox: the Codex sandbox
            governs shell commands and cannot reach an MCP process at all.
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox
          className="mt-[3px]"
          checked={draft.effectPolicy === 'trusted'}
          onChange={(trusted) => edit({ effectPolicy: trusted ? 'trusted' : 'confirm_writes' })}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] text-text">Trust this connector’s writes</span>
          <span className={formHintClass}>
            Trusted connectors act without asking. Leave this off for mail, publishing, accounts, and anything
            else that acts outward on your behalf.
          </span>
        </span>
      </label>

      {notice !== null || problem !== null ? (
        <p
          className={`m-0 px-0.5 pt-1 text-label ${
            notice !== null && notice.kind !== 'error' ? 'text-muted' : 'text-danger'
          }`}
          role="status"
        >
          <span className="[overflow-wrap:anywhere]">{notice?.text ?? problem}</span>
        </p>
      ) : null}

      <ModalFooter>
        {armed ? (
          <ConfirmStrip
            question={`Delete ${initial.name}? Every agent holding it is detached in the same write.`}
            onConfirm={() => {
              setArmed(false)
              if (!onDelete()) setProblem(OFFLINE)
            }}
            onCancel={() => setArmed(false)}
          />
        ) : (
          <div className="flex items-center gap-2 pt-0.5">
            {existing ? (
              <Button variant="danger" disabled={busy} onClick={() => setArmed(true)}>
                {pending === 'delete' ? 'Deleting…' : 'Delete'}
              </Button>
            ) : null}
            <div className="flex flex-1 justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" disabled={!canSave} onClick={submit}>
                {/* Saving starts the server and waits for its tool list, so this is the
                    one dialog where the wait is the point rather than a round trip. */}
                {pending === 'save' ? 'Starting the server…' : existing ? 'Save' : 'Add server'}
              </Button>
            </div>
          </div>
        )}
      </ModalFooter>
    </Modal>
  )
}

function hostCheckLabel(check: McpHostStatus['check']): string {
  if (check === null) return 'Not tested since this Manor server started.'
  const when = new Date(check.checkedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  if (check.result === 'verified') return `Last verified ${when} through ${check.tool ?? 'a read-only call'}.`
  if (check.result === 'failed') return `Last test failed ${when}.`
  return `Server checked ${when}; credentials were not functionally verified.`
}
