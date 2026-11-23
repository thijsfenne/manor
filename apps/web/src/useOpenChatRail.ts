import { useEffect, useMemo } from 'react'
import { isOpenRoom, type Chat, type DesktopBrowserBridge } from '@manor/contracts'
import { chatRailItems, type RailItem } from './components/RightRail'
import { chatRoster } from './chatRoster'
import { chatHelperFlags } from './chatHelpers'
import { chatHasRepo } from './sessionRepo'
import { isProjectThread, participantIds, repoListingKey, roomOf, type ThreadShape } from './state'
import type { NewChatDraft } from './useChatDialogs'
import { offeredLayout, offeredPanels, type useRightPanel } from './useRightPanel'
import type { Manor } from './useWorkspace'

/**
 * What the open chat's rail offers and which files it can browse, and the repo state its
 * composer reads: the `@` menu's file listing and the checkout row. While a draft fills
 * the stage, its project is the one the composer types into.
 */
export function useOpenChatRail({
  manor,
  open,
  thread,
  newChatDraft,
  draftProjectId,
  splitShown,
  phone,
  hasVault,
  browserBridge,
  rightPanel,
  roomThreadOf,
  subagentPath,
}: {
  manor: Manor
  open: Chat | null
  thread: ThreadShape
  newChatDraft: NewChatDraft | null
  draftProjectId: string | undefined
  /** A split is on screen, which keeps the open chat on the stage beside a draft. */
  splitShown: boolean
  phone: boolean
  hasVault: boolean
  browserBridge: DesktopBrowserBridge | undefined
  rightPanel: ReturnType<typeof useRightPanel>
  roomThreadOf: (chatId: string) => string | undefined
  /** The subagent view open over a chat: the door lists the level on stage. */
  subagentPath: (chatId: string) => readonly string[]
}) {
  const { workspace, status } = manor
  const openProject = roomOf(workspace, open?.projectId)
  /** Who the agents panel lists for the chat on screen, and in what order. */
  const activeAgentIds = useMemo(
    () => (open !== null && isOpenRoom(open) ? participantIds(thread) : (open?.memberIds ?? [])),
    [open, thread],
  )
  const rosterAgents = useMemo(
    () => chatRoster(workspace.agents, open, activeAgentIds),
    [workspace.agents, open, activeAgentIds],
  )
  const draftProject = roomOf(workspace, draftProjectId)
  // Whichever composer is on screen types into exactly one project, and that is the
  // project whose files its `@` menu may offer. The two stages never render together,
  // so one value serves both.
  const composerProject = newChatDraft !== null ? draftProject : openProject
  const composerProjectId = composerProject?.id
  const composerChatId = newChatDraft === null ? open?.id : undefined

  // Re-listed rather than cached for the session: the listing is one `git ls-files`,
  // and a menu offering files that were renamed an hour ago is worse than the round
  // trip. Opening a chat re-lists as well as switching project, so a file written
  // during the previous chat is mentionable in the next one; so does a change to the
  // folder list, instead of leaving an unlinked folder's files on offer. Checkout is
  // in the key so isolating a chat re-lists the worktree.
  const repoKey = `${composerProject?.repoPaths.join('\0') ?? ''}\0${open?.checkout.mode ?? ''}\0${open?.checkout.branch ?? ''}`
  useEffect(() => {
    if (composerProjectId === undefined || status !== 'live') return
    manor.listRepoFiles(composerProjectId, composerChatId)
  }, [composerProjectId, composerChatId, repoKey, status, manor.listRepoFiles])

  /**
   * Where the open chat writes, asked for rather than pushed: dirt and a leftover
   * directory cost a `git status` per folder, and the composer row is the only thing
   * that reads them. Re-asked when the chat changes and when its checkout does, so a
   * switch made in another tab cannot leave this row describing the old one; the menu
   * asks again as it opens, which is when dirt has to be current.
   */
  const checkoutChatId =
    newChatDraft === null && open?.kind === 'project' && open.routineId === null ? open.id : undefined
  const checkoutKey = `${open?.checkout.mode ?? ''}\0${open?.checkout.branch ?? ''}\0${openProject?.repoPaths.join('\0') ?? ''}`
  useEffect(() => {
    if (checkoutChatId === undefined || status !== 'live') return
    manor.askCheckoutStatus(checkoutChatId)
  }, [checkoutChatId, checkoutKey, status, manor.askCheckoutStatus])

  /**
   * Whether the open chat is what the stage shows. A draft fills the whole stage unless a
   * split is on screen; a stored split that is not (parked under the other list, or below
   * the split floor) does not count.
   */
  const stageShowsOpen = newChatDraft === null || splitShown
  const filesProjectId = stageShowsOpen ? openProject?.id : undefined
  const filesChatId = stageShowsOpen ? open?.id : undefined
  const filesRepoKey = stageShowsOpen ? (openProject?.repoPaths.join('\0') ?? '') : ''
  const filesListingKey =
    filesProjectId === undefined ? undefined : repoListingKey(filesProjectId, filesChatId)
  const canBrowseFiles = filesProjectId !== undefined && filesRepoKey !== '' && status === 'live'
  const fileListing = filesListingKey === undefined ? undefined : workspace.repoFiles[filesListingKey]

  /**
   * The rail only offers what this chat can show. A group and a room with no linked
   * folders have nothing to browse, so Files is absent rather than present and dead.
   * A DM gets its stored conversation memory instead of project memory. Browser and
   * side chat are shared surfaces, so they remain available across chat kinds.
   */
  // Flags first, so the list keeps its identity while a reply streams: the rail and the
  // header under it would otherwise redraw on every token.
  const hasRepo = open !== null && chatHasRepo(workspace, open)
  const projectThread = open !== null && isProjectThread(workspace, open.id)
  const roomSession = open !== null && roomThreadOf(open.id) !== undefined
  const hasProject = openProject !== undefined
  const hasRoster = rosterAgents.length > 0
  const hasBrowser = browserBridge !== undefined
  const hasSimulator = workspace.houseSettings?.simulator === true
  const { hasHelpers, helpersRunning } = open === null ? { hasHelpers: false, helpersRunning: false } : chatHelperFlags(workspace, thread, open, subagentPath(open.id))
  const railItems: RailItem[] = useMemo(
    () => open === null
      ? []
      : chatRailItems(open, {
          phone,
          singleChat: open.mode === 'single',
          hasProject,
          canBrowseFiles,
          hasVault,
          hasBrowser,
          hasRoster,
          hasRepo,
          projectThread,
          roomSession,
          hasHelpers,
          helpersRunning,
          hasSimulator,
        }),
    [open, phone, hasProject, canBrowseFiles, hasVault, hasBrowser, hasRoster, hasRepo, projectThread, roomSession, hasHelpers, helpersRunning, hasSimulator],
  )
  /** What this chat shows of what it remembers, see `offeredLayout`. */
  const activeLayout = offeredLayout(rightPanel.layout, offeredPanels(railItems, phone))
  /**
   * No chat on screen, no rail: there is nothing for any panel to be about. A DM has
   * no agents or files door because both would repeat context already in its header,
   * but it keeps the rail for its memory and the shared browser and side chat.
   */
  const railShown =
    open !== null && railItems.length > 0 && stageShowsOpen

  return { railItems, activeLayout, railShown, canBrowseFiles, fileListing }
}
