import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Cancel01Icon, PlugSocketIcon, PlusSignIcon, Search01Icon } from '@hugeicons/core-free-icons'
import type {
  AgentConfig,
  ComposioAlias,
  McpHostStatus,
  McpServerConfig,
  McpServerDraft,
  MyMindConnectionStatus,
} from '@manor/contracts'
import type { Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { appLabel } from '../ConnectCards'
import { Icon } from '../Icon'
import { McpServerDialog } from '../agents/McpServerDialog'
import { useMcpDialog } from '../agents/useMcpDialog'
import { Modal, ModalFooter } from '../Modal'
import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import { ComposioAppRow, ComposioConnectedRow, DisconnectDialog } from './ComposioApps'
import { ComposioKeyNote, ComposioKeySetup, RemoveComposioKeyDialog } from './ComposioKey'
import {
  ALL_CATEGORIES,
  type ComposioBinding,
  CONNECT_GROUPS,
  accountStateFor,
  appMatches,
  categoryOptions,
} from './composioCatalogue'

/** Rows drawn before "Show more"; the rest wait so a first open stays instant. */
const CATALOGUE_PAGE = 120

interface ConnectorsViewProps {
  agents: AgentConfig[]
  registry: McpServerConfig[]
  hostStatuses: McpHostStatus[]
  mymind: MyMindConnectionStatus | null
  notice: Notice | null
  requestEvents: RequestEvents
  onSave: (server: McpServerDraft, requestId: string) => boolean
  onVerify: (serverId: string, requestId: string) => boolean
  onVerifyMyMind: () => boolean
  onDelete: (serverId: string, requestId: string) => boolean
  onDismissNotice: () => void
  onDialogChange: (open: boolean) => void
  /** The socket is live; the page asks for the catalogue again whenever it comes back. */
  live: boolean
  composio: ComposioBinding
}

/** Household-wide integrations, including Manor-managed connections such as mymind. */
export function ConnectorsView({
  agents,
  registry,
  hostStatuses,
  mymind,
  notice,
  requestEvents,
  onSave,
  onVerify,
  onVerifyMyMind,
  onDelete,
  onDismissNotice,
  onDialogChange,
  live,
  composio,
}: ConnectorsViewProps) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const [limit, setLimit] = useState(CATALOGUE_PAGE)
  const [pageError, setPageError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<{ slug: string; name: string; alias: ComposioAlias | null } | null>(null)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)
  const connectRequest = useRequest(requestEvents)
  const disconnectRequest = useRequest(requestEvents)
  const keyRequest = useRequest(requestEvents)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [removingKey, setRemovingKey] = useState(false)
  const { list, key: keySource } = composio
  const noKey = keySource === 'none'
  const [mymindOpen, setMyMindOpen] = useState(false)
  const [mymindPending, setMyMindPending] = useState(false)
  const dialog = useMcpDialog({
    requestEvents,
    onSave,
    onVerify,
    onDelete,
    onDismissNotice,
    onDialogChange,
  })

  useEffect(() => {
    if (mymindPending && notice !== null) setMyMindPending(false)
  }, [mymindPending, notice])

  // A dropped socket loses the answer to any request in flight, so it would hold Connect
  // disabled for good; the refetch on the way back shows what really happened.
  const { cancel: cancelConnect } = connectRequest
  const { cancel: cancelDisconnect } = disconnectRequest
  const { cancel: cancelKey } = keyRequest
  // Also when a key arrives or goes: the catalogue the old key listed is gone.
  useEffect(() => {
    if (live) {
      if (keySource !== 'none') list()
      return
    }
    cancelConnect()
    cancelDisconnect()
    cancelKey()
  }, [live, list, keySource, cancelConnect, cancelDisconnect, cancelKey])

  useEffect(() => setLimit(CATALOGUE_PAGE), [deferredQuery, category])

  const apps = composio.catalog?.apps
  const bySlug = useMemo(() => new Map((apps ?? []).map((app) => [app.slug, app])), [apps])
  const categories = useMemo(() => categoryOptions(apps ?? []), [apps])
  const matching = useMemo(() => (apps ?? []).filter((app) =>
    (category === ALL_CATEGORIES || app.categories.includes(category)) && appMatches(app, deferredQuery)), [apps, category, deferredQuery])
  // Group order, then cut once, so "Show more" extends the list rather than every group.
  const shown = useMemo(() => {
    const ordered = CONNECT_GROUPS.flatMap((group) => matching.filter((app) => app.connect === group.kind))
    const visible = ordered.slice(0, limit)
    return CONNECT_GROUPS
      .map((group) => ({ ...group, apps: visible.filter((app) => app.connect === group.kind) }))
      .filter((group) => group.apps.length > 0)
  }, [matching, limit])

  const connected = composio.accounts?.connected ?? []
  const connects = composio.accounts?.connects ?? []
  const nameOf = (slug: string) => bySlug.get(slug)?.name ?? appLabel(slug)
  const ownRows = [...registry].sort(compareByName).filter((server) =>
    deferredQuery.length === 0 || `${server.name} ${server.description}`.toLowerCase().includes(deferredQuery))
  const showMyMind = deferredQuery.length === 0 || 'mymind artifacts'.includes(deferredQuery)
  const connectedApps = connected.filter((app) => {
    const entry = bySlug.get(app.toolkit)
    return entry === undefined ? `${app.toolkit} ${appLabel(app.toolkit)}`.toLowerCase().includes(deferredQuery) : appMatches(entry, deferredQuery)
  })
  const connectedCount = ownRows.length + (showMyMind ? 1 : 0) + connectedApps.length

  const connect = (toolkit: string, alias: ComposioAlias) => {
    setPageError(null)
    connectRequest.start((requestId) => composio.connect(toolkit, alias, requestId), {
      onNotice: (answer) => setPageError(answer.text),
    })
  }

  const saveKey = (value: string) => {
    setKeyError(null)
    keyRequest.start((requestId) => composio.setKey(value, requestId), {
      onNotice: (answer) => setKeyError(answer.text),
    })
  }

  const confirmRemoveKey = () => {
    setKeyError(null)
    keyRequest.start((requestId) => composio.removeKey(requestId), {
      onAck: () => setRemovingKey(false),
      onNotice: (answer) => setKeyError(answer.text),
    })
  }

  const confirmDisconnect = () => {
    if (disconnecting === null) return
    setDisconnectError(null)
    disconnectRequest.start((requestId) => composio.disconnect(disconnecting.slug, disconnecting.alias, requestId), {
      onAck: () => setDisconnecting(null),
      onNotice: (answer) => setDisconnectError(answer.text),
    })
  }

  useEffect(() => {
    if (!mymindOpen) return
    onDialogChange(true)
    return () => onDialogChange(false)
  }, [mymindOpen, onDialogChange])

  const openMyMind = () => {
    dialog.close()
    onDismissNotice()
    setMyMindPending(false)
    setMyMindOpen(true)
  }

  const closeMyMind = () => {
    onDismissNotice()
    setMyMindPending(false)
    setMyMindOpen(false)
  }

  const verifyMyMind = () => {
    onDismissNotice()
    if (onVerifyMyMind()) setMyMindPending(true)
  }

  return (
    <main className="h-full min-h-0 overflow-y-auto">
      <section className="mx-auto w-full max-w-page px-8 pt-10 pb-10 max-[720px]:px-5 max-[720px]:pt-7 max-[720px]:pb-7">
        <div className="flex items-end justify-between gap-6 max-[640px]:flex-col max-[640px]:items-stretch max-[640px]:gap-4">
          <div>
            <h1 className="m-0 font-display text-[24px] leading-tight font-semibold tracking-[-0.02em]">Connectors</h1>
            <p className="mt-1 mb-0 max-w-[560px] text-[16px] leading-relaxed text-muted">
              Manage the external tools available to Manor and its agents.
            </p>
          </div>
          <Button variant="primary" className="inline-flex flex-none items-center gap-2 max-[640px]:self-start" onClick={dialog.openNew}>
            <Icon icon={PlusSignIcon} size={14} />
            Add server
          </Button>
        </div>

        {noKey ? <ComposioKeySetup live={live} pending={keyRequest.pending} error={keyError} onSave={saveKey} /> : null}

        <div className="mt-7 flex h-9 w-full max-w-[560px] items-center gap-2 rounded-lg border border-line bg-stage px-2.5 text-muted focus-within:border-dim">
          <Icon icon={Search01Icon} size={17} className="flex-none" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search connectors and apps"
            aria-label="Search connectors and apps"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-label text-text outline-none placeholder:text-dim"
          />
          {query.length === 0 ? null : (
            <button
              type="button"
              aria-label="Clear connector search"
              className="grid size-6 flex-none cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-muted hover:bg-surface-2 hover:text-text"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => setQuery('')}
            >
              <Icon icon={Cancel01Icon} size={14} />
            </button>
          )}
        </div>
        {pageError === null ? null : (
          <p className="mt-3 mb-0 text-label text-danger" role="status">{pageError}</p>
        )}

        <SectionHeading title="Connected" count={connectedCount} />
        {connectedCount > 0 ? null : <p className="m-0 px-2 text-label text-muted">Nothing connected matches that search.</p>}
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 max-[760px]:grid-cols-1">
          {showMyMind ? <MyMindConnectorRow status={mymind} onOpen={openMyMind} /> : null}
          {ownRows.map((server) => (
            <ConnectorRow
              key={server.id}
              server={noKey && server.name === COMPOSIO_SERVER_NAME ? waitingForKey(server) : server}
              onOpen={() => dialog.openServer(server)}
            />
          ))}
          {connectedApps.map((app) => (
            <ComposioConnectedRow
              key={app.toolkit}
              slug={app.toolkit}
              name={nameOf(app.toolkit)}
              aliases={app.aliases}
              onDisconnect={(alias) => {
                setDisconnectError(null)
                setDisconnecting({ slug: app.toolkit, name: nameOf(app.toolkit), alias })
              }}
            />
          ))}
        </div>
        {noKey || composio.accounts?.unavailable === undefined ? null : (
          <p className="mt-2 mb-0 px-2 text-label text-muted">Composio accounts: {composio.accounts.unavailable}</p>
        )}

        <SectionHeading
          title="Apps"
          count={noKey || apps === undefined ? undefined : matching.length}
          accessory={noKey || apps === undefined || apps.length === 0 ? undefined : (
            <div className="w-[220px] flex-none">
              <Select label="App category" value={category} options={categories} onChange={setCategory} />
            </div>
          )}
        />
        {noKey ? (
          <p className="m-0 px-2 text-label text-dim">The app catalogue appears here once the key is saved.</p>
        ) : composio.catalog === null ? (
          <p className="m-0 px-2 text-label text-muted" role="status">Loading the Composio catalogue…</p>
        ) : composio.catalog.unavailable !== undefined ? (
          <p className="m-0 px-2 text-label text-muted" role="status">{composio.catalog.unavailable}</p>
        ) : shown.length === 0 ? (
          <p className="m-0 px-2 text-label text-muted">No app matches that search.</p>
        ) : (
          <div className="flex flex-col gap-6">
            {shown.map((group) => (
              <section key={group.kind} aria-label={group.label} className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2 px-2">
                  <h3 className="m-0 text-label font-medium text-muted">{group.label}</h3>
                  {group.hint === undefined ? null : <span className="min-w-0 truncate text-meta text-dim">{group.hint}</span>}
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-1 max-[760px]:grid-cols-1">
                  {group.apps.map((app) => (
                    <ComposioAppRow
                      key={app.slug}
                      app={app}
                      state={accountStateFor(app.slug, connected, connects)}
                      canConnect={live && !connectRequest.pending}
                      onConnect={(alias) => connect(app.slug, alias)}
                    />
                  ))}
                </div>
              </section>
            ))}
            {matching.length <= limit ? null : (
              <div className="flex justify-center">
                <Button variant="ghost" size="compact" onClick={() => setLimit((current) => current + CATALOGUE_PAGE * 2)}>
                  Show more ({matching.length - limit} left)
                </Button>
              </div>
            )}
          </div>
        )}
        {keySource === null || keySource === 'none' ? null : (
          <ComposioKeyNote
            source={keySource}
            notice={removingKey ? null : keyError}
            onRemove={() => {
              setKeyError(null)
              setRemovingKey(true)
            }}
          />
        )}
      </section>

      {!removingKey ? null : (
        <RemoveComposioKeyDialog
          pending={keyRequest.pending}
          error={keyError}
          onConfirm={confirmRemoveKey}
          onClose={() => {
            keyRequest.cancel()
            setRemovingKey(false)
          }}
        />
      )}

      {disconnecting === null ? null : (
        <DisconnectDialog
          name={disconnecting.name}
          slug={disconnecting.slug}
          alias={disconnecting.alias}
          pending={disconnectRequest.pending}
          error={disconnectError}
          onConfirm={confirmDisconnect}
          onClose={() => {
            disconnectRequest.cancel()
            setDisconnecting(null)
          }}
        />
      )}

      {dialog.editing === null ? null : (
        <McpServerDialog
          key={dialog.editing.id ?? 'new'}
          initial={dialog.editing}
          saved={registry.find((server) => server.id === dialog.editing?.id)}
          holders={agents
            .filter((agent) => agent.mcpServers.some((attachment) => attachment.serverId === dialog.editing?.id))
            .map((agent) => agent.name)}
          hostStatus={hostStatuses.find((status) => status.serverId === dialog.editing?.id)}
          notice={notice}
          pending={dialog.pending}
          onSave={dialog.save}
          onVerify={dialog.verify}
          onDelete={dialog.remove}
          onDismissNotice={onDismissNotice}
          onClose={dialog.close}
        />
      )}

      {!mymindOpen ? null : (
        <MyMindConnectorDialog
          status={mymind}
          notice={notice}
          pending={mymindPending}
          onVerify={verifyMyMind}
          onClose={closeMyMind}
        />
      )}
    </main>
  )
}

