import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import type { ChatMode } from '@manor/contracts'
import { ComposerAutoControl } from './RuntimeMenu'
import { SegmentedControl, type SegmentOption } from './ui/SegmentedControl'

export const NEW_CHAT_MODE_PANEL_ID = 'new-chat-mode-panel'

/** What sits after Single/Multiple on the new-chat row, after Auto. Single keeps no picker while Auto is on. */
export function newChatRuntimeKind(
  mode: ChatMode | undefined,
  autoOn: boolean,
): 'single' | 'house' | 'none' {
  if (mode === 'single') return autoOn ? 'none' : 'single'
  return 'house'
}

/**
 * Holds the Single picker so it can leave by shrinking. Width is measured on the
 * inner box (`max-content`) and written onto `.t-resize`, because CSS cannot tween
 * `auto` to `0`. Overflow is clipped only while collapsed, so the model menu that
 * hangs above the trigger is not cut off. Measure `offsetWidth`, not
 * `scrollWidth`: the latter includes the hanging 360px menu and inflates the slot
 * the moment a provider pick re-renders the picker.
 */
export function NewChatPickerSlot({ open, children }: { open: boolean; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    const node = innerRef.current
    if (!node) return
    const measure = () => setWidth(node.offsetWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      className={`t-resize min-w-0${open ? '' : ' overflow-hidden'}`}
      style={{ width: open ? (width ?? undefined) : 0 }}
      aria-hidden={!open}
    >
      <div ref={innerRef} className={`w-max${open ? '' : ' pointer-events-none'}`}>
        {children}
      </div>
    </div>
  )
}

/**
 * Auto, then the model picker. Single/Multiple sits first on a new project chat.
 * The picker collapses to the right of Auto while Single (or a DM) is on Auto.
 */
export function ComposerAutoRow({
  mode,
  onModeChange,
  auto,
  picker,
  pickerOpen = true,
  pickerCollapsible = false,
}: {
  mode?: ChatMode
  onModeChange?: (mode: ChatMode) => void
  auto?: ComponentProps<typeof ComposerAutoControl>
  picker?: ReactNode
  pickerOpen?: boolean
  pickerCollapsible?: boolean
}) {
  const slot = picker == null
    ? null
    : pickerCollapsible
      ? <NewChatPickerSlot open={pickerOpen}>{picker}</NewChatPickerSlot>
      : picker

  return (
    <div className="flex min-w-0 items-center gap-1">
      {mode === undefined || onModeChange === undefined ? null : (
        <>
          <NewChatModeControl mode={mode} onChange={onModeChange} />
          <span aria-hidden="true" className="mx-0.5 h-3.5 w-px flex-none bg-line" />
        </>
      )}
      {auto ? <ComposerAutoControl {...auto} /> : null}
      {slot == null ? null : (
        <div
          {...(mode === undefined ? {} : { id: NEW_CHAT_MODE_PANEL_ID })}
          // One height for every mode's content (36px, the model menu's and the facepile's),
          // so the row stays put when the mode switches and the shorter variants centre in it.
          className="flex h-9 min-w-0 items-center"
        >
          {slot}
        </div>
      )}
    </div>
  )
}

/** The one mode decision a project chat makes before its first turn. */
export function NewChatModeControl({
  mode,
  onChange,
  disabled = false,
  multipleDisabled = false,
  idPrefix = 'new-chat-mode',
  panelId = NEW_CHAT_MODE_PANEL_ID,
}: {
  mode: ChatMode
  onChange: (mode: ChatMode) => void
  disabled?: boolean
  /** Keeps Multiple in view but unpickable; the caller says why next to it. */
  multipleDisabled?: boolean
  idPrefix?: string
  panelId?: string
}) {
  const options: readonly SegmentOption<ChatMode>[] = [
    { value: 'single', label: 'Single', tabId: `${idPrefix}-single`, panelId },
    { value: 'house', label: 'Multiple', tabId: `${idPrefix}-house`, panelId, ...(multipleDisabled ? { disabled: true } : {}) },
  ]
  return <SegmentedControl label="Chat mode" options={options} value={mode} disabled={disabled} onChange={onChange} />
}
