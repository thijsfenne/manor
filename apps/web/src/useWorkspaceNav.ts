import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentConfig, Chat, Project, Routine } from '@manor/contracts'
import type { WorkspaceView } from './components/Sidebar'
import { desktopNotify } from './desktopBrowser'
import { inboxSettleLanding, isHomeRoom, type InboxChat } from './state'
import { landingChat, LEFT_ON_NEW_SESSION, sidebarViewForChat, type SidebarView } from './useSidebar'
import { readReloadLocation, useViewHistory, writeReloadLocation, type WorkspaceLocation } from './useViewHistory'
import type { NewChatDraft } from './useChatDialogs'
import type { Manor } from './useWorkspace'

/**
 * The workspace-wide shortcuts as a pure key-to-act map, so the bindings are
 * testable without a DOM. The hook owns what each act does and when it is
 * allowed; this only says which key asked. Letters are lowercased because Caps
 * Lock reports the capital while shiftKey stays false.
 */
export function workspaceShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>,
): 'back' | 'forward' | 'switch-list' | 'new-chat' | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) return null
  if (event.key === '[') return 'back'
  if (event.key === ']') return 'forward'
  const key = event.key.toLowerCase()
  if (key === 'd') return 'switch-list'
  if (key === 'n') return 'new-chat'
  return null
}

export function locationOf(
  activeView: WorkspaceView,
  chatId: string | null,
  draftTarget: NewChatDraft['target'] | undefined,
  routineDetailId: string | null,
): WorkspaceLocation | null {
  if (draftTarget !== undefined) return { kind: 'new-chat', target: draftTarget }
  switch (activeView) {
    case 'new-chat':
    case 'empty-chat':
      return null
    case 'chat':
      return chatId === null ? null : { kind: 'chat', chatId }
    case 'routines':
      return { kind: 'routines', routineId: routineDetailId }
    case 'skills':
    case 'connectors':
    case 'suggestions':
    case 'knowledge':
    case 'reminders':
    case 'mail':
    case 'artifacts':
    case 'browser':
    case 'usage':
      return { kind: activeView }
  }
}

interface WorkspaceNavInput {
  projects: readonly Project[]
  chats: readonly Chat[]
  agents: readonly AgentConfig[]
  routines: readonly Routine[]
  hasDirectory: boolean
  hasRoster: boolean
  hasVault: boolean
  hasVaultStatus: boolean
  hasArtifacts: boolean
  hasArtifactsStatus: boolean
  hasMail: boolean
  /** The host has said whether it has a mailbox. */
  hasMailStatus: boolean
  /** RemCTL or remindctl on this host. Announced on connect just before the vault status. */
  hasReminders: boolean
  /** The Electron host is present. Known at mount, so there is no pending status. */
  hasBrowser: boolean
  hasRoutines: boolean
  /** The same gate the sidebar's New chat button wears, so the shortcut never opens a stage the button would not. */
  canStartChat: boolean
  sidebarView: SidebarView
  showSidebarView: (view: SidebarView) => void
  openChatOnServer: (chatId: string) => void
  dismissNotice: () => void
  listSkillCandidates: () => boolean
  listWorkflowSuggestions: () => boolean
  listMyMindObjects: (query?: string) => boolean
  setChatSettledOnServer: (chatId: string, settled: boolean) => boolean
  /** True when the split owns the landing after a successful settle; a chat id to open that chat instead of an empty pane. */
  onChatSettled?: (chatId: string) => boolean | string
  /** Where Sessions returns instead of the chat it was left on: a project thread whose split stands there. */
  inboxReturnId?: string | null
  createChat: Manor['createChat']
  showRunPanel: (chatId: string, panel: 'runs') => void
  beginDraft: (target: NewChatDraft['target']) => void
  clearDraft: () => void
  newChatProject: Project | undefined
  selected: Chat | null
  selectedChat: Chat | null
  unsettledInbox: readonly InboxChat[]
  draftTarget: NewChatDraft['target'] | undefined
}

/**
 * Which view the stage is on, and every callback that points it somewhere else.
 * Dialogs own the draft those callbacks write into; history is the in-app back
 * stack this sits on.
 */
