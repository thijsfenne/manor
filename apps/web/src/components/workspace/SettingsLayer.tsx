import { useCallback, useEffect, useMemo } from 'react'
import type { SettingsLocation } from '../settings/sections'
import { isSettingsShortcut } from '../settings/sections'
import { ViewBoundary, retryableLazy } from '../RecoveryBoundary'
import type { SettingsController } from '../../useSettings'
import type { useTheme } from '../../useTheme'
import type { Manor } from '../../useWorkspace'

const SettingsHost = retryableLazy(() => import('../settings/SettingsHost').then((module) => module.SettingsHost))

/**
 * Settings, from the account popover, ⌘, or one of the doors into a page: the Auto
 * mode gear, and Agent settings for an agent without a DM. Each page reads what it shows on the
 * way in, so a stale copy is never what a form saves back. New agent is not a page:
 * it leaves Settings (asking about an unsaved edit) and opens the short form over the
 * workspace. Also owns ⌘, itself, which opens Settings as on any Mac app and inside
 * Settings changes nothing.
 */
export function useSettingsDoors(settings: SettingsController, dismissNotice: () => void, openNewAgent: () => void) {
  const openSettings = useCallback(() => {
    dismissNotice()
    settings.open('general')
  }, [dismissNotice, settings.open])
  const openUsageSettings = useCallback(() => settings.open('usage'), [settings.open])
  const openAutoRules = useCallback(() => {
    dismissNotice()
    settings.open('auto')
  }, [dismissNotice, settings.open])
  const editAgent = useCallback((agentId: string) => settings.open('agents', agentId), [settings.open])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSettingsShortcut(event) || event.repeat) return
      event.preventDefault()
      if (settings.location === null) openSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settings.location, openSettings])

  /** Leaves Settings first, asking about an unsaved edit, then goes where the rail points. */
  const leaveSettingsThen = useCallback(
    <Args extends unknown[]>(act: (...args: Args) => void) =>
      (...args: Args) => {
        if (settings.location === null) act(...args)
        else settings.guard(() => {
          settings.dismiss()
          act(...args)
        })
      },
    [settings.location, settings.guard, settings.dismiss],
  )

  const newAgent = useMemo(() => leaveSettingsThen(openNewAgent), [leaveSettingsThen, openNewAgent])

  return { openSettings, openUsageSettings, openAutoRules, editAgent, newAgent, leaveSettingsThen }
}

/**
 * Settings lying over the workspace, which stays mounted and inert underneath: that is
 * what makes Back to app exact, the same thread, scroll position and unsent draft.
 */
export function SettingsLayer({
  location,
  settings,
  manor,
  theme,
  account,
  onNewAgent,
  onEditAgent,
  onDialogChange,
}: {
  location: SettingsLocation
  settings: SettingsController
  manor: Manor
  theme: ReturnType<typeof useTheme>
  account: { onSignOut: () => void } | undefined
  onNewAgent: () => void
  /** Agent settings wherever that agent's editor lives: its DM, or this page. */
  onEditAgent: (agentId: string) => void
  onDialogChange: (open: boolean) => void
}) {
  return (
    <ViewBoundary
      resetKey={location.section}
      loading={<div className="absolute inset-0 z-[var(--z-settings)] bg-bg" />}
    >
      <SettingsHost
        location={location}
        settings={settings}
        manor={manor}
        theme={theme}
        {...(account === undefined ? {} : { account })}
        providerUpdates={manor.workspace.providerUpdates}
        onNewAgent={onNewAgent}
        onEditAgent={onEditAgent}
        onDialogChange={onDialogChange}
      />
    </ViewBoundary>
  )
}
