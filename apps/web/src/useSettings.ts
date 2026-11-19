import { useCallback, useRef, useState } from 'react'
import { SETTINGS_GROUPS, type SettingsLocation, type SettingsSection } from './components/settings/sections'

const RELOAD_SETTINGS_KEY = 'manor:settings-location'

/** The page this tab had open, so a reload lands on it again; null when Settings was closed. */
function readSettingsLocation(): SettingsLocation | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_SETTINGS_KEY)
    const stored: unknown = raw === null ? null : JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('section' in stored)) return null
    const section = SETTINGS_GROUPS.flatMap((group) => group.sections).find((entry) => entry.id === stored.section)?.id
    if (section === undefined) return null
    return 'agentId' in stored && typeof stored.agentId === 'string' && stored.agentId !== '' ? { section, agentId: stored.agentId } : { section }
  } catch {
    return null
  }
}

function writeSettingsLocation(location: SettingsLocation | null): void {
  try {
    if (location === null) window.sessionStorage.removeItem(RELOAD_SETTINGS_KEY)
    else window.sessionStorage.setItem(RELOAD_SETTINGS_KEY, JSON.stringify(location))
  } catch {
    // Storage can be disabled; Settings still opens and closes in this tab.
  }
}

/**
 * Where Settings is, and the one guard every way out of an unsaved edit passes:
 * Back to app, Escape, another page, another agent, a rail door. Settings sits over
 * the workspace rather than replacing it, so closing it is all "back" needs to mean.
 * The open page survives a reload of this tab, like the workspace location under it.
 */
export function useSettings(live: boolean) {
  const [location, setStoredLocation] = useState(readSettingsLocation)
  // A page asks the server for its data once, on mount, and a send before the first
  // socket opens is dropped. So nothing shows until then, a page restored by a reload included.
  const [wasLive, setWasLive] = useState(live)
  if (live && !wasLive) setWasLive(true)
  const setLocation = useCallback((next: SettingsLocation | null) => {
    writeSettingsLocation(next)
    setStoredLocation(next)
  }, [])
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
    [guard, setLocation],
  )

  const close = useCallback(() => guard(() => setLocation(null)), [guard, setLocation])

  /** Closes without asking; only for a caller already inside `guard`. */
  const dismiss = useCallback(() => setLocation(null), [setLocation])

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

  return { location: wasLive ? location : null, open, close, dismiss, guard, reportDirty, leaving: pendingLeave !== null, discard, keepEditing }
}

export type SettingsController = ReturnType<typeof useSettings>