export function useWorkspaceNav({
  projects,
  chats,
  agents,
  routines,
  hasDirectory,
  hasRoster,
  hasVault,
  hasVaultStatus,
  hasArtifacts,
  hasArtifactsStatus,
  hasReminders,
  hasMail,
  hasMailStatus,
  hasBrowser,
  hasRoutines,
  canStartChat,
  sidebarView,
  showSidebarView,
  openChatOnServer,
  dismissNotice,
  listSkillCandidates,
  listWorkflowSuggestions,
  listMyMindObjects,
  setChatSettledOnServer,
  onChatSettled,
  inboxReturnId = null,
  createChat,
  showRunPanel,
  beginDraft,
  clearDraft,
  newChatProject,
  selected,
  selectedChat,
  unsettledInbox,
  draftTarget,
}: WorkspaceNavInput) {
  const [reloadLocation] = useState(readReloadLocation)
  const pendingReload = useRef(reloadLocation)
  const [activeView, setActiveView] = useState<WorkspaceView>('chat')
  const [acceptedWorkId, setAcceptedWorkId] = useState<string | null>(null)
  /** Null is the routines index; an id is the Claude-style full routine view. */
  const [routineDetailId, setRoutineDetailId] = useState<string | null>(null)
  const viewHistory = useViewHistory()
  /**
   * The chat each list was left on, so switching back lands where it was rather than
   * on the list's first row. Written from the selection itself rather than from the
   * click, because a chat also opens without one (a created chat lands, a restored
   * session arrives). A ref because nothing renders from it, it is only read at the
   * moment the lists swap. The current destination is restored separately across a
   * reload; the other list's remembered selection lasts until that reload.
   */
  const lastChatByView = useRef<Record<SidebarView, string | null>>({ chats: null, inbox: null })

  // Keyed on the id and kind, not the object: a directory refresh hands over the same
  // chat as a new object, and that is no navigation that may overwrite a list's memory.
  const selectedId = selectedChat?.id ?? null
  const selectedKind = selectedChat?.kind ?? null
  useEffect(() => {
    // A Browser session opened on the stage is in neither list, so it is no list's return point.
    if (selectedId === null || selectedKind === null || selectedKind === 'browser') return
    lastChatByView.current[sidebarViewForChat(selectedKind)] = selectedId
  }, [selectedId, selectedKind])

  /**
   * Sessions left on its New session stage comes back to that stage, not to the thread
   * the draft was started over. Leaving the stage for another rail door or the Agents
   * list keeps the mark; leaving it inside Sessions (a row, a closed draft pane) drops
   * it for the thread now on the stage, which may be the very one under the draft and
   * so never re-announces itself as a new selection.
   */
  useEffect(() => {
    if (draftTarget?.kind === 'project') {
      lastChatByView.current.inbox = LEFT_ON_NEW_SESSION
      return
    }
    if (lastChatByView.current.inbox !== LEFT_ON_NEW_SESSION || draftTarget !== undefined) return
    if (sidebarView !== 'inbox' || (activeView !== 'chat' && activeView !== 'empty-chat')) return
    lastChatByView.current.inbox = selectedKind === 'project' && activeView === 'chat' ? selectedId : null
  }, [draftTarget, sidebarView, activeView, selectedId, selectedKind])

  // The Knowledge tab exists only where the vault does, which is the user's Mac and not
  // the VPS. A tab that disappears under an open panel takes the panel with it,
  // rather than leaving a view pointed at a folder this server cannot reach.
  useEffect(() => {
    if (!hasVault && activeView === 'knowledge') setActiveView('chat')
  }, [hasVault, activeView])

  useEffect(() => {
    if (!hasArtifacts && activeView === 'artifacts') setActiveView('chat')
  }, [hasArtifacts, activeView])

  useEffect(() => {
    if (!hasReminders && activeView === 'reminders') setActiveView('chat')
  }, [hasReminders, activeView])

  useEffect(() => {
    if (!hasMail && activeView === 'mail') setActiveView('chat')
  }, [hasMail, activeView])

  useEffect(() => {
    if (!hasBrowser && activeView === 'browser') setActiveView('chat')
  }, [hasBrowser, activeView])

  const routineDetail =
    routineDetailId === null ? undefined : routines.find((routine) => routine.id === routineDetailId)

  // A routine deleted from its own detail view leaves through the same index door it entered.
  useEffect(() => {
    if (routineDetailId !== null && hasRoutines && routineDetail === undefined) {
      setRoutineDetailId(null)
    }
  }, [routineDetailId, routineDetail, hasRoutines])

  const showChat = useCallback(() => setActiveView('chat'), [])
  const showEmptyChat = useCallback(() => setActiveView('empty-chat'), [])

  // Everything the sidebar is handed is a `useCallback`. The panel is memoised, and
  // one inline arrow among its props would re-render the whole list on every
  // streaming delta as surely as thirteen would.

  const openChat = useCallback(
    (chatId: string, acceptedWork = false) => {
      const chat = chats.find((candidate) => candidate.id === chatId) ?? null
      // Nothing outside the directory can be put on the stage: the usage report also
      // names chats that have since been deleted and side chats, which live only in
      // their panel, and opening one leaves the stage pointing at a thread no list
      // holds. Callers that can offer such a row say so before the click instead.
      if (chat === null) {
        if (acceptedWork) setAcceptedWorkId(chatId)
        return
      }
      setAcceptedWorkId(null)
      showSidebarView(sidebarViewForChat(chat.kind))
      if (chat.kind === 'run') showRunPanel(chat.id, 'runs')
      clearDraft()
      setActiveView('chat')
      openChatOnServer(chatId)
    },
    [chats, showSidebarView, openChatOnServer, showRunPanel, clearDraft],
  )

  // Accept can resolve into a callback that still holds the pre-creation directory.
  // Stay in the source chat until a render contains the confirmed Work target.
  useEffect(() => {
    if (acceptedWorkId !== null && chats.some((chat) => chat.id === acceptedWorkId)) {
      openChat(acceptedWorkId)
    }
  }, [acceptedWorkId, chats, openChat])

  /**
   * A clicked done notice lands on the chat it was about. This is the same
   * `openChat` the sidebar uses, so the stage, the sidebar view and the unread mark
   * all move exactly as they would have if the row had been clicked — the click is
   * the read, which is the whole reason the badge can be trusted.
   */
  useEffect(() => desktopNotify()?.onActivate(openChat), [openChat])

  const newChat = useCallback(
    (projectId: string) => {
      showSidebarView('inbox')
      beginDraft({ kind: 'project', projectId })
      setActiveView('new-chat')
    },
    [showSidebarView, beginDraft],
  )

  /**
   * A persona's own thread. One exists per persona and the server keeps it that way,
   * so an existing DM is opened and a persona who has none gets the stage addressed
   * to them — the chat itself is made by the first send, not by the click.
   */
  const openDm = useCallback(
    // `beside` keeps the sidebar list: a DM draft dropped into a Sessions split stays there.
    (agentId: string, beside = false) => {
      if (!beside) showSidebarView('chats')
      const existing = chats.find((chat) => chat.kind === 'dm' && chat.memberIds[0] === agentId)
      if (existing !== undefined) {
        openChat(existing.id)
        return
      }
      dismissNotice()
      beginDraft({ kind: 'dm', agentId })
      setActiveView('new-chat')
    },
    [chats, showSidebarView, openChat, dismissNotice, beginDraft],
  )

  /**
   * Each of the rail's doors leaves the stage the same way, so they differ
   * only in where they land. Written out rather than generated from a list, because
   * Skills also asks the server for its candidates on the way in.
   */
  const leaveStage = useCallback(() => {
    dismissNotice()
    clearDraft()
  }, [dismissNotice, clearDraft])

  const openSkills = useCallback(() => {
    leaveStage()
    setActiveView('skills')
    listSkillCandidates()
  }, [leaveStage, listSkillCandidates])

  const openConnectors = useCallback(() => {
    leaveStage()
    setActiveView('connectors')
  }, [leaveStage])

  const openSuggestions = useCallback(() => {
    leaveStage()
    setActiveView('suggestions')
    listWorkflowSuggestions()
  }, [leaveStage, listWorkflowSuggestions])

  const openPlugins = useCallback(() => {
    leaveStage()
    setActiveView((current) =>
      current === 'skills' || current === 'connectors' || current === 'suggestions'
        ? current
        : 'connectors')
  }, [leaveStage])

  // Nothing to ask for on the way in: the routines list arrives on connect and is
  // re-sent whole after every mutation, so it is already here.
  const openRoutines = useCallback(() => {
    leaveStage()
    setRoutineDetailId(null)
    setActiveView('routines')
  }, [leaveStage])

  const openRoutineDetail = useCallback(
    (routineId: string) => {
      leaveStage()
      setRoutineDetailId(routineId)
      setActiveView('routines')
    },
    [leaveStage],
  )

  const openKnowledge = useCallback(() => {
    leaveStage()
    setActiveView('knowledge')
  }, [leaveStage])

  const openBrowser = useCallback(() => {
    leaveStage()
    setActiveView('browser')
  }, [leaveStage])

  // The door asks for its own snapshot when it mounts, so nothing is fetched here.
  const openReminders = useCallback(() => {
    leaveStage()
    setActiveView('reminders')
  }, [leaveStage])

  // Like Reminders, the Mail door asks the host to look again when it mounts.
  const openMail = useCallback(() => {
    leaveStage()
    setActiveView('mail')
  }, [leaveStage])

  const openArtifacts = useCallback(() => {
    leaveStage()
    setActiveView('artifacts')
    listMyMindObjects()
  }, [leaveStage, listMyMindObjects])

  // The view asks for its own report as it mounts, for the window it shows.
  const openUsage = useCallback(() => {
    leaveStage()
    setActiveView('usage')
  }, [leaveStage])

  const startChat = useCallback(() => {
    if (newChatProject !== undefined) newChat(newChatProject.id)
  }, [newChatProject, newChat])

  /**
   * Settling the chat on screen advances through the inbox. A row settled while a
   * different chat is open still moves quietly, without stealing the stage.
   */
  const setChatSettled = useCallback(
    (chatId: string, settled: boolean) => {
      if (!setChatSettledOnServer(chatId, settled)) return false
      const landing = settled ? onChatSettled?.(chatId) : false
      if (typeof landing === 'string') {
        openChat(landing)
        return true
      }
      if (landing === true) {
        showEmptyChat()
        return true
      }
      if (!settled || sidebarView !== 'inbox' || selected?.id !== chatId) return true

      const next = inboxSettleLanding(unsettledInbox, selected)
      if (next?.kind === 'chat') openChat(next.chatId)
      if (next?.kind === 'new-chat' && newChatProject !== undefined) newChat(newChatProject.id)
      return true
    },
    [setChatSettledOnServer, onChatSettled, showEmptyChat, sidebarView, selected, unsettledInbox, openChat, newChatProject, newChat],
  )

  /**
   * A group is made whole rather than typed into: it has members before it has a
   * first message, so unlike a DM there is no draft stage. The server answers with
   * the chat, which opens itself.
   */
  const createGroup = (memberIds: string[], name: string, requestId?: string) => {
    if (requestId === undefined) return false
    const sent = createChat(
      { kind: 'group', memberIds, ...(name === '' ? {} : { title: name }) },
      undefined,
      undefined,
      undefined,
      requestId,
    )
    if (!sent) return false
    showSidebarView('chats')
    clearDraft()
    setActiveView('chat')
    return true
  }

  /**
   * These are navigation modes, not two filters over one still-active stage. Moving
   * between them therefore moves the stage too, back to the thread that list was left
   * on, else to the first valid one there. If that side has no thread yet, its natural
   * draft is the landing.
   */
  const showSidebarDestination = useCallback((next: SidebarView) => {
    pendingReload.current = null
    // A thread's split comes back as a visit on the thread; the room gives its right side back.
    const remembered = next === 'inbox' && inboxReturnId !== null && lastChatByView.current.inbox !== LEFT_ON_NEW_SESSION
      ? inboxReturnId : lastChatByView.current[next]
    const landing = landingChat(chats, next, remembered)
    if (landing !== undefined) {
      openChat(landing.id)
      return
    }
    if (next === 'inbox') {
      if (newChatProject !== undefined) {
        newChat(newChatProject.id)
        return
      }
    } else {
      const firstAgent = agents[0]
      if (firstAgent !== undefined) {
        openDm(firstAgent.id)
        return
      }
    }
    clearDraft()
    setActiveView('chat')
    showSidebarView(next)
  }, [chats, agents, newChatProject, inboxReturnId, openChat, newChat, openDm, showSidebarView, clearDraft])

  const switchSidebarView = useCallback(() => {
    showSidebarDestination(sidebarView === 'inbox' ? 'chats' : 'inbox')
  }, [sidebarView, showSidebarDestination])

  const stageLocation = useMemo(
    () => locationOf(activeView, selected?.id ?? null, draftTarget, routineDetailId),
    [activeView, selected?.id, draftTarget, routineDetailId],
  )

  const applyLocation = useCallback(
    (location: WorkspaceLocation) => {
      switch (location.kind) {
        case 'chat':
          openChat(location.chatId)
          return
        case 'new-chat':
          if (location.target.kind === 'project') newChat(location.target.projectId)
          else openDm(location.target.agentId)
          return
        case 'skills':
          openSkills()
          return
        case 'connectors':
          openConnectors()
          return
        case 'suggestions':
          openSuggestions()
          return
        case 'routines':
          if (location.routineId === null) openRoutines()
          else openRoutineDetail(location.routineId)
          return
        case 'knowledge':
          openKnowledge()
          return
        case 'reminders':
          openReminders()
          return
        case 'mail':
          openMail()
          return
        case 'artifacts':
          openArtifacts()
          return
        case 'browser':
          openBrowser()
          return
        case 'usage':
          openUsage()
          return
      }
    },
    [
      openChat,
      newChat,
      openDm,
      openSkills,
      openConnectors,
      openSuggestions,
      openRoutines,
      openRoutineDetail,
      openKnowledge,
      openReminders,
      openMail,
      openArtifacts,
      openBrowser,
      openUsage,
    ],
  )

  useEffect(() => {
    // An explicit choice made while connecting wins over the saved destination.
    if (activeView !== 'chat' || selectedChat !== null || draftTarget !== undefined) {
      pendingReload.current = null
      return
    }
    if (!hasDirectory || !hasRoster) return
    const saved = pendingReload.current
    if (saved !== null) {
      const location = saved.location
      if (location.kind === 'routines' && !hasRoutines) return
      // Host capabilities land just before the vault status, so that status also says
      // whether this host has Reminders.
      if ((location.kind === 'knowledge' || location.kind === 'reminders') && !hasVaultStatus) return
      if (location.kind === 'artifacts' && !hasArtifactsStatus) return
      if (location.kind === 'mail' && !hasMailStatus) return
      pendingReload.current = null
      const target = location.kind === 'new-chat' ? location.target : null
      const available = location.kind === 'chat'
        ? chats.some((chat) => chat.id === location.chatId)
        : target !== null
          ? target.kind === 'project'
            ? isHomeRoom(target.projectId) || projects.some((project) => project.id === target.projectId)
            : agents.some((agent) => agent.id === target.agentId)
          : location.kind === 'knowledge' ? hasVault
            : location.kind === 'reminders' ? hasReminders
            : location.kind === 'mail' ? hasMail
            : location.kind === 'artifacts' ? hasArtifacts
              : location.kind === 'browser' ? hasBrowser : true
      if (available) {
        showSidebarView(saved.sidebarView)
        applyLocation(location.kind === 'routines' && !routines.some((routine) => routine.id === location.routineId)
          ? { kind: 'routines', routineId: null } : location)
        return
      }
    }
    showSidebarDestination(sidebarView)
  }, [activeView, selectedChat, draftTarget, hasDirectory, hasRoster, hasRoutines, hasVaultStatus, hasArtifactsStatus, hasMail, hasMailStatus,
    chats, projects, agents, routines, hasVault, hasReminders, hasArtifacts, hasBrowser, showSidebarView, applyLocation, showSidebarDestination, sidebarView])

  useEffect(() => {
    if (stageLocation === null || pendingReload.current !== null) return
    viewHistory.record(stageLocation)
    writeReloadLocation({ location: stageLocation, sidebarView })
  }, [stageLocation, sidebarView, viewHistory.record])

  const goBack = useCallback(() => {
    const location = viewHistory.back()
    if (location !== null) applyLocation(location)
  }, [viewHistory.back, applyLocation])

  const goForward = useCallback(() => {
    const location = viewHistory.forward()
    if (location !== null) applyLocation(location)
  }, [viewHistory.forward, applyLocation])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = workspaceShortcut(event)
      if (shortcut === null) return
      // Dialogs claim their own shortcuts first; a key a control already spent is
      // not the workspace's to spend again behind it.
      if (event.defaultPrevented) return
      if (shortcut === 'back' && viewHistory.canBack) {
        event.preventDefault()
        goBack()
        return
      }
      if (shortcut === 'forward' && viewHistory.canForward) {
        event.preventDefault()
        goForward()
        return
      }
      if (shortcut === 'switch-list') {
        event.preventDefault()
        switchSidebarView()
        return
      }
      // In the Reminders door ⌘N makes a reminder; the door takes the key itself.
      if (shortcut === 'new-chat' && canStartChat && activeView !== 'reminders') {
        event.preventDefault()
        startChat()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewHistory.canBack, viewHistory.canForward, goBack, goForward, switchSidebarView, startChat, canStartChat, activeView])

  return {
    activeView,
    routineDetailId,
    routineDetail,
    showChat,
    showEmptyChat,
    openChat,
    openDm,
    newChat,
    startChat,
    openSkills,
    openConnectors,
    openSuggestions,
    openPlugins,
    openRoutines,
    openRoutineDetail,
    openKnowledge,
    openReminders,
    openMail,
    openArtifacts,
    openBrowser,
    openUsage,
    setChatSettled,
    createGroup,
    switchSidebarView,
    showSidebarDestination,
    goBack,
    goForward,
    canBack: viewHistory.canBack,
    canForward: viewHistory.canForward,
  }
}
