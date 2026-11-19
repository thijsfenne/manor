import { useEffect, useState } from 'react'
import { NOTE_AI_DEFAULTS, type HouseSettings, type ProviderConnection, type ProviderUpdate, type SystemInfo } from '@manor/contracts'
import type { Notice } from '../../state'
import { ProviderMark } from '../ProviderMark'
import { SideRuntimeMenu } from '../SideRuntimeMenu'
import type { UpdateProviders } from '../ProviderUpdates'
import { desktopChooseFolder } from '../../desktopBrowser'
import { Button } from '../ui/Button'
import { formInputClass } from '../ui/FormField'
import { RequestNotice } from '../ui/RequestNotice'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsLayout'

const PROVIDER_NAME: Record<SystemInfo['providers'][number]['driver'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  cursor: 'Cursor',
  mock: 'Mock',
}

/** Read once on the way in; these pages show what the Mac runs and change nothing. */
function useSystemInfo(onRequest: () => void) {
  useEffect(() => onRequest(), [onRequest])
}

const Reading = () => <p className="m-0 text-label text-dim">Asking the Mac…</p>

const Path = ({ value }: { value: string }) => (
  <code className="block max-w-[340px] truncate font-mono text-label text-muted" title={value}>{value}</code>
)

/**
 * Whether one provider is ready to answer, and the one thing to do when it is not.
 * The server decides the state; this only words it. Signing in happens in the
 * browser on the Mac, through the provider's own CLI.
 */
export function ProviderConnectionStatus({ connection, onSignIn, onCancelSignIn, onInstall }: {
  connection: ProviderConnection
  onSignIn: (provider: ProviderConnection['provider']) => void
  /** Stops a sign-in or an install that is under way. */
  onCancelSignIn: (provider: ProviderConnection['provider']) => void
  onInstall: (provider: ProviderConnection['provider']) => void
}) {
  switch (connection.state) {
    case 'ready':
      return (
        <span className="text-label text-muted" title={connection.account}>
          Signed in{connection.plan === undefined ? '' : `, ${connection.plan}`}
        </span>
      )
    case 'signing_in':
      return (
        <>
          <span className="text-label text-muted">Finish in your browser…</span>
          <Button size="compact" variant="ghost" onClick={() => onCancelSignIn(connection.provider)}>Cancel</Button>
        </>
      )
    case 'install':
      return connection.canInstall
        ? <Button size="compact" variant="primary" onClick={() => onInstall(connection.provider)}>Install</Button>
        : <span className="text-label text-dim">Not installed</span>
    case 'installing':
      return (
        <>
          <span className="text-label text-muted">Installing, this can take a minute…</span>
          <Button size="compact" variant="ghost" onClick={() => onCancelSignIn(connection.provider)}>Cancel</Button>
        </>
      )
    case 'sign_in':
    case 'attention':
      return connection.canSignIn ? (
        <Button size="compact" variant={connection.state === 'sign_in' ? 'primary' : 'secondary'} onClick={() => onSignIn(connection.provider)}>
          Sign in
        </Button>
      ) : null
  }
}

export function ProvidersPage({ info, updates, connections, onRequest, onUpdate, onCheck, onSignIn, onCancelSignIn, onInstall }: {
  info: SystemInfo | null
  updates: readonly ProviderUpdate[]
  connections: readonly ProviderConnection[]
  onRequest: () => void
  onUpdate: UpdateProviders
  onCheck: () => void
  onSignIn: (provider: ProviderConnection['provider']) => void
  onCancelSignIn: (provider: ProviderConnection['provider']) => void
  onInstall: (provider: ProviderConnection['provider']) => void
}) {
  useSystemInfo(onRequest)
  // A login can change outside Manor (a terminal, another app), so opening the page asks again.
  // Braces on purpose: the action answers whether it was sent, and an effect that
  // returns a value hands React a cleanup that is not a function.
  useEffect(() => { onCheck() }, [onCheck])
  return (
    <SettingsPage title="Providers & keys">
      {info === null ? <Reading /> : (
        <SettingsGroup title="Provider CLIs">
          {info.providers.length === 0 ? (
            <SettingsRow label="No provider CLIs" description="This server runs the mock driver, which reaches no provider." />
          ) : null}
          {info.providers.map((provider) => {
            const update = provider.driver === 'mock' ? undefined : updates.find((entry) => entry.provider === provider.driver)
            // The update check is fresher than the version read at server start; an install has none yet.
            const version = update === undefined || update.currentVersion === '' ? provider.version : update.currentVersion
            const connection = connections.find((entry) => entry.provider === provider.driver)
            return (
              <SettingsRow
                key={provider.driver}
                label={
                  <span className="flex items-center gap-2">
                    <ProviderMark driver={provider.driver} size={14} />
                    {PROVIDER_NAME[provider.driver]}
                  </span>
                }
                description={
                  <>
                    <Path value={provider.command} />
                    {connection?.message === undefined ? null : <span className="block">{connection.message}</span>}
                  </>
                }
              >
                {connection === undefined ? null : (
                  <ProviderConnectionStatus connection={connection} onSignIn={onSignIn} onCancelSignIn={onCancelSignIn} onInstall={onInstall} />
                )}
                {connection?.state === 'install' || connection?.state === 'installing' ? null : (
                  <span className="text-label text-muted tabular-nums">{version ?? 'Version unknown'}</span>
                )}
                {update === undefined || !update.canUpdate || update.state === 'updated' ? null : (
                  <Button size="compact" variant="secondary" disabled={update.state === 'updating'} onClick={() => onUpdate(update.provider)}>
                    {update.state === 'updating' ? 'Updating…' : update.state === 'failed' ? 'Retry update' : `Update to ${update.latestVersion}`}
                  </Button>
                )}
              </SettingsRow>
            )
          })}
        </SettingsGroup>
      )}
      <SettingsGroup title="Keys">
        <SettingsRow
          label="API keys and app passwords"
          description="Kept in apps/server/.env on the Mac and never sent through the app. Change them there, then restart the server."
        />
      </SettingsGroup>
    </SettingsPage>
  )
}

