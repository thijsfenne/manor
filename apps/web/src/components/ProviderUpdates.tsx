import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InstallingUpdates01Icon,
  LoaderCircleIcon,
} from '@hugeicons/core-free-icons'
import type { ProviderUpdate } from '@manor/contracts'
import { TOAST_VISIBLE_MS } from '../motion'
import { PROVIDERS } from '../runtimes'
import { Icon } from './Icon'
import { ProviderMark } from './ProviderMark'
import { Button } from './ui/Button'
import { Fold } from './ui/Fold'
import { Popover } from './ui/Popover'
import type { HouseNotice } from './NoticeStack'
import { NOTICE_WIDTH, NoticeCard, ProgressMark, ToastDismiss } from './ui/NoticeCard'
import { useDismiss } from './ui/useDismiss'

type Provider = ProviderUpdate['provider']
/** No provider means every one that can update. */
export type UpdateProviders = (provider?: Provider) => void

/**
 * What the top of the stage says about provider CLIs. The two cards wait for an
 * answer; the pill only reports, and turns from spinner to check in place when the
 * run it was reporting on ends.
 */
type UpdateToast =
  | { kind: 'available'; entries: ProviderUpdate[] }
  | { kind: 'failed'; entries: ProviderUpdate[] }
  | { kind: 'progress'; label: string }
  | { kind: 'done'; label: string }

const DISMISSED_KEY = 'manor.providerUpdates.dismissed'

const nameOf = (provider: Provider) => PROVIDERS.find((option) => option.value === provider)?.label ?? provider
/** A dismissal holds for one release. The next version asks again. */
const releaseOf = (update: ProviderUpdate) => `${update.provider}:${update.latestVersion}`
const actionable = (update: ProviderUpdate) => update.canUpdate && (update.state === 'available' || update.state === 'failed')
/** No current version means Manor is installing a runtime it had none of. */
const installs = (update: ProviderUpdate) => update.currentVersion === ''
const versionsOf = (update: ProviderUpdate) => (installs(update) ? update.latestVersion : `${update.currentVersion} → ${update.latestVersion}`)

function readDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

/**
 * Everything the toast and the rail button need to agree on. Available releases are
 * dismissed per release and remembered across restarts; a failure is dismissed for
 * this session only, and a retry of that provider forgets the dismissal so its next
 * failure is seen.
 */
