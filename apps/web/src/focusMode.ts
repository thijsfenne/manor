import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { animate } from 'motion/react'

/**
 * Focus mode, ⌘. on a chat: the rail, sidebar, top bar contents, panels and composer are
 * hidden, never closed, and the transcript stands alone. The layout lives in `App`, the
 * composer's own reveal in `Composer`; this file owns the keys.
 *
 * - ⌘. toggles it. Esc leaves it, unless the key belongs to a dialog or a field.
 * - A printable key typed while reading starts a reply in the focused pane's composer.
 */
type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'defaultPrevented' | 'isComposing'>

/** Where the key was typed, as far as focus mode cares. */
export type KeyPlace = 'field' | 'dialog' | 'page'

export function keyPlace(target: EventTarget | null): KeyPlace {
  if (!(target instanceof Element)) return 'page'
  if (target.closest('[role="dialog"], [aria-modal="true"]') !== null) return 'dialog'
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return 'field'
  if (target instanceof HTMLElement && target.isContentEditable) return 'field'
  return 'page'
}

export function focusModeKey(event: KeyLike, place: KeyPlace, active: boolean): 'toggle' | 'exit' | null {
  if (event.defaultPrevented || event.isComposing) return null
  if ((event.metaKey || event.ctrlKey) && event.key === '.' && !event.altKey && !event.shiftKey && !event.repeat) return 'toggle'
  return active && place === 'page' && event.key === 'Escape' ? 'exit' : null
}

/**
 * What Escape does in the composer, one step per press: an open completion menu
 * first, then reading mode, then (on the new-Session stage) dropping the project.
 * The open plus menu and the pickers own Escape themselves and never reach here.
 */
export function composerEscapeStep(state: { menuOpen: boolean; plusOpen: boolean; focusMode: boolean; canClearProject: boolean }):
  'close-menu' | 'put-away' | 'clear-project' | null {
  if (state.menuOpen) return 'close-menu'
  if (state.focusMode) return 'put-away'
  return state.canClearProject && !state.plusOpen ? 'clear-project' : null
}

/** A key that starts a reply while reading: printable, typed on the page. Space stays the reader's page-down. */
export function startsReply(event: KeyLike, place: KeyPlace): boolean {
  if (event.defaultPrevented || event.isComposing || place !== 'page') return false
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  return event.key.length === 1 && event.key !== ' '
}

/**
 * ⌘. and Esc on the window. `available` is false off the chat stage, under Settings and
 * on the phone; ⌘. does nothing there and the caller ends an active mode.
 */
export function useFocusModeKeys(active: boolean, available: boolean, setActive: (next: (active: boolean) => boolean) => void) {
  useEffect(() => {
    if (!available) return
    const onKeyDown = (event: KeyboardEvent) => {
      const action = focusModeKey(event, keyPlace(event.target), active)
      if (action === null) return
      event.preventDefault()
      setActive((current) => (action === 'toggle' ? !current : false))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, available, setActive])
}

/** Calls `onType` before a reply-starting key's default action, so focus moved there receives it. */
export function useReplyOnType(active: boolean, onType: () => void) {
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (startsReply(event, keyPlace(event.target))) onType()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, onType])
}

/**
 * Focus mode as it stands: asked for, and available here. Ends itself when it stops being
 * available. The layout jumps in one frame, so `stageCanvas` fades in over it instead of
 * sliding.
 */
export function useFocusMode(
  requested: boolean,
  setRequested: Dispatch<SetStateAction<boolean>>,
  available: boolean,
  instant: boolean,
) {
  const focusMode = requested && available
  useFocusModeKeys(focusMode, available, setRequested)
  useEffect(() => {
    if (!available) setRequested(false)
  }, [available])
  const stageCanvas = useRef<HTMLDivElement>(null)
  const focusShown = useRef(focusMode)
  useLayoutEffect(() => {
    if (focusShown.current === focusMode) return
    focusShown.current = focusMode
    if (stageCanvas.current === null || instant || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    animate(stageCanvas.current, { opacity: [0, 1] }, { duration: 0.2, ease: 'easeOut' })
  }, [focusMode, instant])
  return { focusMode, stageCanvas }
}