type FolderKey = 'memoryDir' | 'knowledgeDir'

/**
 * One folder Manor keeps things in: where it is now, a way to look inside, and a way
 * to move it. A move is saved at once and takes effect at the next start, which the
 * row says for as long as the two differ. A folder an environment variable decides
 * shows where it is and offers nothing to change.
 */
function FolderRow({ label, description, variable, state, onChoose, onReveal }: {
  label: string
  description: string
  variable: string
  state: SystemInfo['vault']
  /** Null goes back to the default folder. */
  onChoose: (path: string | null) => void
  onReveal: () => void
}) {
  const chooseFolder = desktopChooseFolder()
  const [choosing, setChoosing] = useState(false)
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')

  const choose = async () => {
    if (chooseFolder === undefined) {
      setTyping(true)
      return
    }
    if (choosing) return
    setChoosing(true)
    try {
      const path = await chooseFolder()
      if (path !== null) onChoose(path)
    } catch {
      // The Finder sheet could not open; the folder stays as it is.
    } finally {
      setChoosing(false)
    }
  }
  const submit = () => {
    const path = typed.trim()
    if (path === '') return
    onChoose(path)
    setTyping(false)
    setTyped('')
  }

  // Stacked, not label-left and control-right: a path needs the row's whole width.
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] font-medium text-text">{label}</span>
        <span className="text-label text-muted">
          {state.pinned ? `${description} Set by ${variable} in apps/server/.env.` : description}
        </span>
      </div>
      {typing ? (
        <div className="flex min-w-0 items-center gap-2">
          <input
            className={`${formInputClass} min-w-0 flex-1`}
            value={typed}
            placeholder="/Users/you/Notes"
            aria-label={`${label} path`}
            autoFocus
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') setTyping(false)
            }}
          />
          <Button size="compact" variant="primary" disabled={typed.trim() === ''} onClick={submit}>Save</Button>
          <Button size="compact" variant="ghost" onClick={() => setTyping(false)}>Cancel</Button>
        </div>
      ) : (
        <>
          {state.path === null ? <span className="text-label text-dim">Not available</span> : (
            // Shown whole and wrapped on its own line: a path cut off tells nobody where the folder is.
            <code className="break-all font-mono text-label text-muted">{state.path}</code>
          )}
          <div className="flex items-center gap-2">
            {state.pinned ? null : <Button size="compact" variant="secondary" disabled={choosing} onClick={() => void choose()}>Choose…</Button>}
            {state.path === null ? null : <Button size="compact" variant="ghost" onClick={onReveal}>Show in Finder</Button>}
          </div>
        </>
      )}
      {state.pending === null ? null : (
        <span className="text-label text-text">
          Moves to <code className="break-all font-mono">{state.pending}</code> the next time Manor starts.{' '}
          <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-label text-muted underline" onClick={() => onChoose(state.path)}>
            Keep the current folder
          </button>
        </span>
      )}
    </div>
  )
}

/** Who writes the daily log right now: the first provider that can take the job, in the server's order. */
export function dailyLogWriter(connections: readonly ProviderConnection[]): ProviderConnection | null | undefined {
  if (connections.length === 0) return undefined
  return connections.find((connection) => connection.state === 'ready' || connection.state === 'attention') ?? null
}

