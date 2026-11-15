import { useCallback, useEffect, useState } from 'react'
import { Cancel01Icon, Delete02Icon, Key01Icon, Settings01Icon, UserIcon } from '@hugeicons/core-free-icons'
import type { BrowserPasswordOfferChoice, BrowserSavedPasswords as BrowserSavedPasswordList, BrowserTabPasswords, DesktopBrowserBridge } from '@manor/contracts'
import { Icon } from './Icon'
import { ConfirmStrip } from './Confirm'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Menu, MenuItem, useMenu } from './ui/Menu'

/**
 * The key beside the address. It exists only while the page's site has saved logins;
 * picking one fills the page, which is the only way a password ever reaches it.
 */
export function BrowserPasswordsMenu({ logins, disabled, onFill, onManage }: {
  logins: BrowserTabPasswords['logins']
  disabled: boolean
  onFill(loginId: string): void
  onManage(): void
}) {
  const [menu, trigger] = useMenu({ maxHeight: 320, minHeight: 120, minWidth: 240, disabled })

  return <>
    <IconButton ref={trigger} icon={Key01Icon} iconSize={14} size={24} label="Saved passwords"
      aria-haspopup="menu" aria-expanded={menu.open} disabled={disabled}
      onClick={menu.toggle} />
    <Menu menu={menu} label="Saved passwords">
      <p className="m-0 px-3 py-2 text-label font-medium text-text">Fill a saved password</p>
      {logins.map((login) => (
        <MenuItem key={login.id} icon={UserIcon} onClick={() => { menu.close(); onFill(login.id) }}>
          {login.username === '' ? <span className="text-muted">No username</span> : login.username}
        </MenuItem>
      ))}
      <div className="mx-2 my-1 h-px bg-line" />
      <MenuItem icon={Settings01Icon} onClick={() => { menu.close(false); onManage() }}>Manage passwords</MenuItem>
    </Menu>
  </>
}

/**
 * Asks once after a sign-in, under the address it was made on. It never takes focus
 * from the page the user is still working in; Escape inside it means not now.
 */
export function BrowserPasswordOffer({ offer, busy, onAnswer }: {
  offer: NonNullable<BrowserTabPasswords['offer']>
  busy: boolean
  onAnswer(choice: BrowserPasswordOfferChoice): void
}) {
  const update = offer.kind === 'update'
  const question = `${update ? 'Update' : 'Save'} password for ${hostOf(offer.origin)}?`
  return (
    <div role="group" aria-label={question}
      className="flex min-w-0 items-center gap-2 border-t border-line py-1.5 pr-2 pl-4"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onAnswer('dismiss')
      }}>
      <Icon icon={Key01Icon} size={14} className="flex-none text-muted" />
      <span aria-live="polite" className="flex min-w-0 flex-1 items-baseline gap-2">
        <span title={question} className="min-w-0 truncate text-label text-text">{question}</span>
        {offer.username === '' ? null : (
          // Gives way first in a narrow panel, before the question does.
          <span title={offer.username} className="min-w-0 shrink-[100] truncate text-meta text-muted">{offer.username}</span>
        )}
      </span>
      <Button size="compact" variant="primary" className="flex-none" disabled={busy} onClick={() => onAnswer('save')}>
        {update ? 'Update' : 'Save'}
      </Button>
      {update ? null : (
        <Button size="compact" variant="ghost" className="flex-none" disabled={busy} onClick={() => onAnswer('never')}>Never</Button>
      )}
      <IconButton icon={Cancel01Icon} iconSize={14} size={24} label="Not now" disabled={busy}
        onClick={() => onAnswer('dismiss')} />
    </div>
  )
}

/**
 * The way out: every saved login and every Never site, with remove and remove all.
 * Removing an imported entry drops Manor's local copy only; the source browser is read-only.
 */
