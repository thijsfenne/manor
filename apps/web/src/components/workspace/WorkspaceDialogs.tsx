import type { Chat } from '@manor/contracts'
import { DialogBoundary, retryableLazy } from '../RecoveryBoundary'
import type { ProjectDialogState } from '../projects/ProjectDialogHost'
import { SessionAgentsDialog } from '../SessionAgentsDialog'
import { SearchDialog } from '../SearchDialog'
import { ChatSwitcher } from '../ChatSwitcher'
import type { RightPanelId } from '../../useRightPanel'
import type { GroupDialogState } from '../../useChatDialogs'
import type { useChatSwitcher } from '../../useChatSwitcher'
import type { useRevealRequests } from '../../useRevealRequests'
import { chatOf, type ChatListRow, type Inbox } from '../../state'
import type { Manor } from '../../useWorkspace'

// Dialogs that exist only while open, kept out of the first chunk.
const ProjectDialogHost = retryableLazy(() => import('../projects/ProjectDialogHost').then((module) => module.ProjectDialogHost))
const GroupDialog = retryableLazy(() => import('../chats/GroupDialog').then((module) => module.GroupDialog))

/**
 * The workspace's modal layer: the project and group dialogs, the Session agents list,
 * the ⌘K palette and the Ctrl+Tab switcher. Each renders only while it is open; which
 * one is open is `Workspace`'s, because the sidebar and the shortcuts open them.
 */
export function WorkspaceDialogs({
  manor,
  chatRows,
  chatInbox,
  runsByRoutine,
  open,
  projectDialog,
  onCloseProjectDialog,
  managingAgents,
  onCloseManagingAgents,
  onEditAgent,
  onNewSessionAgent,
  groupDialog,
  onCloseGroup,
  onCreateGroup,
  searchOpen,
  onCloseSearch,
  canStartChat,
  canOpenNoteBeside,
  reveals,
  onStartChat,
  onOpenChat,
  onShowPanel,
  onOpenKnowledge,
  onOpenReminders,
  switcher,
}: {
  manor: Manor
  chatRows: ChatListRow[]
  chatInbox: Inbox
  runsByRoutine: Record<string, Chat[]>
  /** The chat on the stage, beside which a note may open. */
  open: Chat | null
  projectDialog: ProjectDialogState | null
  onCloseProjectDialog: () => void
  managingAgents: boolean
  onCloseManagingAgents: () => void
  onEditAgent: (agentId: string) => void
  onNewSessionAgent: () => void
  groupDialog: GroupDialogState | null
  onCloseGroup: () => void
  onCreateGroup: (memberIds: string[], name: string, requestId?: string) => boolean
  searchOpen: boolean
  onCloseSearch: () => void
  canStartChat: boolean
  canOpenNoteBeside: boolean
  reveals: ReturnType<typeof useRevealRequests>
  onStartChat: () => void
  onOpenChat: (chatId: string) => void
  onShowPanel: (chatId: string, panel: RightPanelId) => void
  onOpenKnowledge: () => void
  onOpenReminders: () => void
  switcher: ReturnType<typeof useChatSwitcher>
}) {
  const { workspace, status } = manor
  return (
    <>
      {projectDialog === null ? null : (
        <DialogBoundary onClose={onCloseProjectDialog}>
        <ProjectDialogHost
          // Keyed on which project it is about, so every opening starts from a
          // freshly seeded draft rather than the previous one's leftovers.
          key={projectDialog.mode === 'create' ? 'create' : projectDialog.projectId}
          dialog={projectDialog}
          projects={workspace.projects}
          notice={workspace.notice}
          requestEvents={manor.requestEvents}
          dirs={workspace.dirs}
          onNewProject={manor.createProject}
          onUpdateProject={manor.updateProject}
          repoIcons={workspace.repoIcons}
          onFindRepoIcon={manor.findRepoIcon}
          onListDirs={manor.listDirs}
          onCloseDirs={manor.closeDirs}
          onDismissNotice={manor.dismissNotice}
          onClose={onCloseProjectDialog}
          onDeleteProject={manor.deleteProject}
        />
        </DialogBoundary>
      )}

      {!managingAgents ? null : (
        <SessionAgentsDialog
          agents={workspace.agents}
          onEdit={(agentId) => { onCloseManagingAgents(); onEditAgent(agentId) }}
          onNewSessionAgent={onNewSessionAgent}
          onClose={onCloseManagingAgents}
        />
      )}

      {groupDialog === null ? null : (
        <DialogBoundary onClose={onCloseGroup}>
        {groupDialog.mode === 'create' ? (
        <GroupDialog
          mode="create"
          agents={workspace.agents}
          members={[]}
          notice={workspace.notice}
          requestEvents={manor.requestEvents}
          onSubmit={onCreateGroup}
          onClose={onCloseGroup}
        />
      ) : (
        <GroupDialog
          // Keyed on the group, so every opening starts from that group's own members
          // rather than the previous one's.
          key={groupDialog.chatId}
          mode="edit"
          agents={workspace.agents}
          members={chatOf(workspace, groupDialog.chatId)?.memberIds ?? []}
          title={chatOf(workspace, groupDialog.chatId)?.title ?? ''}
          notice={workspace.notice}
          requestEvents={manor.requestEvents}
          onSubmit={(memberIds) => {
            onCloseGroup()
            return manor.setChatMembers(groupDialog.chatId, memberIds)
          }}
          onDelete={() => {
            onCloseGroup()
            manor.deleteChat(groupDialog.chatId)
          }}
          onClose={onCloseGroup}
        />
        )}
        </DialogBoundary>
      )}

      {!searchOpen ? null : (
        <SearchDialog
          chats={chatRows}
          inbox={chatInbox}
          runs={runsByRoutine}
          agents={workspace.agents}
          reminders={workspace.reminders}
          connected={status === 'live'}
          search={manor.search}
          requestEvents={manor.requestEvents}
          onLoadReminders={manor.loadReminders}
          canStartChat={canStartChat}
          canOpenNoteBeside={canOpenNoteBeside}
          onStartChat={() => {
            onCloseSearch()
            onStartChat()
          }}
          onOpenChat={(chatId) => {
            onCloseSearch()
            onOpenChat(chatId)
          }}
          onOpenMessage={(chatId, eventId) => {
            onCloseSearch()
            onOpenChat(chatId)
            reveals.reveal(chatId, { eventId })
          }}
          onOpenNote={(path, beside) => {
            onCloseSearch()
            if (beside && open !== null) {
              reveals.requestNote(path, open.id)
              onShowPanel(open.id, 'knowledge')
              return
            }
            reveals.requestNote(path, null)
            onOpenKnowledge()
          }}
          onOpenReminder={(reminderId) => {
            onCloseSearch()
            reveals.requestReminder(reminderId)
            onOpenReminders()
          }}
          onClose={onCloseSearch}
        />
      )}

      {!switcher.open ? null : (
        <ChatSwitcher
          items={switcher.items}
          highlightId={switcher.highlightId}
          agents={workspace.agents}
          onHover={switcher.highlight}
          onPick={switcher.pick}
          onCancel={switcher.cancel}
        />
      )}
    </>
  )
}
