import { useCallback, useRef, useState } from 'react'
import type { SettingsLocation, SettingsSection } from './components/settings/sections'

/**
 * Where Settings is, and the one guard every way out of an unsaved edit passes:
 * Back to app, Escape, another page, another agent, a rail door. Settings sits over
 * the workspace rather than replacing it, so closing it is all "back" needs to mean.
 */
export function useSettings() {
  const [location, setLocation] = useState<SettingsLocation | null>(null)
  const dirty = useRef(false)
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)

  /** Runs `then` now, or once the user agrees to drop the edit the open page holds. */
  const guard = useCallback((then: () => void) => {
    if (!dirty.current) {
      then()
      return
    }
    setPendingLeave(() => then)
  }, [])

  const open = useCallback(
    (section: SettingsSection, agentId?: string) => {
      guard(() => setLocation(agentId === undefined ? { section } : { section, agentId }))
    },
    [guard],
  )

  const close = useCallback(() => guard(() => setLocation(null)), [guard])

  /** Closes without asking; only for a caller already inside `guard`. */
  const dismiss = useCallback(() => setLocation(null), [])

  const reportDirty = useCallback((value: boolean) => {
    dirty.current = value
  }, [])

  const discard = useCallback(() => {
    const then = pendingLeave
    setPendingLeave(null)
    dirty.current = false
    then?.()
  }, [pendingLeave])

  const keepEditing = useCallback(() => setPendingLeave(null), [])

  return { location, open, close, dismiss, guard, reportDirty, leaving: pendingLeave !== null, discard, keepEditing }
}

export type SettingsController = ReturnType<typeof useSettings>
