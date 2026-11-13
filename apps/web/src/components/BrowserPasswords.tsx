import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Cancel01Icon, Delete02Icon, Key01Icon } from '@hugeicons/core-free-icons'
import type { BrowserPasswordOfferChoice, BrowserSavedPasswords as BrowserSavedPasswordList, BrowserTabPasswords, DesktopBrowserBridge } from '@manor/contracts'
import { Icon } from './Icon'
import { ConfirmStrip } from './Confirm'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'
import { usePopupPlacement } from './ui/usePopupPlacement'

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
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus() }
  const placement = usePopupPlacement({ open, triggerRef: trigger, maxHeight: 320, minHeight: 120, minWidth: 240, align: 'end' })
  useDismiss(open, () => close(false), { within: [trigger, popup], onEscape: close, layoutMoved: true })
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (open && placement) popup.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [open, placement])

  return <>
    <IconButton ref={trigger} icon={Key01Icon} iconSize={14} size={24} label="Saved passwords"
      aria-haspopup="menu" aria-expanded={open} disabled={disabled}
      onClick={() => setOpen((value) => !value)} />
    {typeof document === 'undefined' ? null : createPortal(
      <Popover open={open} ref={popup} origin="top-right"
        className="fixed z-40 overflow-y-auto rounded-panel border border-line surface-floating p-1 shadow-menu"
        style={placement ?? { visibility: 'hidden' }} role="menu" aria-label="Saved passwords">
        <div onKeyDown={(event) => moveMenuFocus(event, popup.current)}>
          <p className="m-0 px-3 py-2 text-label font-medium text-text">Fill a saved password</p>
          {logins.map((login) => (
            <button key={login.id} type="button" role="menuitem"
              className="flex w-full min-w-0 rounded-button-sm border-0 bg-transparent px-3 py-2 text-left hover:bg-user-bg focus-visible:bg-user-bg"
              onClick={() => { close(); onFill(login.id) }}>
              <span className={`w-full truncate text-label ${login.username === '' ? 'text-muted' : 'text-text'}`}>
                {login.username === '' ? 'No username' : login.username}
              </span>
            </button>
          ))}
          <div className="mx-2 my-1 h-px bg-line" />
          <button type="button" role="menuitem"
            className="flex w-full rounded-button-sm border-0 bg-transparent px-3 py-2 text-left text-label text-muted hover:bg-user-bg hover:text-text focus-visible:bg-user-bg"
            onClick={() => { close(false); onManage() }}>
            Manage passwords
          </button>
        </div>
      </Popover>, document.body)}
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
              detail={`${login.username === '' ? 'No username' : login.username}${login.source === 'dia' ? ' · from Dia' : ''}`}
              removeLabel={`Remove saved password for ${login.username === '' ? hostOf(login.origin) : `${login.username} on ${hostOf(login.origin)}`}`}
              busy={busy} onRemove={() => remove({ loginId: login.id })} />
          ))}
          {saved.neverSave.map((site) => (
            <SavedRow key={`never:${site.origin}`} title={hostOf(site.origin)}
              detail={`Never saved${site.source === 'dia' ? ' · from Dia' : ''}`}
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

function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>, menu: HTMLDivElement | null): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = Array.from(menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (buttons.length === 0) return
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  event.preventDefault()
  buttons[next]?.focus()
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