function SectionHeading({ title, count, accessory }: { title: string; count?: number | undefined; accessory?: ReactNode | undefined }) {
  return (
    <div className="mt-9 mb-3 flex min-h-8 items-center justify-between gap-4 px-2">
      <h2 className="m-0 flex items-baseline gap-2 text-[16px] font-medium text-text">
        {title}
        {count === undefined ? null : <span className="text-label text-dim">{count}</span>}
      </h2>
      {accessory}
    </div>
  )
}

function MyMindConnectorRow({ status, onOpen }: { status: MyMindConnectionStatus | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label="Open mymind"
      className="flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border-0 bg-transparent px-2 py-2 text-left outline-none duration-150 ease-fade hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary motion-safe:transition-colors"
      onClick={onOpen}
    >
      <span className="grid size-10 flex-none place-items-center rounded-lg bg-surface text-muted">
        <Icon icon={PlugSocketIcon} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[16px] font-semibold text-text">mymind</span>
          <span className="flex-none text-[12px] text-dim">{myMindStatusLabel(status)}</span>
        </span>
        <span className="truncate text-label text-muted">Artifacts and visual inspiration for agents</span>
      </span>
    </button>
  )
}

function MyMindConnectorDialog({
  status,
  notice,
  pending,
  onVerify,
  onClose,
}: {
  status: MyMindConnectionStatus | null
  notice: Notice | null
  pending: boolean
  onVerify: () => void
  onClose: () => void
}) {
  return (
    <Modal title="mymind" onClose={onClose}>
      <p className="m-0 text-[13px] leading-relaxed text-muted">
        A Manor-managed, read-only connection. It powers the Artifacts library and gives every agent
        artifact_search and artifact_view after an explicit request.
      </p>

      <section className="rounded-xl border border-line bg-surface-2 px-3.5 py-3">
        <p className="m-0 text-[13px] font-medium text-text">2 read-only tools · available to all agents</p>
        <p className="mt-1 mb-0 text-label text-muted">Not attached per persona and never searched automatically.</p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-[13px] font-medium text-text">Environment keys</h3>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {(status?.env ?? MYMIND_ENV_KEYS.map((key) => ({ key, present: false }))).map((entry) => (
            <li key={entry.key} className="flex items-center justify-between gap-4 rounded-lg border border-line px-3 py-2">
              <span className="min-w-0 truncate font-mono text-[12px] text-text">{entry.key}</span>
              <span className={`flex-none text-[12px] ${entry.present ? 'text-text' : 'text-dim'}`}>
                {entry.present ? 'found on this machine' : 'not set'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {status?.problem === null || status?.problem === undefined ? null : (
        <p className="m-0 text-label text-danger" role="status">{status.problem}</p>
      )}

      <div className="flex items-center gap-3 rounded-xl border border-line px-3.5 py-2.5">
        <Button disabled={pending || status?.available !== true} onClick={onVerify}>
          {pending ? 'Testing…' : 'Test connection'}
        </Button>
        <span className="min-w-0 text-[12px] text-muted">{myMindCheckLabel(status)}</span>
      </div>

      {notice === null ? null : (
        <p className={`m-0 text-label ${notice.kind === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
          {notice.text}
        </p>
      )}

      <ModalFooter>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </ModalFooter>
    </Modal>
  )
}

function ConnectorRow({ server, onOpen }: { server: McpServerConfig; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Open ${server.name}`}
      className="flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border-0 bg-transparent px-2 py-2 text-left outline-none duration-150 ease-fade hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary motion-safe:transition-colors"
      onClick={onOpen}
    >
      <span className="grid size-10 flex-none place-items-center rounded-lg bg-surface text-muted">
        <Icon icon={PlugSocketIcon} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[16px] font-semibold text-text">{server.name}</span>
          {server.unavailable === undefined ? null : (
            <span className="flex-none text-[12px] text-danger">Unavailable</span>
          )}
        </span>
        <span className="truncate text-label text-muted">
          {server.unavailable ?? (server.description || 'No description yet')}
        </span>
      </span>
    </button>
  )
}

/** The registry row Manor keeps for Composio's own MCP server, named by the server. */
const COMPOSIO_SERVER_NAME = 'composio'

/** Without a key the Composio row is not broken, it is waiting; the setup card says why. */
const waitingForKey = ({ unavailable: _unavailable, ...server }: McpServerConfig): McpServerConfig => ({
  ...server,
  description: 'Starts once the Composio key is saved',
})

const MYMIND_ENV_KEYS = ['MANOR_MYMIND_KEY_ID', 'MANOR_MYMIND_SECRET'] as const

function myMindStatusLabel(status: MyMindConnectionStatus | null): string {
  if (status === null) return 'Checking…'
  if (status.check?.result === 'failed') return 'Unavailable'
  if (status.check?.result === 'verified') return 'Connected'
  return status.available ? 'Configured' : 'Not configured'
}

function myMindCheckLabel(status: MyMindConnectionStatus | null): string {
  if (status === null) return 'Waiting for this Manor server.'
  const check = status.check
  if (check === null) return status.available ? 'Configured, not tested since startup.' : 'Set both keys and restart Manor.'
  const when = new Date(check.checkedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  return check.result === 'verified' ? `Last verified ${when}.` : `Last test failed ${when}.`
}

const compareByName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
