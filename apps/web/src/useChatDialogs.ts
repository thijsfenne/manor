import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type {
  ChatMode,
  ChatOverride,
  CheckoutRequest,
  InlineQuote,
  PageContextAttachment,
  SingleRuntime,
} from '@manor/contracts'
import type { ComposerAttachments } from '@manor/client-runtime/attachments'
import { offsetQuoteRefs, SINGLE_CHAT_VOICE } from '@manor/contracts'
import { NEW_CHAT_DRAFT_KEY, readDraft, writeDraft } from './composerDrafts'
import { stagedFromWire } from './imageMarks'
import type { ProjectDialogState } from './components/projects/ProjectDialogHost'
import { withOverride } from './runtimeChoices'
import { isHomeRoom, type Notice } from './state'
import { useRequest, type RequestEvents } from './useRequest'
import type { NewChatTarget } from './useWorkspace'

export interface NewChatDraft {
  /**
   * Where the chat will be made once something is said in it. A room, or a persona
   * to write to: a DM has no project, so the stage has no room to ask about and the
   * picker above the composer is left out entirely.
   */
  target: { kind: 'project'; projectId: string; mode?: ChatMode } | { kind: 'dm'; agentId: string }
  submitting: boolean
  previousChatId: string | null
  /**
   * Model/effort picked before the chat exists. Held here because there is no chat
   * id to pin them to yet; they travel with `create_chat` and are applied server
   * side before the opening message runs.
   */
  overrides: Record<string, ChatOverride>
  /** Isolation chosen on the new-chat stage. Current checkout is the default. */
  checkout: CheckoutRequest
  /**
   * The message that made the chat, from the send until the server answers with it.
   * The thread shows it in the meantime, so the chat stands there with its opening
   * line in it instead of the stage sitting frozen through a round trip. Null before
   * anything was sent, and on the send that was refused.
   */
  sent: SentDraft | null
  /** The create's request id while it is unanswered, so only its own refusal counts. */
  requestId?: string
  /**
   * Where the composer's box was standing at that send, in viewport pixels. Read in
   * the handler while the stage is still on screen, because a frame later it is gone.
   */
  travelFrom: number | null
}

type SentDraft = ComposerAttachments & { text: string; pageContexts: PageContextAttachment[]; quotes?: InlineQuote[] }

export type GroupDialogState = { mode: 'create' } | { mode: 'edit'; chatId: string }

/** What became of a send that left the new-chat stage. */
export type SubmittedDraftOutcome = 'waiting' | 'arriving' | 'born' | 'refused'

/**
 * Which of those a send is in, from the three things the server can have said back.
 *
 * A chat that landed wins over an error notice, and that order is the whole point.
 * The server answers a create that partly went wrong with both: "that chat was made,
 * but its model pin was not saved" comes back as an error, and the chat is created
 * and its opening message submitted regardless. Reading the notice first called that
 * a refusal, put a message that had already been sent back in the box, and invited
 * the user to send it a second time.
 *
 * A real refusal is the case where nothing else arrived: no pending chat, no open
 * chat, only the notice.
 */
export function submittedDraftOutcome({
  previousChatId,
  pendingChatId,
  openChatId,
  errorNotice,
}: {
  previousChatId: string | null
  pendingChatId: string | null
  openChatId: string | null
  errorNotice: boolean
}): SubmittedDraftOutcome {
  if (pendingChatId !== null && pendingChatId !== previousChatId) return 'arriving'
  if (openChatId !== null && openChatId !== previousChatId) return 'born'
  return errorNotice ? 'refused' : 'waiting'
}

/**
 * A fresh stage. A project chat starts as Single with Auto off, which is a runtime pin
 * rather than an absence (absent reads as Auto on). Multiple has no pins yet, so the
 * first switch to it arrives with Auto on.
 */
export function emptyNewChatDraft(target: NewChatDraft['target'], singleDefault?: SingleRuntime): NewChatDraft {
  const project = target.kind === 'project'
  return {
    target: project ? { mode: 'single', ...target } : target,
    submitting: false,
    previousChatId: null,
    overrides: project && singleDefault !== undefined ? { [SINGLE_CHAT_VOICE.id]: singleDefault } : {},
    checkout: { mode: 'current' },
    sent: null,
    travelFrom: null,
  }
}

