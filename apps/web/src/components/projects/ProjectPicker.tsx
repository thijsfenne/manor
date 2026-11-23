import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Cancel01Icon, Folder01Icon, FolderAddIcon, Search01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { isFolder, type Project } from '@manor/contracts'
import { INSTANT, TEXT_SWAP, TEXT_SWAP_ABOVE, TEXT_SWAP_BELOW, TEXT_SWAP_REST } from '../../motion'
import { ProjectMark } from '../ProjectMark'
import { markLetters } from '../../projectAppearance'
import { Icon } from '../Icon'
import { Popover } from '../ui/Popover'
import { Tooltip } from '../ui/Tooltip'
import { useDismiss } from '../ui/useDismiss'
import { usePopupPlacement } from '../ui/usePopupPlacement'

const MAX_HEIGHT = 320
/** Below this the list opens into a slit, so it flips above the trigger instead. */
const MIN_HEIGHT = 180
const MIN_WIDTH = 260
const CLEAR_LABEL = "Don't work in a project"
const CHANGE_LABEL = 'Change the project for this chat'
const ADD_FOLDER = 'Add folder'
const ADD_FOLDER_TIP = 'Choose a folder to work in'
/** Opens the list from anywhere on the stage; `event.code` because Option rewrites `event.key`. */
export const CHANGE_PROJECT_KEYS = '⌥⇧⌘O'

/**
 * The rows the list shows: projects and the folders added here (2026-11-13). The home
 * room is "no project" and never one of them, and a removed folder is off the list.
 */
export function pickerRows(projects: readonly Project[], general: Project | undefined, needle: string) {
  return projects.filter((project) =>
    project.id !== general?.id && project.unlisted !== true && project.name.toLowerCase().includes(needle))
}

interface ProjectPickerProps {
  projects: Project[]
  value: string
  onChange: (projectId: string) => void
  /**
   * Adds a folder to work in, without a project thread: Finder on the desktop, the
   * server's folder walk elsewhere. A real project is made only from Projects in the
   * sidebar, so the list has no New project row. The picker closes first.
   */
  onAddFolder: () => void
  /** Takes a folder off the list. Its Sessions keep it. Absent, folders have no remove control. */
  onRemoveFolder?: (projectId: string) => void
  /** The home room, which "Don't work in a project" falls back to. Absent, there is nothing to clear to. */
  general?: Project | undefined
  disabled?: boolean
  /**
   * `chip` is the tray's control. `inline` is the project name in the stage heading: it
   * inherits the heading's type, is marked editable by a dotted underline, and leaves
   * the clear action to the list and the shortcut to the chip.
   */
  variant?: 'chip' | 'inline'
}

