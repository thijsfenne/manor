import { Suspense, type ReactNode } from 'react'
import { composioBinding } from '../connectors/composioCatalogue'
import type { ProviderUpdate } from '@manor/contracts'
import { retryableLazy } from '../RecoveryBoundary'
import type { Manor } from '../../useWorkspace'
import type { ThemeChoice } from '../../useTheme'
import type { SettingsController } from '../../useSettings'
import { AgentsPage } from './AgentsPage'
import { ModelsPage } from './ModelsPage'
import { AutoRulesPage } from './AutoRulesPage'
import { ContextFilesPage } from './ContextFilesPage'
import { AppearancePage, GeneralPage, KeybindingsPage } from './PersonalPages'
import type { SettingsLocation } from './sections'
import { SettingsView } from './SettingsView'
import { PhonePage } from './PhonePage'
import { PermissionsPage } from './PermissionsPage'
import { StoragePage } from './StoragePage'
import { SubagentsPage } from './SubagentsPage'
import { VoicePage } from './VoicePage'
import { AboutPage, MemoryPage, ProvidersPage } from './SystemPages'
import { desktopPermissions } from '../../desktopBrowser'

const UsageView = retryableLazy(() => import('../usage/UsageView').then((module) => module.UsageView))
const ConnectorsView = retryableLazy(() => import('../connectors/ConnectorsView').then((module) => module.ConnectorsView))
const SkillsView = retryableLazy(() => import('../skills/SkillsView').then((module) => module.SkillsView))

interface SettingsHostProps {
  location: SettingsLocation
  settings: SettingsController
  manor: Manor
  theme: { choice: ThemeChoice; set: (choice: ThemeChoice) => void }
  account?: { onForget: () => void }
  providerUpdates: readonly ProviderUpdate[]
  /** The New agent door, which leaves Settings for the short form. */
  onNewAgent: () => void
  /** Leaves Settings for the agent's DM with its settings open, or opens them here. */
  onEditAgent: (agentId: string) => void
  /** Dialogs inside the reused registry views own the shared notice while open. */
  onDialogChange: (open: boolean) => void
}

