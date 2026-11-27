import { useEffect, useState } from 'react'
import { useStableCallback } from '../../useStableCallback'

/** How long a Mail notice with an Undo stays up: longer than a bare confirmation, because there is an Undo to reach for. */
const UNDO_VISIBLE_MS = 6_000

/**
 * The clock of a Mail notice with an Undo in the window's stack. `expire` runs six seconds
 * after the notice under `key` comes up, and waits while the pointer or focus rests on it;
 * a new key starts again, null means none is up. Spread the returned handlers on the
 * notice's wrapper.
 */
export function useNoticeHold(key: string | null, expire: () => void) {
  // Kept apart, so the pointer leaving does not end the hold of a focused Undo, or the other way round.
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const paused = key !== null && (hovered === key || focused === key)
  const end = useStableCallback(expire)

  useEffect(() => {
    if (key === null || paused) return
    const timer = setTimeout(end, UNDO_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [key, paused, end])

  return {
    onPointerEnter: () => setHovered(key),
    onPointerLeave: () => setHovered(null),
    onFocus: () => setFocused(key),
    onBlur: () => setFocused(null),
  }
}