/**
 * Which room a Session is about to be started in, as the one chip in the bar above the
 * composer. A search field over the list rather than a plain dropdown, because the house
 * grows and the project the user wants is usually one they can name faster than they can find.
 *
 * Focus stays in the search field the whole time and the list is driven by
 * `aria-activedescendant`, the same shape `ui/Select` uses, so typing and the
 * arrow keys never fight over who owns focus.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
  onAddFolder,
  onRemoveFolder,
  general,
  disabled = false,
  variant = 'chip',
}: ProjectPickerProps) {
  const reduce = useReducedMotion() ?? false
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  const placement = usePopupPlacement({
    open,
    triggerRef,
    maxHeight: MAX_HEIGHT,
    minHeight: MIN_HEIGHT,
    minWidth: MIN_WIDTH,
  })
  const [query, setQuery] = useState('')
  // What the arrow keys point at, which is not yet what is chosen. Hover moves it
  // too, so a mouse and a keyboard can never highlight two rows at once.
  const [active, setActive] = useState(0)
  const [tip, setTip] = useState<{ anchor: HTMLElement; text: string; keys?: string } | null>(null)
  const tipId = useId()
  // Hover only: the keyboard has the shortcut and the labels. Gone once the list is up.
  const tipOn = (text: string, keys?: string) => ({
    onPointerEnter: (event: { currentTarget: HTMLElement }) =>
      setTip({ anchor: event.currentTarget, text, ...(keys === undefined ? {} : { keys }) }),
    onPointerLeave: () => setTip(null),
  })

  // The home room is "no project": it never shows as a project of its own.
  const current = value === general?.id ? undefined : projects.find((project) => project.id === value)
  const needle = query.trim().toLowerCase()
  const matches = pickerRows(projects, general, needle)
  // Nothing to choose from yet: the chip is then the way to add the first folder, not
  // a door onto an empty list. With a row there, the chip only ever opens the list.
  const none = current === undefined && pickerRows(projects, general, '').length === 0

  const show = () => {
    if (disabled) return
    setTip(null)
    if (none) {
      onAddFolder()
      return
    }
    setQuery('')
    // Against the whole list: `matches` is still narrowed by the search being left.
    setActive(Math.max(0, pickerRows(projects, general, '').findIndex((project) => project.id === value)))
    setOpen(true)
  }

  const hide = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const clear = () => {
    if (general === undefined) return
    setTip(null)
    setOpen(false)
    onChange(general.id)
    triggerRef.current?.focus()
  }

  // Stays registered for as long as the stage shows the chip. A ref so the listener
  // is added once and always calls the current `show`. Only while the chip is what is
  // on screen at its own spot: a dialog or Settings laid over the stage keeps the key.
  const showRef = useRef(show)
  showRef.current = show
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (disabled) setTip(null)
  }, [disabled])
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.code !== 'KeyO' || !event.altKey || !event.shiftKey || !(event.metaKey || event.ctrlKey)) return
      if (event.repeat || openRef.current || variant === 'inline') return
      const trigger = triggerRef.current
      if (trigger === null) return
      const box = trigger.getBoundingClientRect()
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      if (top === null || !trigger.contains(top)) return
      event.preventDefault()
      showRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [variant])

  const choose = (index: number) => {
    const project = matches[index]
    if (project !== undefined) onChange(project.id)
    hide()
  }

  // Escape is not in here: the search field's own key handler takes it, because that
  // path hands focus back to the trigger rather than dropping it on the body.
  useDismiss(open, () => setOpen(false), { within: [triggerRef, popupRef], layoutMoved: true })

  // Keeps the arrow keys' row in view when the list is longer than the popup.
  useEffect(() => {
    if (!open) return
    popupRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const step = (delta: number) => {
    setActive((current) => Math.max(0, Math.min(matches.length - 1, current + delta)))
  }

  const addFolder = () => {
    setOpen(false)
    onAddFolder()
  }

  const removeFolder = (project: Project) => {
    onRemoveFolder?.(project.id)
    // The row the keys point at stays on the list that is left.
    setActive((current) => Math.max(0, Math.min(current, matches.length - 2)))
    searchRef.current?.focus()
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      // Tab is the one key that leaves without preventDefault: the list closes and
      // focus moves on, rather than trapping a keyboard behind an open popup.
      case 'Tab':
        setOpen(false)
        return
      case 'Escape':
        event.preventDefault()
        hide()
        return
      case 'ArrowDown':
        event.preventDefault()
        step(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        step(-1)
        return
      case 'Enter':
        event.preventDefault()
        choose(active)
        return
      // The keyboard's way to the remove control a folder row shows on hover.
      case 'Backspace': {
        const project = matches[active]
        if (!(event.metaKey || event.ctrlKey) || project === undefined || onRemoveFolder === undefined || !isFolder(project)) return
        event.preventDefault()
        removeFolder(project)
        return
      }
      default:
    }
  }

  return (
    <>
      {variant === 'inline' ? (
        current === undefined ? null : (
          <button
            ref={triggerRef}
            type="button"
            className="relative ml-1 inline-flex cursor-pointer items-center border-x-0 border-t-0 border-b border-dotted border-dim bg-transparent p-0 align-baseline text-inherit [font:inherit] hover:border-muted focus-visible:border-text focus-visible:outline-none disabled:cursor-default disabled:border-transparent disabled:opacity-45"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="Change the project for this chat"
            onClick={() => (open ? hide() : show())}
          >
            {/* The subject of the sentence changing under you, so it swaps rather than cuts.
                Mark and name are one box. `popLayout` and not `wait`: a gap while the old
                one leaves would leave "working on in ?" on screen. The dotted underline
                stays put, which is what the eye holds on to. */}
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={current.id}
                className="inline-flex items-center gap-1.5"
                initial={reduce ? false : TEXT_SWAP_BELOW}
                animate={TEXT_SWAP_REST}
                exit={reduce ? { opacity: 0 } : TEXT_SWAP_ABOVE}
                transition={reduce ? INSTANT : TEXT_SWAP}
              >
                <ProjectMark icon={current.icon} color={current.color} src={current.repoIconSrc} letters={markLetters(current)} size={20} />
                {current.name}
              </motion.span>
            </AnimatePresence>
          </button>
        )
      ) : (
      <span
        className={`group/chip flex h-7 min-w-0 items-center rounded-full text-label hover:bg-user-bg ${open ? 'bg-user-bg' : ''}`}
      >
        {/* The mark is which project this is, and anywhere on the chip it turns into the
            way out of it. Without a home room to fall back to there is no way out, so it
            stays a mark. */}
        {current === undefined ? null : general === undefined ? (
          <span className="grid h-7 w-7 flex-none place-items-center">
            <ProjectMark icon={current.icon} color={current.color} src={current.repoIconSrc} letters={markLetters(current)} size={15} />
          </span>
        ) : (
          <button
            type="button"
            className="group/clear relative grid h-7 w-7 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 disabled:cursor-default disabled:opacity-45"
            disabled={disabled}
            aria-label={CLEAR_LABEL}
            {...tipOn(CLEAR_LABEL)}
            onClick={clear}
          >
            <ProjectMark
              className="col-start-1 row-start-1 transition-opacity duration-150 group-hover/chip:opacity-0 group-focus-within/chip:opacity-0"
              icon={current.icon}
              color={current.color}
              src={current.repoIconSrc}
              letters={markLetters(current)}
              size={15}
            />
            <span className="absolute grid h-4 w-4 place-items-center rounded-full bg-dim text-bg opacity-0 transition-[opacity,background-color] duration-150 group-hover/clear:bg-text group-hover/chip:opacity-100 group-focus-within/chip:opacity-100">
              <Icon icon={Cancel01Icon} size={10} />
            </span>
          </button>
        )}
        {/* One trigger for both states, so focus and the popup's anchor survive a clear. */}
        <button
          ref={triggerRef}
          type="button"
          className={`flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent [font-family:inherit] disabled:cursor-default disabled:opacity-45 ${
            current === undefined ? 'px-2 text-dim hover:text-muted' : 'pr-2.5 pl-0.5 text-text'
          }`}
          disabled={disabled}
          {...(none ? {} : { 'aria-haspopup': 'listbox' as const, 'aria-expanded': open })}
          aria-label={none ? ADD_FOLDER : current === undefined ? 'Choose project' : 'Project for this chat'}
          aria-describedby={tip === null ? undefined : tipId}
          {...tipOn(none ? ADD_FOLDER_TIP : CHANGE_LABEL, CHANGE_PROJECT_KEYS)}
          onClick={() => {
            setTip(null)
            if (open) hide()
            else show()
          }}
        >
          {current === undefined ? <Icon className="flex-none" icon={none ? FolderAddIcon : Folder01Icon} size={15} /> : null}
          <span className="max-w-[220px] truncate">{current?.name ?? (none ? ADD_FOLDER : 'Choose project')}</span>
        </button>
      </span>
      )}
      {tip === null || open ? null : (
        <Tooltip anchor={tip.anchor} id={tipId} onDismiss={() => setTip(null)}>
          {tip.text}
          {tip.keys === undefined ? null : (
            <kbd className="ml-2 rounded-md bg-user-bg px-1.5 py-0.5 font-sans text-meta text-muted">{tip.keys}</kbd>
          )}
        </Tooltip>
      )}

      {createPortal(
        <Popover
          ref={popupRef}
          open={open && placement !== null}
          // Focus rides the popup rather than `open`, because the first open renders
          // once with no placement yet and the field is not in the tree for that pass.
          // An effect on `open` would reach for a ref that is still null and never fire
          // again, which is why the very first open used to land nowhere.
          onReady={() => searchRef.current?.focus()}
          // Placement flips this list above the trigger when there is no room below,
          // and a sheet that grew from the wrong edge would point at nothing. Centred
          // rather than cornered: this popup is wider than the name it hangs under, so
          // a corner would drag it sideways on the way in.
          origin={placement?.top === undefined ? 'bottom' : 'top'}
          className="fixed z-30 flex flex-col overflow-hidden rounded-lg border border-line surface-floating shadow-menu"
          style={
            placement === null
              ? undefined
              : {
                  left: placement.left,
                  top: placement.top,
                  bottom: placement.bottom,
                  width: placement.width,
                  maxHeight: placement.maxHeight,
                }
          }
          contentClassName="flex min-h-0 flex-1 flex-col"
        >
            <div className="flex flex-none items-center gap-2 border-b border-line px-2.5 py-2">
              <Icon className="flex-none text-dim" icon={Search01Icon} size={14} />
              <input
                ref={searchRef}
                className="min-w-0 flex-1 border-0 bg-transparent text-label text-text outline-none placeholder:text-dim"
                placeholder="Find a project or folder…"
                value={query}
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={`${listId}-${active}`}
                aria-label="Search projects and folders"
                onChange={(event) => {
                  setQuery(event.target.value)
                  // The row the keys point at belongs to the list as it now reads.
                  setActive(0)
                }}
                onKeyDown={onSearchKeyDown}
              />
            </div>

            <div id={listId} role="listbox" aria-label="Projects" className="min-h-0 flex-1 overflow-y-auto p-1">
              {matches.length === 0 ? (
                <p className="m-0 px-2 py-2 text-[12px] text-dim">{query.trim() === '' ? 'No folders yet' : 'Nothing by that name'}</p>
              ) : (
                matches.map((project, index) => {
                  const removable = onRemoveFolder !== undefined && isFolder(project)
                  return (
                    <div key={project.id} role="none" className="group/row relative">
                      <button
                        id={`${listId}-${index}`}
                        type="button"
                        role="option"
                        aria-selected={project.id === value}
                        data-index={index}
                        tabIndex={-1}
                        {...(removable ? { 'aria-keyshortcuts': 'Meta+Backspace Control+Backspace' } : {})}
                        className={`flex w-full cursor-pointer items-center gap-2 rounded-md border-0 px-2 py-1.5 text-left text-label text-text ${
                          index === active ? 'bg-user-bg' : 'bg-transparent'
                        }`}
                        onMouseEnter={() => setActive(index)}
                        // The press must not pull focus out of the search field, which
                        // is what drives the list.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(index)}
                      >
                        <ProjectMark icon={project.icon} color={project.color} src={project.repoIconSrc} letters={markLetters(project)} size={15} />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        {project.id === value ? (
                          <Icon
                            className={`flex-none ${removable ? 'group-hover/row:opacity-0' : ''}`}
                            icon={Tick02Icon}
                            size={13}
                          />
                        ) : (
                          <span className="w-[13px] flex-none" aria-hidden="true" />
                        )}
                      </button>
                      {/* The way off the list, on the folder it undoes. A project leaves from Projects in the sidebar.
                          The pointer's handle only: the keyboard and a screen reader use ⌘⌫ on the option. */}
                      {removable ? (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-hidden="true"
                          className="absolute top-1/2 right-1.5 grid h-5 w-5 -translate-y-1/2 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-dim opacity-0 group-hover/row:opacity-100 hover:bg-line hover:text-text"
                          aria-label={`Remove ${project.name} from this list`}
                          title="Remove from this list (⌘⌫)"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => removeFolder(project)}
                        >
                          <Icon icon={Cancel01Icon} size={11} />
                        </button>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>

            <div className="flex-none border-t border-line p-1">
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-label text-muted hover:bg-user-bg hover:text-text"
                onMouseDown={(event) => event.preventDefault()}
                onClick={addFolder}
              >
                <Icon className="flex-none" icon={FolderAddIcon} size={14} />
                <span>{ADD_FOLDER}</span>
              </button>
              {current === undefined || general === undefined ? null : (
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-label text-muted hover:bg-user-bg hover:text-text"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={clear}
                >
                  <Icon className="flex-none" icon={Cancel01Icon} size={14} />
                  <span>{CLEAR_LABEL}</span>
                </button>
              )}
            </div>
        </Popover>,
        document.body,
      )}
    </>
  )
}
