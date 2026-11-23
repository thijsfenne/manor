import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { ArrowLeft01Icon, Cancel01Icon, Search01Icon } from '@hugeicons/core-free-icons'
import { Icon } from '../Icon'
import { Modal } from '../Modal'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Select } from '../ui/Select'
import { SelectionMarker } from '../ui/SelectionMarker'
import { filterSettingsGroups, isWorkspaceShortcut, pageAfterSearch, settingsGroups, type SettingsSection } from './sections'
import { useHostAuto } from '../../useHostAuto'

const SECTION_MARKER = 'settings-section'

interface SettingsViewProps {
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  /** Back to app and Escape. Guarded one level up, so an unsaved edit is asked about first. */
  onClose: () => void
  /** A way out was taken while a page held an unsaved edit. */
  leaving: boolean
  onDiscard: () => void
  onKeepEditing: () => void
  children: ReactNode
}

/**
 * Settings over the sidebar and the stage: its pages on the left where the sidebar's
 * list was, the open page where the chat was. The workspace stays mounted underneath,
 * inert, so closing this returns to the same thread, scroll position and draft.
 */
export function SettingsView({ section, onSection, onClose, leaving, onDiscard, onKeepEditing, children }: SettingsViewProps) {
  const hostAuto = useHostAuto()
  const rootRef = useRef<HTMLDivElement>(null)
  const groups = settingsGroups(hostAuto)
  const [query, setQuery] = useState('')
  const shown = filterSettingsGroups(groups, query)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // Focus arrives on the current page row, and goes back to whatever opened Settings
  // when it closes, or to the face at the rail's foot when that opener is gone.
  useEffect(() => {
    const opener = document.activeElement
    rootRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true })
    return () => {
      const target = opener instanceof HTMLElement && opener.isConnected ? opener : document.querySelector<HTMLElement>('[data-settings-return]')
      target?.focus({ preventScroll: true })
    }
  }, [])

  // The workspace's keys stop here, before they reach a hidden thread. Captured, so
  // they never arrive at all; only a page that saves on ⌘S gets that one.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isWorkspaceShortcut(event)) return
      const saving = event.key.toLowerCase() === 's' && event.target instanceof Element && event.target.closest('[data-settings-save]') !== null
      if (saving) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Anything that claimed Escape first (a select, a dialog, a menu) marks it, and
  // closing one of those is the only step that press takes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Up and down walk the page rows without opening them; Enter or a click opens one.
  const walk = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-settings-row]')]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    if (at === -1) return
    event.preventDefault()
    rows[at + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
  }

  // The open page follows the results: once it stops matching, the first match opens.
  const search = (next: string) => {
    setQuery(next)
    const page = pageAfterSearch(groups, next, section)
    if (page !== undefined) onSection(page)
  }

  // Enter opens the first match. Escape clears a typed query and stays; on an empty
  // field it is left unclaimed, so it closes Settings as everywhere else.
  const searchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      const first = shown[0]?.sections[0]
      if (first !== undefined) onSection(first.id)
    } else if (event.key === 'Escape' && query !== '') {
      event.preventDefault()
      setQuery('')
    }
  }

  return (
    // Two boxes: a container query reads an ancestor, so the grid that folds sits inside
    // the box whose width it reads.
    <div ref={rootRef} className="@container absolute inset-0 z-[var(--z-settings)] bg-bg">
      <div className="grid h-full grid-cols-[240px_minmax(0,1fr)] @max-[640px]:grid-cols-1 @max-[640px]:grid-rows-[auto_minmax(0,1fr)]">
      <nav aria-label="Settings" className="sidebar-surface flex min-h-0 flex-col border-r border-frame bg-sidebar @max-[640px]:hidden">
        <div className="flex-none">
          <div className="flex items-center px-2.5 pt-2">
            <button
              type="button"
              className="flex h-8 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2.5 text-[14px] text-muted outline-none hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-primary"
              title="Back to app (Esc)"
              onClick={onClose}
            >
              <Icon icon={ArrowLeft01Icon} size={16} />
              Back to app
            </button>
          </div>
          <div className="mt-1 flex h-10 items-center px-2.5">
            <h2 className="m-0 min-w-0 flex-1 truncate pl-3 font-display text-[16px] font-semibold tracking-[-0.01em]">Settings</h2>
          </div>
          <div className="mx-2.5 mt-1 flex h-8 items-center gap-2 rounded-lg border border-line bg-stage px-2.5 text-muted focus-within:border-field-focus">
            <Icon icon={Search01Icon} size={16} className="flex-none" />
            <input
              value={query}
              onChange={(event) => search(event.target.value)}
              onKeyDown={searchKey}
              placeholder="Search settings"
              aria-label="Search settings"
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-label text-text outline-none placeholder:text-dim"
            />
            {query === '' ? null : (
              <button
                type="button"
                aria-label="Clear settings search"
                className="grid size-6 flex-none cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-muted hover:bg-surface-2 hover:text-text"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => setQuery('')}
              >
                <Icon icon={Cancel01Icon} size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-y-none px-2.5 pb-4" onKeyDown={walk}>
          {shown.length === 0 ? <p className="m-0 px-3 pt-3 text-label text-dim">No settings match</p> : null}
          {shown.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="pt-3 first:pt-5">
              <h3 className="m-0 px-3 pb-1 text-meta font-medium text-dim">{group.label}</h3>
              {group.sections.map((entry) => {
                const current = entry.id === section
                return (
                  <button
                    key={entry.id}
                    type="button"
                    data-settings-row
                    aria-current={current ? 'page' : undefined}
                    className={`relative flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-3 text-left text-[14px] outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${
                      current ? 'text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
                    }`}
                    onClick={() => onSection(entry.id)}
                  >
                    {current ? <SelectionMarker layoutId={SECTION_MARKER} className="rounded-lg" /> : null}
                    <Icon icon={entry.icon} size={16} className="relative flex-none" />
                    <span className="relative min-w-0 flex-1 truncate">{entry.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </nav>

      {/* Too narrow for a second column: the page list folds into a picker above the page. */}
      <div className="hidden items-center gap-2 border-b border-line py-2 pr-3 pl-3 @max-[640px]:flex">
        <IconButton icon={ArrowLeft01Icon} iconSize={16} label="Back to app" onClick={onClose} />
        <div className="w-[220px] min-w-0">
          <Select
            label="Settings page"
            value={section}
            options={groups.flatMap((group) => group.sections).map((entry) => ({ value: entry.id, label: entry.label }))}
            onChange={onSection}
          />
        </div>
      </div>

      <div className="@container relative min-h-0 min-w-0">
        {children}
      </div>
      </div>

      {!leaving ? null : (
        <Modal title="Discard unsaved changes?" onClose={onKeepEditing}>
          <p className="m-0 text-[14px] text-muted">This page has edits that are not saved yet. Leaving drops them.</p>
          <div className="flex justify-end gap-2">
            <Button onClick={onKeepEditing}>Keep editing</Button>
            <Button variant="danger" onClick={onDiscard}>Discard</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
