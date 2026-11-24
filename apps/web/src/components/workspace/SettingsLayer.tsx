import { useCallback, useEffect, useMemo } from 'react'
import type { SettingsLocation } from '../settings/sections'
import { isSettingsShortcut } from '../settings/sections'
import { ViewBoundary, retryableLazy } from '../RecoveryBoundary'
import { SettingsView } from '../settings/SettingsView'
import type { SettingsController } from '../../useSettings'
import { subscribeSettingsRequests } from '../../settingsIntent'
import type { useTheme } from '../../useTheme'
import type { Manor } from '../../useWorkspace'

const SettingsHost = retryableLazy(() => import('../settings/SettingsHost').then((module) => module.SettingsHost))

/**
 * Settings, from the account popover or ⌘, on the page shown last, or one of the doors into a page: the Auto
 * mode gear, Agent settings for an agent without a DM, and any page `openSettingsAt` names
 * (Voice, from the composer's dictation popover). Each page reads what it shows on the
 * way in, so a stale copy is never what a form saves back. New agent is not a page:
 * it leaves Settings (asking about an unsaved edit) and opens the short form over the
 * workspace. Also owns ⌘, itself, which opens Settings as on any Mac app and inside
 * Settings changes nothing.
 */
export function useSettingsDoors(settings: SettingsController, dismissNotice: () => void, openNewAgent: () => void) {
  const openSettings = useCallback(() => {
    dismissNotice()
    settings.open()
  }, [dismissNotice, settings.open])
  const openAutoRules = useCallback(() => {
    dismissNotice()
    settings.open('auto')
  }, [dismissNotice, settings.open])
  const editAgent = useCallback((agentId: string) => settings.open('agents', agentId), [settings.open])
  useEffect(() => subscribeSettingsRequests((section) => {
    dismissNotice()
    settings.open(section)
  }), [dismissNotice, settings.open])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSettingsShortcut(event) || event.repeat) return
      event.preventDefault()
      // An open dialog (Search, a form) keeps the window; Settings would cover it and leave its field focused.
      if (settings.location === null && document.querySelector('[aria-modal="true"]') === null) openSettings()
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

  return { openSettings, openAutoRules, editAgent, newAgent, leaveSettingsThen }
}

/**
 * Settings as a modal over the workspace, which stays mounted and inert underneath: that
 * is what makes closing exact, the same thread, scroll position and unsent draft.
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
  account: { onForget: () => void } | undefined
  onNewAgent: () => void
  /** Agent settings wherever that agent's editor lives: its DM, or this page. */
  onEditAgent: (agentId: string) => void
  onDialogChange: (open: boolean) => void
}) {
  // The modal itself is not lazy, so a page that fails to load or throws shows Try again
  // inside a Settings that still closes, never over a workspace left inert behind it.
  return (
    <SettingsView
      section={location.section}
      onSection={(section) => settings.open(section)}
      onClose={settings.close}
      leaving={settings.leaving}
      onDiscard={settings.discard}
      onKeepEditing={settings.keepEditing}
    >
      <ViewBoundary resetKey={location.section} loading={<p className="m-0 px-8 pt-10 text-label text-dim">Opening…</p>}>
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
    </SettingsView>
  )
}