export function useProviderUpdates(updates: ProviderUpdate[]) {
  const [dismissed, setDismissed] = useState(readDismissed)
  const [failedDismissed, setFailedDismissed] = useState<string[]>([])
  const [pillHidden, setPillHidden] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  // The providers the current run touched, so the check names only what this run did.
  const ran = useRef<Provider[]>([])
  const installed = useRef<Provider[]>([])

  const failed = updates.filter((update) => update.state === 'failed')
  const available = updates.filter((update) => update.state === 'available')

  useEffect(() => {
    const now = updates.filter((update) => update.state === 'updating')
    if (now.length > 0) {
      if (ran.current.length === 0) {
        setPillHidden(false)
        setDone(null)
      }
      ran.current = [...new Set([...ran.current, ...now.map((update) => update.provider)])]
      installed.current = [...new Set([...installed.current, ...now.filter(installs).map((update) => update.provider)])]
      setFailedDismissed((keys) => {
        const kept = keys.filter((key) => !now.some((update) => releaseOf(update) === key))
        return kept.length === keys.length ? keys : kept
      })
      return
    }
    if (ran.current.length === 0) return
    const touched = ran.current
    const fresh = installed.current
    ran.current = []
    installed.current = []
    // A failure gets its own card; a check beside it would say the run went well.
    if (updates.some((update) => update.state === 'failed' && touched.includes(update.provider))) return
    const finished = updates.filter((update) => update.state === 'updated' && touched.includes(update.provider))
    const [only] = finished
    if (only === undefined) return
    setDone(finished.length === 1 ? `${nameOf(only.provider)} ${fresh.includes(only.provider) ? 'installed' : 'updated'}` : 'Providers updated')
  }, [updates])

  useEffect(() => {
    if (done === null) return
    const timer = setTimeout(() => setDone(null), TOAST_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [done])

  // Only releases not yet dismissed reach the card; a dismissed one stays in the rail
  // even when another provider's news brings the card back. Kept as one value while its
  // inputs hold, like the rail entries below, because the nav rail skips streaming re-renders.
  const toast = toastOf(updates, pillHidden, done, failedDismissed, dismissed)

  const dismissToast = () => {
    if (toast?.kind === 'failed') {
      setFailedDismissed((keys) => [...new Set([...keys, ...failed.map(releaseOf)])])
      return
    }
    if (toast?.kind === 'available') {
      // Kept to releases still on offer, so the list never outgrows the providers.
      const next = [...new Set([...dismissed.filter((key) => updates.some((update) => releaseOf(update) === key)), ...available.map(releaseOf)])]
      setDismissed(next)
      try {
        window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
      } catch {
        // Private mode: the dismissal holds until reload, which is all it can do.
      }
      return
    }
    setPillHidden(true)
    setDone(null)
  }

  // The rail carries whatever the toast is not showing. Finished entries are on
  // their way out server-side and have nothing left to offer.
  const inCard = toast?.kind === 'available' || toast?.kind === 'failed' ? toast.entries : NO_UPDATES
  const railEntries = updates.filter((update) => update.state !== 'updated' && !inCard.includes(update))
  return { toast, dismissToast, railEntries }
}

function toastOf(updates: ProviderUpdate[], pillHidden: boolean, done: string | null, failedDismissed: readonly string[], dismissed: readonly string[]): UpdateToast | null {
  const running = updates.filter((update) => update.state === 'updating')
  const freshFailed = updates.filter((update) => update.state === 'failed' && !failedDismissed.includes(releaseOf(update)))
  const freshAvailable = updates.filter((update) => update.state === 'available' && !dismissed.includes(releaseOf(update)))
  const [firstRunning] = running
  return firstRunning !== undefined
    ? pillHidden
      ? null
      : { kind: 'progress', label: running.length === 1 ? `${installs(firstRunning) ? 'Installing' : 'Updating'} ${nameOf(firstRunning.provider)}…` : 'Updating providers…' }
    : done !== null && !pillHidden
      ? { kind: 'done', label: done }
      : freshFailed.length > 0
        ? { kind: 'failed', entries: freshFailed }
        : freshAvailable.length > 0
          ? { kind: 'available', entries: freshAvailable }
          : null
}

const NO_UPDATES: ProviderUpdate[] = []

/**
 * The provider CLIs' card in the window's notice stack. The pill keeps one key from
 * spinner to check, so the swap happens inside it instead of one card leaving and
 * another arriving.
 */
export function providerUpdateNotice(toast: UpdateToast | null, onUpdate: UpdateProviders, onDismiss: () => void): HouseNotice | null {
  if (toast === null) return null
  if (toast.kind === 'progress' || toast.kind === 'done') {
    return {
      key: 'provider-updates:pill',
      dismiss: onDismiss,
      node: <NoticeCard mark={<ProgressMark tone={toast.kind === 'done' ? 'done' : 'running'} />} title={toast.label}
        dismissLabel={toast.kind === 'done' ? 'Dismiss' : 'Hide progress'} onDismiss={onDismiss} />,
    }
  }
  return { key: `provider-updates:${toast.kind}`, dismiss: onDismiss, node: <UpdateCard toast={toast} onUpdate={onUpdate} onDismiss={onDismiss} /> }
}

function UpdateCard({
  toast,
  onUpdate,
  onDismiss,
}: {
  toast: Extract<UpdateToast, { kind: 'available' | 'failed' }>
  onUpdate: UpdateProviders
  onDismiss: () => void
}) {
  const [reviewing, setReviewing] = useState(false)
  const { entries } = toast
  const [only] = entries
  const single = entries.length === 1 ? only : undefined
  const failed = toast.kind === 'failed'

  const title = failed
    ? single === undefined ? `${entries.length} provider updates failed` : `${nameOf(single.provider)} ${installs(single) ? 'install' : 'update'} failed`
    : single === undefined ? `${entries.length} provider updates available` : `${nameOf(single.provider)} update available`
  const line =
    single === undefined
      ? failed ? null : `${listOf(entries.map((entry) => nameOf(entry.provider)))} have newer versions.`
      : failed
        ? single.error ?? 'The updater stopped without saying why.'
        : versionsOf(single)
  const canAct = entries.some(actionable)

  return (
    <div
      role={failed ? 'alert' : 'status'}
      className={`relative ${NOTICE_WIDTH} rounded-xl border border-line bg-raised px-3.5 py-3 shadow-popover`}
    >
      {/* The mark sits in a box one title line tall, so it centres on the title's line
          rather than on the top of the text block. */}
      <div className="flex items-start gap-2.5 pr-7">
        <span className="grid h-6 flex-none place-items-center">
          <Icon icon={Alert02Icon} size={16} className={failed ? 'text-danger' : 'text-muted'} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 leading-6 font-medium text-text">{title}</p>
          {line === null ? null : (
            <p className={`m-0 mt-0.5 text-label tabular-nums [overflow-wrap:anywhere] ${failed ? 'text-danger' : 'text-muted'}`}>
              {line}
            </p>
          )}
        </div>
      </div>
      {/* 10px from the top and the right edge alike, which also centres it on the
          title's line: 12px padding plus half of 24 is 10px plus half of 28. */}
      <ToastDismiss label="Dismiss" onDismiss={onDismiss} className="absolute top-2.5 right-2.5" />

      {single === undefined ? (
        // Failures come open: each row carries its own reason, and a fold would hide the
        // one thing the card is there to say.
        <Fold open={failed || reviewing}>
          <UpdateRows entries={entries} onUpdate={onUpdate} className="mt-2 ml-[26px]" />
        </Fold>
      ) : null}

      {single !== undefined && !canAct ? null : (
        <div className="mt-2 ml-[18px] flex items-center gap-1">
          {single === undefined && !failed ? (
            <Button variant="ghost" size="small" aria-expanded={reviewing} onClick={() => setReviewing((open) => !open)}>
              {reviewing ? 'Hide updates' : 'Review updates'}
            </Button>
          ) : null}
          {canAct ? (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                if (single !== undefined) onUpdate(single.provider)
                else if (failed) for (const entry of entries.filter(actionable)) onUpdate(entry.provider)
                else onUpdate()
              }}
            >
              {failed ? 'Retry' : single === undefined ? 'Update all' : 'Update'}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}

/**
 * The door at the foot of the nav rail, above the theme toggle, for updates the toast
 * was sent away from.
 * The dot says something is waiting on the user; while a run is only in progress, the
 * rows say so and the dot stays off.
 */
export function ProviderUpdateRailButton({ entries, onUpdate }: { entries: ProviderUpdate[]; onUpdate: UpdateProviders }) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), { within: [wrapper], escape: true })

  const hasFailure = entries.some((entry) => entry.state === 'failed')
  const waiting = hasFailure || entries.some((entry) => entry.state === 'available')
  const label = hasFailure ? 'Provider update failed' : 'Provider updates'

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        className={`relative grid h-8 w-8 cursor-pointer place-items-center rounded-button border-0 ${
          open ? 'bg-surface-2 text-text' : 'bg-transparent text-muted hover:bg-surface-2 hover:text-text'
        }`}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        <Icon icon={InstallingUpdates01Icon} size={16} />
        {waiting ? (
          <span
            aria-hidden
            className={`absolute top-1.5 right-1.5 size-1.5 rounded-full ring-2 ring-surface ${hasFailure ? 'bg-danger' : 'bg-warn-fill'}`}
          />
        ) : null}
      </button>
      <Popover
        open={open}
        origin="bottom-left"
        // Clear of the rail's edge: 12px from the button to the border, then 8px of air.
        className="absolute left-[calc(100%+20px)] bottom-0 z-20 w-[300px] rounded-xl border border-line surface-floating p-2.5 shadow-menu"
        aria-label="Provider updates"
      >
        <p className="m-0 mb-0.5 text-meta font-medium text-dim">Provider updates</p>
        <UpdateRows entries={entries} onUpdate={onUpdate} />
        {entries.filter(actionable).length > 1 ? (
          <div className="mt-2 flex justify-end">
            <Button variant="secondary" size="compact" onClick={() => onUpdate()}>
              Update all
            </Button>
          </div>
        ) : null}
      </Popover>
    </div>
  )
}

function UpdateRows({ entries, onUpdate, className = '' }: { entries: ProviderUpdate[]; onUpdate: UpdateProviders; className?: string }) {
  return (
    <ul className={`m-0 flex list-none flex-col p-0 ${className}`}>
      {entries.map((entry) => (
        <li key={entry.provider} className="flex items-center gap-2.5 py-1.5">
          <span className="grid size-5 flex-none place-items-center self-start pt-0.5 text-text">
            <ProviderMark driver={entry.provider} size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-label font-medium text-text">{nameOf(entry.provider)}</span>
            <span className="block text-meta text-dim tabular-nums">
              {versionsOf(entry)}
            </span>
            {entry.state === 'failed' ? (
              <span className="block text-meta text-danger [overflow-wrap:anywhere]">
                {entry.error ?? 'The updater stopped without saying why.'}
              </span>
            ) : null}
          </span>
          <span className="flex-none self-start pt-0.5">{rowTrailing(entry, onUpdate)}</span>
        </li>
      ))}
    </ul>
  )
}

function rowTrailing(entry: ProviderUpdate, onUpdate: UpdateProviders): ReactNode {
  if (entry.state === 'updating') {
    return (
      <span className="flex items-center gap-1.5 text-label text-muted">
        <Icon icon={LoaderCircleIcon} size={13} className="motion-safe:animate-spin-calm" />
        Updating…
      </span>
    )
  }
  if (entry.state === 'updated') {
    return (
      <span className="flex items-center gap-1.5 text-label text-ok">
        <Icon icon={CheckmarkCircle02Icon} size={13} />
        Updated
      </span>
    )
  }
  // Only a `MANOR_CODEX_COMMAND` override takes the button away; Manor cannot update
  // a CLI it was told to use from somewhere else.
  if (!entry.canUpdate) return null
  return (
    <Button variant="secondary" size="compact" onClick={() => onUpdate(entry.provider)}>
      {entry.state === 'failed' ? 'Retry' : 'Update'}
    </Button>
  )
}

const listOf = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
