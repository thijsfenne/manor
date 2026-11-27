import { DEFAULT_USER_PROFILE } from '@manor/contracts'
import { mailWantsALook } from '@manor/client-runtime/mail'
import { DEFAULT_PROFILE_PHOTO } from '../AccountPopover'
import { NavRail, type DoorAttention } from '../NavRail'
import type { useProviderUpdates } from '../ProviderUpdates'
import type { NavDestination } from '../../navDestination'
import { routinesNeedAttention } from '../../routines'
import { railPins, type ChatListRow, type Inbox } from '../../state'
import type { useSettingsDoors } from './SettingsLayer'
import type { useTheme } from '../../useTheme'
import type { Manor } from '../../useWorkspace'

/**
 * The rail with what its doors and pinned faces show: who is waiting or unread, and which
 * door the stage is behind. The rail stays beside Settings, so its doors leave Settings
 * on the way out.
 */
export function WorkspaceNavRail({
  manor,
  chatRows,
  chatInbox,
  destination,
  stageAgentId,
  usageActive,
  providerUpdates,
  theme,
  phone,
  hasVault,
  hasReminders,
  hasArtifacts,
  hasBrowser,
  hasMail,
  doors,
  onSelect,
  onOpenUsage,
  onOpenPin,
}: {
  manor: Manor
  chatRows: ChatListRow[]
  chatInbox: Inbox
  destination: NavDestination | null
  /** The DM persona on the stage, sent or still a draft, so her face can hold the marker. */
  stageAgentId: string | null
  usageActive: boolean
  providerUpdates: ReturnType<typeof useProviderUpdates>['railEntries']
  theme: ReturnType<typeof useTheme>
  phone: boolean
  hasVault: boolean
  hasReminders: boolean
  hasArtifacts: boolean
  hasBrowser: boolean
  hasMail: boolean
  doors: ReturnType<typeof useSettingsDoors>
  onSelect: (destination: NavDestination) => void
  onOpenUsage: () => void
  onOpenPin: (agentId: string) => void
}) {
  const { workspace } = manor
  // Waiting outranks everything, because it is the one state that stalls until the user acts.
  const agentsAttention: DoorAttention = chatRows.some((row) => row.kind !== 'pair' && row.waiting)
    ? 'waiting'
    : chatRows.some((row) => row.kind === 'dm' && row.unread) ? 'unread' : null
  // Done is `unread && !running`, the same reading the Sessions list gives its rows.
  const sessionsAttention: DoorAttention = chatInbox.unsettled.some((row) => row.waiting)
    ? 'waiting'
    : chatInbox.unsettled.some((row) => row.unread && !row.running) ? 'done' : null
  const railFaces = railPins(workspace.agents).map((agent) => {
    const row = chatRows.find((candidate) => candidate.kind === 'dm' && candidate.agentId === agent.id)
    return {
      agent,
      unread: row?.unread ?? false,
      running: row?.running ?? false,
      waiting: row?.waiting ?? false,
      preview: row?.preview ?? '',
      fromUser: row?.chat?.lastMessageFromUser,
      lastMessageAt: row?.lastMessageAt ?? null,
    }
  })
  const routineAttention = routinesNeedAttention(workspace.routines)
  const { leaveSettingsThen } = doors
  const railSelect = leaveSettingsThen(onSelect)
  const railOpenUsage = leaveSettingsThen(onOpenUsage)
  const railOpenPin = leaveSettingsThen(onOpenPin)
  const { profile } = workspace
  const railProfile = { name: profile?.name ?? DEFAULT_USER_PROFILE.name, photo: profile?.avatar ?? DEFAULT_PROFILE_PHOTO }

  return (
    <NavRail
      destination={destination}
      hasVault={hasVault}
      hasReminders={hasReminders}
      hasArtifacts={hasArtifacts}
      hasBrowser={hasBrowser}
      hasMail={hasMail}
      mailAttention={mailWantsALook(workspace.mail)}
      agentsAttention={agentsAttention}
      routineAttention={routineAttention}
      sessionsAttention={sessionsAttention}
      pluginsAttention={workspace.composioKey === 'none'}
      pins={railFaces}
      stageAgentId={stageAgentId}
      providerUsage={workspace.providerUsage}
      providerConnections={workspace.providerConnections}
      usageActive={usageActive}
      providerUpdates={providerUpdates}
      onUpdateProviders={manor.updateProviders}
      profile={railProfile}
      theme={theme}
      mobile={phone}
      onSelect={railSelect}
      onOpenUsage={railOpenUsage}
      onOpenSettings={doors.openSettings}
      onOpenPin={railOpenPin}
    />
  )
}