/**
 * The composer slot a stage types into. The project stage keeps the shared new-chat
 * key (sources and "Discuss" write there); an unsent DM gets its own per persona, so
 * a refusal can put text back only in the draft it came from.
 */
export function stageDraftKey(target: NewChatDraft['target']): string {
  return target.kind === 'dm' ? `${NEW_CHAT_DRAFT_KEY}:dm:${target.agentId}` : NEW_CHAT_DRAFT_KEY
}

/**
 * Puts a refused create's text and attachments back in its own stage's box. That box
 * is locked while the create is unanswered, so its parked draft is normally empty;
 * text written into it from elsewhere ("Discuss") stays, after the refused text.
 */
export function restoreSentDraft(target: NewChatDraft['target'], sent: SentDraft): void {
  const current = readDraft(stageDraftKey(target))
  const sentQuotes = sent.quotes ?? []
  const currentQuotes = current.quotes ?? []
  // The refused quotes come first, so what arrived in the box meanwhile moves up past them.
  const added = offsetQuoteRefs(current.text, currentQuotes.length, sentQuotes.length)
  const typed = added.trim()
  writeDraft(stageDraftKey(target), {
    text: typed === '' ? sent.text : sent.text === '' ? added : `${sent.text}\n\n${added}`,
    images: [...stagedFromWire(sent.images), ...current.images],
    files: [...sent.files, ...current.files],
    documents: [...sent.documents, ...(current.documents ?? [])],
    quotes: [...sentQuotes, ...currentQuotes],
  })
}

/**
 * Whether a notice is this create's own refusal. A broadcast error (a Multiple pin
 * that did not save) can land before the ack and is not one.
 */
export function refusesCreate(notice: Notice | null, requestId: string | undefined): boolean {
  return notice?.kind === 'error' && requestId !== undefined && notice.requestId === requestId
}

/**
 * Why the new-chat stage cannot send, or '' when it can. Feeds the composer's
 * `canSend` and `blockedNote`, so the button and Enter share one gate. A Multiple
 * Session with no Session agent has nobody to seat, so it cannot start.
 */
export function draftBlockedNote(input: {
  live: boolean
  starting: boolean
  mode: 'single' | 'house' | undefined
  seatedAgents: number
}): string {
  if (!input.live) return 'Disconnected, sending is paused'
  if (input.starting) return 'Starting the chat…'
  if (input.mode === 'house' && input.seatedAgents === 0) return 'Add a session agent to start a Multiple session'
  return ''
}

/**
 * The unsent project stage, held for the lifetime of the tab the way its text is in
 * `composerDrafts`. Leaving the stage unmounts the draft, and coming back used to
 * rebuild it from defaults under text that had survived. A submitting draft is never
 * held, so the pre-send setup stays until the server has answered the create.
 */
let heldProjectDraft: NewChatDraft | null = null

/** Spent by the create's ack; also the test seam, like `clearDrafts`. */
export function forgetHeldProjectDraft(): void {
  heldProjectDraft = null
}

/**
 * What a project stage opens with: the held one if its project still exists, else a
 * fresh one for the room that was asked for. The held project wins over the asked
 * one, because every way back onto the stage asks for the default room, not a pick.
 */
export function resumeProjectDraft(
  target: Extract<NewChatDraft['target'], { kind: 'project' }>,
  projects: readonly { id: string }[],
  singleDefault: SingleRuntime,
): NewChatDraft {
  const held = heldProjectDraft
  if (held !== null && held.target.kind === 'project') {
    const heldProjectId = held.target.projectId
    if (isHomeRoom(heldProjectId) || projects.some((project) => project.id === heldProjectId)) return held
  }
  return emptyNewChatDraft(target, singleDefault)
}

const sameStage = (a: NewChatDraft['target'], b: NewChatDraft['target']) =>
  a.kind === 'project' ? b.kind === 'project' : b.kind === 'dm' && a.agentId === b.agentId

/**
 * What the stage opens with. A create still unanswered comes back as it was left,
 * sending, so the way back cannot send it a second time; its "before" becomes the
 * chat on screen now, or the chat left for would read as this create landing.
 */
export function reopenDraft(
  target: NewChatDraft['target'],
  inFlight: NewChatDraft | null,
  onScreenChatId: string | null,
  projects: readonly { id: string }[],
  singleDefault: SingleRuntime,
): NewChatDraft {
  if (inFlight !== null && sameStage(inFlight.target, target)) return { ...inFlight, previousChatId: onScreenChatId }
  return target.kind === 'project' ? resumeProjectDraft(target, projects, singleDefault) : emptyNewChatDraft(target)
}

