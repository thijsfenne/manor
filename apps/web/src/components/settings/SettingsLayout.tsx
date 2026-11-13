import { useEffect, useId, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '../ui/Button'

/**
 * One Settings page: its title and the 720px column it reads in.
 */
export function SettingsPage({
  title,
  description,
  onSaveShortcut,
  children,
}: {
  title: string
  description?: ReactNode
  /** A page with an explicit Save: ⌘S anywhere on it runs this, the Save button's handler. */
  onSaveShortcut?: () => void
  children: ReactNode
}) {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div
        className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-8 pt-10 pb-12 @max-[560px]:px-5 @max-[560px]:pt-7"
        {...(onSaveShortcut === undefined ? {} : saveShortcut(onSaveShortcut))}
      >
        <header>
          <div className="min-w-0">
            <h1 className="m-0 font-display text-[24px] leading-tight font-semibold tracking-[-0.02em]">{title}</h1>
            {description === undefined ? null : (
              <p className="mt-1 mb-0 max-w-[590px] text-[16px] leading-relaxed text-muted">{description}</p>
            )}
          </div>
        </header>
        {children}
      </div>
    </div>
  )
}

/** A small header over related rows, with the way back to the defaults where they exist. */
export function SettingsGroup({
  title,
  onRestore,
  restoreDisabled = false,
  children,
}: {
  title: string
  onRestore?: () => void
  /** Already at the defaults, so the act would change nothing. */
  restoreDisabled?: boolean
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <section className="flex flex-col" aria-labelledby={titleId}>
      <div className="flex min-h-6 items-center justify-between gap-4 pb-1">
        <h2 id={titleId} className="m-0 text-meta font-medium text-dim">{title}</h2>
        {onRestore === undefined ? null : (
          <button
            type="button"
            className="cursor-pointer rounded-md border-0 bg-transparent px-1.5 py-0.5 text-meta text-dim outline-none hover:text-text focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-50 disabled:hover:text-dim"
            disabled={restoreDisabled}
            onClick={onRestore}
          >
            Restore defaults
          </button>
        )}
      </div>
      <div className="flex flex-col divide-y divide-line">{children}</div>
    </section>
  )
}

/** Label and one line of why on the left, the control on the right. */
export function SettingsRow({
  label,
  description,
  children,
}: {
  label: ReactNode
  description?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-6 py-3 @max-[480px]:flex-col @max-[480px]:items-start @max-[480px]:gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] font-medium text-text">{label}</span>
        {description === undefined ? null : <span className="text-label text-muted">{description}</span>}
      </div>
      {children === undefined ? null : <div className="flex min-w-0 flex-none items-center gap-2">{children}</div>}
    </div>
  )
}

/**
 * ⌘S on a page with an explicit Save, as in Files and Knowledge. Spread onto the
 * element around the form: Settings lets ⌘S through only inside one of these, and
 * stopping it here keeps the workspace's own ⌘S from seeing it too. `save` is the
 * Save button's own handler, so the key checks and refuses exactly as the click does.
 */
export const saveShortcut = (save: () => void) => ({
  'data-settings-save': true,
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
    if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    save()
  },
})

/**
 * A page holding an unsaved edit says so while it does. Leaving Settings, switching
 * page or picking another agent then asks before the edit is lost.
 */
export function useUnsavedGuard(dirty: boolean, report: (dirty: boolean) => void) {
  useEffect(() => {
    report(dirty)
  }, [dirty, report])
  useEffect(() => () => report(false), [report])
}

/**
 * The foot of a page with an explicit Save: whether anything is unsaved, and the two
 * ways to settle it. Pinned to the bottom of the page's scroll so it is always in reach.
 */
export function SaveBar({
  dirty,
  pending,
  canSave = true,
  saveLabel = 'Save',
  status,
  onSave,
  onDiscard,
  children,
}: {
  dirty: boolean
  pending: boolean
  /** Dirty but not saveable yet, e.g. a required field is empty. */
  canSave?: boolean
  saveLabel?: string
  /** Replaces the saved/unsaved line where neither is true yet, as for a new agent. */
  status?: string
  onSave: () => void
  onDiscard: () => void
  /** Anything that belongs beside the buttons, such as a Delete set apart on the left. */
  children?: ReactNode
}) {
  return (
    <div className="sticky bottom-0 z-[1] -mx-8 -mb-12 flex items-center gap-3 border-t border-line bg-bg px-8 py-3 @max-[560px]:-mx-5 @max-[560px]:px-5">
      {children}
      <span className="min-w-0 flex-1 truncate text-label text-dim" role="status">
        {pending ? 'Saving…' : status ?? (dirty ? 'Unsaved changes' : 'All changes saved')}
      </span>
      <Button size="small" variant="ghost" disabled={!dirty || pending} onClick={onDiscard}>Discard</Button>
      <Button size="small" variant="primary" disabled={!dirty || pending || !canSave} onClick={onSave}>
        {pending ? 'Saving…' : saveLabel}
      </Button>
    </div>
  )
}
