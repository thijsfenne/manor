import { useState, type MouseEvent } from 'react'
import { ArrowDown01Icon, Plug01Icon } from '@hugeicons/core-free-icons'
import { COMPOSIO_ALIASES, composioLogoUrl, type ComposioAlias, type ComposioApp } from '@manor/contracts'
import { ConnectStatusMark } from '../ConnectCards'
import { Icon } from '../Icon'
import { Modal, ModalFooter } from '../Modal'
import { Button } from '../ui/Button'
import { ContextMenu } from '../ui/ContextMenu'
import { aliasLabel, openAliases, type AppAccountState } from './composioCatalogue'

const ROW = 'flex min-w-0 items-center gap-3 rounded-xl px-2 py-2'

/**
 * The app's own brand mark, from Composio's logo host. Lazy, so a catalogue of
 * hundreds loads only the marks on screen; a mark that fails falls back to its initial.
 */
export function AppLogo({ slug, name, size = 'row' }: { slug: string; name: string; size?: 'row' | 'title' }) {
  const [failed, setFailed] = useState(false)
  const tile = size === 'row' ? 'size-10 rounded-lg' : 'size-12 rounded-xl'
  return (
    <span className={`grid ${tile} flex-none place-items-center overflow-hidden bg-surface`}>
      {failed ? (
        <span className="text-[16px] text-muted">{name.charAt(0).toUpperCase()}</span>
      ) : (
        <img
          src={composioLogoUrl(slug)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={size === 'row' ? 'size-[22px] object-contain' : 'size-[26px] object-contain'}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  )
}

/** A connected Composio app: its mark, its aliases, and the way out. */
export function ComposioConnectedRow({ slug, name, aliases, onDisconnect }: {
  slug: string
  name: string
  aliases: readonly string[]
  onDisconnect: (alias: ComposioAlias | null) => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const known = aliases.filter((alias): alias is ComposioAlias => (COMPOSIO_ALIASES as readonly string[]).includes(alias))
  const disconnect = (event: MouseEvent<HTMLButtonElement>) => {
    if (known.length <= 1) {
      onDisconnect(known[0] ?? null)
      return
    }
    const box = event.currentTarget.getBoundingClientRect()
    setMenu({ x: box.left, y: box.bottom + 4 })
  }
  return (
    <div className={ROW} data-composio-connected={slug}>
      <AppLogo slug={slug} name={name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[16px] font-medium text-text">{name}</span>
        <span className="truncate text-label text-muted">
          {aliases.length === 0 ? 'Composio · no alias' : `Composio · ${aliases.map(aliasLabel).join(', ')}`}
        </span>
      </span>
      <Button variant="ghost" size="compact" className="inline-flex flex-none items-center gap-1" onClick={disconnect} aria-label={`Disconnect ${name}`}>
        Disconnect
        {known.length > 1 ? <Icon icon={ArrowDown01Icon} size={12} /> : null}
      </Button>
      {menu === null ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={known.map((alias) => ({ label: aliasLabel(alias), tone: 'danger' as const, onSelect: () => onDisconnect(alias) }))}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** One catalogue app with what can happen to it right now. */
export function ComposioAppRow({ app, state, canConnect, onConnect }: {
  app: ComposioApp
  state: AppAccountState
  /** False while the socket is down or another connect is being started. */
  canConnect: boolean
  onConnect: (alias: ComposioAlias) => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const open = openAliases(state.aliases, COMPOSIO_ALIASES)
  const waiting = state.connect?.status === 'waiting'
  const connectedLine = state.aliases.length === 0 ? undefined : `Connected · ${state.aliases.map(aliasLabel).join(', ')}`
  const detail = state.connect?.status === 'failed' ? state.connect.reason ?? 'The sign-in did not finish.' : undefined

  const chooseAlias = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    setMenu({ x: box.left, y: box.bottom + 4 })
  }

  return (
    // Off-screen rows skip layout and paint, so a catalogue of hundreds scrolls like a short list.
    <div className={`${ROW} [contain-intrinsic-size:auto_56px] [content-visibility:auto]`} data-composio-app={app.slug}>
      <AppLogo slug={app.slug} name={app.name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[16px] font-medium text-text">{app.name}</span>
          {connectedLine === undefined ? null : <span className="flex-none text-meta text-ok">{connectedLine}</span>}
        </span>
        <span className={`truncate text-label ${detail === undefined ? 'text-muted' : 'text-danger'}`} title={detail ?? app.description}>
          {detail ?? (app.description || 'No description from Composio.')}
        </span>
      </span>
      {waiting ? (
        <ConnectStatusMark status="waiting" />
      ) : app.connect === 'no_auth' ? (
        <span className="flex-none px-1.5 text-meta text-dim">No sign-in</span>
      ) : app.connect === 'own_credentials' ? (
        <span className="flex-none px-1.5 text-meta text-dim">Own credentials</span>
      ) : open.length === 0 ? (
        <ConnectStatusMark status="connected" />
      ) : (
        <>
          {state.connect?.status === 'failed' ? <ConnectStatusMark status="failed" /> : null}
          <Button
            variant="secondary"
            size="compact"
            className="inline-flex flex-none items-center gap-1"
            disabled={!canConnect}
            aria-label={`Connect ${app.name}`}
            aria-haspopup="menu"
            onClick={chooseAlias}
          >
            <Icon icon={Plug01Icon} size={13} />
            {state.connect?.status === 'failed' ? 'Retry' : state.aliases.length === 0 ? 'Connect' : `Add ${aliasLabel(open[0]!)}`}
          </Button>
        </>
      )}
      {menu === null ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={COMPOSIO_ALIASES.map((alias) => ({
            label: `${aliasLabel(alias)} account`,
            disabled: !open.includes(alias),
            ...(open.includes(alias) ? {} : { checked: true }),
            onSelect: () => onConnect(alias),
          }))}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** Disconnecting is for every agent at once, so it is asked once before it happens. */
export function DisconnectDialog({ name, slug, alias, pending, error, onConfirm, onClose }: {
  name: string
  slug: string
  alias: ComposioAlias | null
  pending: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  const account = alias === null ? 'its unaliased account' : `the ${alias} account`
  return (
    <Modal title={`Disconnect ${name}?`} onClose={onClose}>
      <div className="flex items-center gap-3">
        <AppLogo slug={slug} name={name} size="title" />
        <p className="m-0 text-[14px] leading-relaxed text-muted">
          Every agent loses access to {name} through {account}. Composio deletes the connection; you can connect it again from this page.
        </p>
      </div>
      {error === null ? null : <p className="m-0 text-label text-danger" role="status">{error}</p>}
      <ModalFooter>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={pending} onClick={onConfirm}>{pending ? 'Disconnecting…' : 'Disconnect'}</Button>
        </div>
      </ModalFooter>
    </Modal>
  )
}