/** Every Settings page, each reading and writing the setting it names. */
export function SettingsHost({
  location,
  settings,
  manor,
  theme,
  account,
  providerUpdates,
  onNewAgent,
  onEditAgent,
  onDialogChange,
}: SettingsHostProps) {
  const { workspace } = manor
  const common = { notice: workspace.notice, onDismissNotice: manor.dismissNotice }

  const page = (): ReactNode => {
    switch (location.section) {
      case 'general':
        return (
          <GeneralPage
            agents={workspace.agents}
            profile={workspace.profile}
            {...(account === undefined ? {} : { account })}
            requestEvents={manor.requestEvents}
            onSaveAgent={manor.saveAgent}
            onSaveProfile={manor.saveProfile}
            settings={workspace.houseSettings}
            onSaveSettings={manor.saveHouseSettings}
            info={workspace.systemInfo}
            onRequestInfo={manor.requestSystemInfo}
            {...common}
          />
        )
      case 'appearance':
        return <AppearancePage choice={theme.choice} onChange={theme.set} />
      case 'keybindings':
        return <KeybindingsPage />
      case 'voice':
        return <VoicePage settings={workspace.houseSettings} onSave={manor.saveHouseSettings} />
      case 'usage':
        return (
          <UsageView
            title="Usage & limits"
            report={workspace.usageReport}
            providerUsage={workspace.providerUsage}
            status={manor.status}
            onLoadReport={manor.loadUsageReport}
            onRefreshLimits={manor.refreshProviderUsage}
          />
        )
      case 'agents':
        return (
          <AgentsPage
            agentId={location.agentId}
            chats={workspace.chats}
            agents={workspace.agents}
            registry={workspace.mcpServers}
            skills={workspace.skills}
            routines={workspace.routines}
            subagentPolicy={workspace.subagentPolicy}
            status={manor.status}
            requestEvents={manor.requestEvents}
            onSelect={(agentId) => settings.open('agents', agentId)}
            onOpenDm={onEditAgent}
            onNewAgent={onNewAgent}
            onSaveAgent={manor.saveAgent}
            onDeleteAgent={manor.deleteAgent}
            onSaveSubagentPolicy={manor.saveSubagentPolicy}
            onRequestSubagentPolicy={manor.requestSubagentPolicy}
            onLoadNotes={manor.getAgentNotes}
          />
        )
      case 'context':
        return (
          <ContextFilesPage
            files={workspace.contextFiles}
            requestEvents={manor.requestEvents}
            onRequest={manor.requestContextFiles}
            onSave={manor.saveContextFile}
            onDirtyChange={settings.reportDirty}
            {...common}
          />
        )
      case 'auto':
        return (
          <AutoRulesPage
            rules={workspace.autoRules}
            requestEvents={manor.requestEvents}
            onSave={manor.saveAutoRules}
            onRequest={manor.requestAutoRules}
            onDirtyChange={settings.reportDirty}
            {...common}
          />
        )
      case 'subagents':
        return (
          <SubagentsPage
            policy={workspace.subagentPolicy}
            onRequest={manor.requestSubagentPolicy}
            onSave={(policy) => manor.saveSubagentPolicy(policy)}
            {...common}
          />
        )
      case 'models':
        return (
          <ModelsPage
            settings={workspace.houseSettings}
            connections={workspace.providerConnections}
            onCheck={manor.checkProviders}
            onSave={(next) => manor.saveHouseSettings(next)}
            {...common}
          />
        )
      case 'providers':
        return (
          <ProvidersPage
            info={workspace.systemInfo}
            updates={providerUpdates}
            connections={workspace.providerConnections}
            onRequest={manor.requestSystemInfo}
            onUpdate={manor.updateProviders}
            onCheck={manor.checkProviders}
            onSignIn={manor.signInProvider}
            onCancelSignIn={manor.cancelProviderSignIn}
            onInstall={manor.installProvider}
          />
        )
      case 'memory':
        return (
          <MemoryPage
            info={workspace.systemInfo}
            settings={workspace.houseSettings}
            connections={workspace.providerConnections}
            onRequest={manor.requestSystemInfo}
            onCheck={manor.checkProviders}
            onSave={manor.saveHouseSettings}
            onReveal={manor.revealFolder}
          />
        )
      case 'connections':
        return (
          <ConnectorsView
            agents={workspace.agents}
            registry={workspace.mcpServers}
            hostStatuses={workspace.mcpHostStatuses}
            mymind={workspace.artifacts.connection}
            requestEvents={manor.requestEvents}
            onSave={manor.saveMcpServer}
            onVerify={manor.verifyMcpServer}
            onVerifyMyMind={manor.verifyMyMind}
            onDelete={manor.deleteMcpServer}
            onDialogChange={onDialogChange}
            live={manor.status === 'live'}
            composio={composioBinding(manor)}
            {...common}
          />
        )
      case 'skills':
        return (
          <SkillsView
            agents={workspace.agents}
            skills={workspace.skills}
            candidates={workspace.skillCandidates}
            requestEvents={manor.requestEvents}
            onListCandidates={manor.listSkillCandidates}
            onImport={manor.importSkill}
            onDelete={manor.deleteSkill}
            onDialogChange={onDialogChange}
            {...common}
          />
        )
      case 'phone':
        return (
          <PhonePage
            access={workspace.phoneAccess}
            pairingLink={workspace.pairingLink}
            requestEvents={manor.requestEvents}
            onRequest={manor.requestPhoneAccess}
            onSetServing={manor.setTailscaleServe}
            onCreateLink={manor.createPairingLink}
            onRevoke={manor.revokeDevice}
            {...common}
          />
        )
      case 'permissions':
        return <PermissionsPage bridge={desktopPermissions()} />
      case 'storage':
        return (
          <StoragePage
            settings={workspace.houseSettings}
            archivedAt={workspace.chats.flatMap((chat) => chat.kind === 'project' && chat.archivedAt !== null ? [chat.archivedAt] : [])}
            requestEvents={manor.requestEvents}
            onSave={manor.saveHouseSettings}
            {...common}
          />
        )
      case 'about':
        return <AboutPage info={workspace.systemInfo} onRequest={manor.requestSystemInfo} onRevealLog={manor.revealLog} {...common} />
    }
  }

  return (
    <SettingsView
      section={location.section}
      onSection={(section) => settings.open(section)}
      onClose={settings.close}
      leaving={settings.leaving}
      onDiscard={settings.discard}
      onKeepEditing={settings.keepEditing}
    >
      <Suspense fallback={<p className="m-0 px-8 pt-10 text-label text-dim">Opening…</p>}>
        {/* Keyed per page, so a page's own draft never carries into the next one. */}
        <div key={location.section} className="h-full min-h-0">{page()}</div>
      </Suspense>
    </SettingsView>
  )
}