/** The room the held stage is in, so "New chat" names the room it will reopen. */
export function heldProjectDraftId(): string | undefined {
  return heldProjectDraft?.target.kind === 'project' ? heldProjectDraft.target.projectId : undefined
}

/** Kept on every change of an unsent project draft, so any exit leaves it behind. */
export function holdProjectDraft(draft: NewChatDraft | null): void {
  if (draft === null || draft.submitting || draft.target.kind !== 'project') return
  heldProjectDraft = draft
}

export function draftWithMode(current: NewChatDraft | null, mode: ChatMode) {
  if (current === null || current.target.kind !== 'project') return current
  return {
    ...current,
    target: { ...current.target, mode },
  }
}

interface ChatDialogsInput {
  dismissNotice: () => void
  createChat: (
    target: NewChatTarget,
    openingMessage?: {
      text: string
      images: { name: string; dataUrl: string }[]
      pageContexts?: PageContextAttachment[]
      quotes?: InlineQuote[]
    },
    overrides?: Record<string, ChatOverride>,
    checkout?: CheckoutRequest,
    requestId?: string,
  ) => boolean
  /** Answers to requests, where the create's ack or refusal arrives by its id. */
  requestEvents: RequestEvents
  pendingChatId: string | null
  openChatId: string | null
  notice: Notice | null
  projects: readonly { id: string }[]
  agents: readonly { id: string }[]
  /** The runtime a fresh Single stage is pinned to, which is what Auto off means there. */
  singleDefault: SingleRuntime
  /** The chat the stage is about, which may still be pending confirmation. */
  stageChatId: string | null
  /** Whether that chat already has a row of its own, so the held opening line can go. */
  stageHasRows: boolean
  /**
   * Nav owns the view. Called when a draft should leave the stage: the target
   * vanished, a pending chat appeared, or the create landed.
   */
  showChatRef: MutableRefObject<() => void>
  /**
   * Puts source attachments back on the stage after a refused create. A ref for the
   * same reason `showChatRef` is one: the store that holds them is set up below this
   * hook, and a refusal that eats what you attached is as bad as one that eats what
   * you typed.
   */
  restorePageContextsRef: MutableRefObject<(key: string, contexts: PageContextAttachment[]) => void>
}

/**
 * The forms and drafts that sit above the stage: new-chat, the project and group
 * dialogs, search, and the short-lived opening message of a chat that was just made.
 * Nav decides which view is showing; this hook holds what those views are filling in.
 */