export function MemoryPage({ info, settings, connections, onRequest, onCheck, onSave, onReveal }: {
  info: SystemInfo | null
  /** Null until the server has sent them; a folder is not moved on a guess at the rest. */
  settings: HouseSettings | null
  connections: readonly ProviderConnection[]
  onRequest: () => void
  onCheck: () => void
  onSave: (settings: HouseSettings) => void
  onReveal: (folder: 'memory' | 'knowledge') => void
}) {
  useSystemInfo(onRequest)
  useEffect(() => { onCheck() }, [onCheck])
  const move = (key: FolderKey) => (path: string | null) => {
    if (settings === null) return
    onSave({ ...settings, [key]: path })
    // The server answers what the next start will use; ask again once it has the setting.
    onRequest()
  }
  const writer = dailyLogWriter(connections)
  return (
    <SettingsPage title="Memory & knowledge" description="Plain markdown folders on this Mac. Manor reads and writes them, and so can you.">
      {info === null || settings === null ? <Reading /> : (
        <>
          <SettingsGroup title="Folders">
            <FolderRow
              label="Memory folder"
              description="The daily log, long-term memory, agent notes and the context files."
              variable="MANOR_MEMORY_DIR"
              state={info.memory}
              onChoose={move('memoryDir')}
              onReveal={() => onReveal('memory')}
            />
            <FolderRow
              label="Knowledge folder"
              description="Your notes, behind the Knowledge door. An Obsidian vault works as it is."
              variable="MANOR_VAULT_DIR"
              state={info.vault}
              onChoose={move('knowledgeDir')}
              onReveal={() => onReveal('knowledge')}
            />
          </SettingsGroup>
          <SettingsGroup title="Knowledge">
            <SettingsRow label="Note AI model" description="Used for comments and the note composer. Runs without tools.">
              <SideRuntimeMenu
                model={settings.noteAiModel}
                effort={settings.noteAiEffort}
                disabled={false}
                defaults={NOTE_AI_DEFAULTS}
                title="Provider, model and reasoning for the note AI"
                onChange={(noteAiModel, noteAiEffort) => onSave({ ...settings, noteAiModel, noteAiEffort })}
              />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title="Daily log">
            <SettingsRow
              label="Written after each turn"
              description="Manor adds a line when a turn decided or learned something, and distills finished days into long-term memory. Both run on a signed-in provider."
            >
              {writer === undefined ? null : writer === null ? (
                <span className="text-label text-text">No provider is signed in, so nothing is written. Sign in under Providers.</span>
              ) : (
                <span className="text-label text-muted">Runs on {PROVIDER_NAME[writer.provider]}</span>
              )}
            </SettingsRow>
          </SettingsGroup>
        </>
      )}
    </SettingsPage>
  )
}

export function AboutPage({ info, notice, onRequest, onRevealLog, onDismissNotice }: {
  info: SystemInfo | null
  notice: Notice | null
  onRequest: () => void
  onRevealLog: (path: string) => boolean
  onDismissNotice: () => void
}) {
  useSystemInfo(onRequest)
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)

  const copy = async () => {
    if (info === null) return
    const text = JSON.stringify({ ...info, client: navigator.userAgent }, null, 2)
    try {
      await navigator.clipboard.writeText(text)
      setCopied('yes')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <SettingsPage title="About">
      {info === null ? <Reading /> : (
        <>
          <SettingsGroup title="Manor">
            <SettingsRow label="Version">
              <span className="text-label text-muted tabular-nums">
                {info.version}{info.commit === null ? '' : `, ${info.commit}`}
              </span>
            </SettingsRow>
            <SettingsRow label="Server running since">
              <span className="text-label text-muted tabular-nums">
                {new Date(info.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title="Logs">
            {info.logs.length === 0 ? (
              <SettingsRow label="No log files" description="The server writes none where Manor knows to look." />
            ) : info.logs.map((log) => (
              <SettingsRow key={log.path} label={log.label} description={<Path value={log.path} />}>
                <Button size="compact" variant="secondary" onClick={() => onRevealLog(log.path)}>Show in Finder</Button>
              </SettingsRow>
            ))}
          </SettingsGroup>
          <SettingsGroup title="Diagnostics">
            <SettingsRow
              label="Copy diagnostics"
              description={copied === 'yes' ? 'Copied. Version, provider CLIs, paths and this client.' : copied === 'failed' ? 'The clipboard refused it.' : 'Version, provider CLIs, paths and this client, as text.'}
            >
              <Button size="compact" variant="secondary" onClick={() => void copy()}>Copy</Button>
            </SettingsRow>
          </SettingsGroup>
        </>
      )}
      {notice === null ? null : <RequestNotice notice={notice} onDismiss={onDismissNotice} />}
    </SettingsPage>
  )
}