export function BrowserSavedPasswords({ bridge }: { bridge: DesktopBrowserBridge }) {
  const [saved, setSaved] = useState<BrowserSavedPasswordList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)

  const load = useCallback(() => {
    if (bridge.savedPasswords === undefined) return
    setError(null)
    setSaved(null)
    void bridge.savedPasswords().then(setSaved, (reason: unknown) => setError(messageOf(reason)))
  }, [bridge])
  useEffect(load, [load])

  if (bridge.savedPasswords === undefined || bridge.removeSavedPasswords === undefined) return null
  const remove = (target?: Parameters<NonNullable<DesktopBrowserBridge['removeSavedPasswords']>>[0]) => {
    if (bridge.removeSavedPasswords === undefined) return
    setBusy(true)
    setError(null)
    void bridge.removeSavedPasswords(target).then(setSaved, (reason: unknown) => setError(messageOf(reason)))
      .finally(() => { setBusy(false); setClearArmed(false) })
  }
  const entries = saved === null ? [] : [...saved.logins, ...saved.neverSave]
  const fromDia = entries.some((entry) => entry.source === 'dia')

  return (
    <section aria-label="Saved passwords" className="mt-3 border-t border-line pt-3">
      <div className="flex min-h-6 items-center justify-between gap-4">
        <span className="text-[13px] font-medium text-text">Saved passwords</span>
        {entries.length === 0 || clearArmed ? null : (
          <Button size="compact" variant="ghost" disabled={busy} onClick={() => setClearArmed(true)}>Remove all</Button>
        )}
      </div>
      {!clearArmed ? null : (
        <ConfirmStrip question="Remove every saved password and never-save site?" confirmLabel={busy ? 'Removing…' : 'Remove all'}
          onConfirm={() => remove()} onCancel={() => setClearArmed(false)} />
      )}
      {error === null ? null : (
        <p role="alert" className="mt-1 mb-0 text-[12px] leading-relaxed text-danger">
          {error}{' '}
          <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-text underline-offset-2 hover:underline"
            onClick={load}>Try again</button>
        </p>
      )}
      {saved === null ? (
        error === null ? <p role="status" className="mt-1 mb-0 text-[12px] text-dim">Loading saved passwords…</p> : null
      ) : entries.length === 0 ? (
        <p className="mt-1 mb-0 text-[12px] leading-relaxed text-dim">
          None yet. After you sign in to a site, Manor offers to save the password here.
        </p>
      ) : (
        <ul className="m-0 mt-1 max-h-[240px] list-none overflow-y-auto p-0">
          {saved.logins.map((login) => (
            <SavedRow key={login.id} title={hostOf(login.origin)}
              detail={`${login.username === '' ? 'No username' : login.username}${login.source === 'dia' ? ', from Dia' : ''}`}
              removeLabel={`Remove saved password for ${login.username === '' ? hostOf(login.origin) : `${login.username} on ${hostOf(login.origin)}`}`}
              busy={busy} onRemove={() => remove({ loginId: login.id })} />
          ))}
          {saved.neverSave.map((site) => (
            <SavedRow key={`never:${site.origin}`} title={hostOf(site.origin)}
              detail={`Never saved${site.source === 'dia' ? ', from Dia' : ''}`}
              removeLabel={`Offer to save passwords on ${hostOf(site.origin)} again`}
              busy={busy} onRemove={() => remove({ neverSaveOrigin: site.origin })} />
          ))}
        </ul>
      )}
      {!fromDia ? null : (
        <p className="mt-1 mb-0 text-[12px] leading-relaxed text-dim">Removed entries that came from your other browser come back at the next launch while its logins are in use.</p>
      )}
    </section>
  )
}

function SavedRow({ title, detail, removeLabel, busy, onRemove }: {
  title: string
  detail: string
  removeLabel: string
  busy: boolean
  onRemove(): void
}) {
  return (
    <li className="flex min-h-8 min-w-0 items-center gap-2 py-1">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-label text-text">{title}</span>
        <span className="block truncate text-meta text-muted">{detail}</span>
      </span>
      <IconButton icon={Delete02Icon} iconSize={14} size={24} disabled={busy} label={removeLabel} onClick={onRemove} />
    </li>
  )
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