export function useChatDialogs({
  dismissNotice,
  createChat,
  requestEvents,
  pendingChatId,
  openChatId,
  notice,
  projects,
  agents,
  singleDefault,
  stageChatId,
  stageHasRows,
  showChatRef,
  restorePageContextsRef,
}: ChatDialogsInput) {
  const [newChatDraft, setNewChatDraft] = useState<NewChatDraft | null>(null)
  /** The stage composer's box, read in the send that takes the stage away. */
  const draftBoxRef = useRef<HTMLDivElement | null>(null)
  /**
   * The chat that was just made out of the stage, with the message that made it. Two
   * jobs, both lasting only until that chat stands on its own: it keeps the opening
   * message on screen through the gap before the server has written it down, and it
   * tells the rail that this arrival is a chat being born rather than a chat being
   * switched to, so the panel may animate open instead of appearing.
   */
  const [bornChat, setBornChat] = useState<{
    chatId: string
    sent: SentDraft
  } | null>(null)
  /**
   * The project form, above both places that ask for it: the sidebar's new-project
   * button and the new-chat stage's picker. Null is closed.
   */
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState | null>(null)
  /**
   * The group form, above the sidebar for the same reason the project form is: the
   * list opens it and the open chat's own row edits through it. Null is closed.
   */
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(null)
  /**
   * The search palette, over the whole workspace rather than inside the sidebar so
   * it opens the same whether that panel is pinned or folded away. False is closed.
   */
  const [searchOpen, setSearchOpen] = useState(false)

  const draftTarget = newChatDraft?.target
  const draftProjectId = draftTarget?.kind === 'project' ? draftTarget.projectId : undefined
  /** The persona an unsent DM is addressed to, which is also the row the sidebar lights. */
  const draftAgentId = draftTarget?.kind === 'dm' ? draftTarget.agentId : null
  const draftProjectExists =
    // The home room is always there: a draft without a project never loses its room.
    draftProjectId === undefined ? false : isHomeRoom(draftProjectId) || projects.some((project) => project.id === draftProjectId)
  const draftAgentExists =
    draftAgentId === null ? false : agents.some((agent) => agent.id === draftAgentId)

  useEffect(() => {
    if (newChatDraft === null) return
    // The thing the draft is addressed to went away (a project removed, a persona
    // deleted), so there is nothing left to send into.
    if (!draftProjectExists && !draftAgentExists) {
      setNewChatDraft(null)
      showChatRef.current()
      return
    }
    if (!newChatDraft.submitting) return
    const outcome = submittedDraftOutcome({
      previousChatId: newChatDraft.previousChatId,
      pendingChatId,
      openChatId,
      errorNotice: refusesCreate(notice, newChatDraft.requestId),
    })
    if (outcome === 'waiting') return
    if (outcome === 'arriving') {
      showChatRef.current()
      return
    }
    // A refused create must not leave a chat standing on screen that will never exist.
    // What was in the box goes back in it, attachments included: a refusal that eats
    // what you wrote and what you picked is worse than the refusal.
    if (outcome === 'refused') {
      if (newChatDraft.sent !== null) {
        restoreSentDraft(newChatDraft.target, newChatDraft.sent)
        restorePageContextsRef.current(stageDraftKey(newChatDraft.target), newChatDraft.sent.pageContexts)
      }
      const { requestId: _answered, ...unsent } = newChatDraft
      setNewChatDraft({ ...unsent, submitting: false, sent: null, travelFrom: null })
      return
    }
    if (openChatId !== null && newChatDraft.sent !== null) {
      setBornChat({ chatId: openChatId, sent: newChatDraft.sent })
    }
    setNewChatDraft(null)
    showChatRef.current()
  }, [
    newChatDraft,
    draftProjectExists,
    draftAgentExists,
    notice,
    pendingChatId,
    openChatId,
    showChatRef,
    restorePageContextsRef,
  ])

  // Held for exactly that gap: the chat has something of its own, or it is no longer
  // the chat on screen.
  useEffect(() => {
    if (bornChat === null) return
    if (stageChatId !== bornChat.chatId || stageHasRows) setBornChat(null)
  }, [bornChat, stageChatId, stageHasRows])

  useEffect(() => holdProjectDraft(newChatDraft), [newChatDraft])

  /**
   * The stage's create, settled by its own answer wherever the user is by then. One
   * at a time: `start` refuses a second while the first is unanswered.
   */
  const createRequest = useRequest(requestEvents)
  /** The sending draft, so leaving and coming back mid-send shows it still sending. */
  const inFlightRef = useRef<NewChatDraft | null>(null)
  const stageRef = useRef(newChatDraft)
  stageRef.current = newChatDraft

  // Read through refs so `beginDraft` stays stable for the memoised sidebar.
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const singleDefaultRef = useRef(singleDefault)
  singleDefaultRef.current = singleDefault
  const onScreenChatRef = useRef<string | null>(null)
  onScreenChatRef.current = pendingChatId ?? openChatId

  const beginDraft = useCallback((target: NewChatDraft['target']) => {
    setNewChatDraft(reopenDraft(
      target,
      inFlightRef.current,
      onScreenChatRef.current,
      projectsRef.current,
      singleDefaultRef.current,
    ))
  }, [])

  const clearDraft = useCallback(() => setNewChatDraft(null), [])

  const submitDraft = (
    text: string,
    attachments: ComposerAttachments,
    pageContexts: PageContextAttachment[],
    quotes: InlineQuote[] = [],
  ): boolean => {
    if (newChatDraft === null || newChatDraft.submitting) return false
    // So the refusal that may follow is about this send and not the one before it.
    dismissNotice()
    const draft = newChatDraft
    const sent = { text, ...attachments, pageContexts, ...(quotes.length === 0 ? {} : { quotes }) }
    let requestId = ''
    const created = createRequest.start(
      (id) => {
        requestId = id
        return createChat(draft.target, sent, draft.overrides, draft.checkout, id)
      },
      {
        onAck: () => {
          inFlightRef.current = null
          if (draft.target.kind === 'project') forgetHeldProjectDraft()
        },
        // On its own stage, the draft's refusal path puts the box back. Off it, the
        // box of the stage it came from gets it; that composer is not mounted then.
        onNotice: () => {
          inFlightRef.current = null
          if (stageRef.current?.requestId === requestId) return
          restoreSentDraft(draft.target, sent)
          restorePageContextsRef.current(stageDraftKey(draft.target), pageContexts)
        },
      },
    )
    if (created) {
      const sending = {
        ...draft,
        submitting: true,
        previousChatId: pendingChatId ?? openChatId,
        sent,
        requestId,
        travelFrom: draftBoxRef.current?.getBoundingClientRect().top ?? null,
      }
      inFlightRef.current = sending
      setNewChatDraft(sending)
    }
    return created
  }

  /** A pin picked on the new-chat stage, kept locally until the create carries it. */
  const draftOverride = (agentId: string, override: ChatOverride) =>
    setNewChatDraft((current) =>
      current === null ? current : { ...current, overrides: withOverride(current.overrides, agentId, override) },
    )

  const setDraftMode = (mode: ChatMode) =>
    setNewChatDraft((current) => draftWithMode(current, mode))

  const setDraftSingleRuntime = (runtime: ChatOverride) =>
    setNewChatDraft((current) =>
      current === null || current.target.kind !== 'project' || current.target.mode !== 'single'
        ? current
        : {
            ...current,
            overrides: withOverride(current.overrides, SINGLE_CHAT_VOICE.id, runtime),
          },
    )

  const setDraftProject = (projectId: string) =>
    setNewChatDraft((current) =>
      current === null
        ? current
        : // Isolation is about one project's folders, so it does not travel to
          // the next one. Without this the row could vanish (a project with no
          // repo) while the intent behind it rode along into a refused create.
          current.target.kind === 'project'
            ? { ...current, target: { ...current.target, projectId }, checkout: { mode: 'current' } }
            : // A project create still unanswered owns the project box, as on reopen.
              inFlightRef.current?.target.kind === 'project'
              ? { ...inFlightRef.current, previousChatId: pendingChatId ?? openChatId }
              : emptyNewChatDraft({ kind: 'project', projectId }, singleDefault),
    )

  const setDraftCheckout = (checkout: CheckoutRequest) =>
    setNewChatDraft((current) => (current === null ? current : { ...current, checkout }))

  // The last answer belonged to whatever asked before this dialog did, and a stale
  // refusal inside a freshly opened form would read as this form's.
  const openProjectDialog = useCallback((dialog: ProjectDialogState) => {
    dismissNotice()
    setProjectDialog(dialog)
  }, [dismissNotice])

  const closeProjectDialog = useCallback(() => {
    setProjectDialog(null)
    dismissNotice()
  }, [dismissNotice])

  const openGroupDialog = useCallback(
    (dialog: GroupDialogState) => {
      dismissNotice()
      setGroupDialog(dialog)
    },
    [dismissNotice],
  )

  const closeGroup = useCallback(() => setGroupDialog(null), [])
  const newGroup = useCallback(() => openGroupDialog({ mode: 'create' }), [openGroupDialog])
  const editGroup = useCallback(
    (chatId: string) => openGroupDialog({ mode: 'edit', chatId }),
    [openGroupDialog],
  )

  // Stable for the memoised sidebar, which only holds if every callback it gets is.
  const openSearch = useCallback(() => setSearchOpen(true), [])
  const closeSearch = useCallback(() => setSearchOpen(false), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) return
      if (event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      setSearchOpen((open) => !open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return {
    newChatDraft,
    /** A create is unanswered, from whichever stage; the next one waits for it. */
    creating: createRequest.pending,
    draftBoxRef,
    bornChat,
    projectDialog,
    groupDialog,
    searchOpen,
    draftTarget,
    draftProjectId,
    draftAgentId,
    beginDraft,
    clearDraft,
    submitDraft,
    draftOverride,
    setDraftMode,
    setDraftSingleRuntime,
    setDraftProject,
    setDraftCheckout,
    openProjectDialog,
    closeProjectDialog,
    openGroupDialog,
    closeGroup,
    newGroup,
    editGroup,
    openSearch,
    closeSearch,
  }
}
