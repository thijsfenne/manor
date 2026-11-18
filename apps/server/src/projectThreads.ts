import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  Chat,
  ClientMessage,
  FileAttachment,
  GoalLearning,
  ChatOverride,
  ImageAttachment,
  PreferenceSource,
  Project,
  ProjectFileWrite,
  ProjectThreadFile,
  ServerMessage,
  ThreadEvent,
  UserInputAnswers,
  UserInputQuestion,
  WorkHandoff,
} from '@manor/contracts'
import {
  HOME_PROJECT_ID,
  isProjectThreadFile,
  NEW_SINGLE_CHAT_DEFAULT,
  runtimeOn,
  NOTES_LINE_MAX,
  SESSION_STATUS_MAX,
  PROJECT_CARD_FILE,
  projectFileWriteDetail,
  projectFileWriteLabel,
  SINGLE_CHAT_VOICE,
  userInputAnswerLines,
  userInputAnswerText,
} from '@manor/contracts'
import { attachmentFields, loadHandoffAttachments } from './handoffAttachments.js'
import { answersMatch } from './interactionBroker.js'
import type { UserInputContext } from './interactionCapability.js'
import { dehydrateNotes, diskNote, hydrateNotes, shortNoteId } from './noteMarkers.js'
import { asLine, confirmedAndLanded, loadNotesEvidence, noteHandoff, noteText, proposedNote, reconcileNotes } from './projectNotes.js'
import {
  appendCardDecision,
  applyThreadLineOp,
  archiveCompletedNotes,
  createThreadFile,
  datedPreference,
  ensureProjectThreadFiles,
  indexedCards,
  inverseWrite,
  linkedCardLines,
  newCard,
  overPreferencesBudget,
  PREFERENCE_LINE_MAX,
  PREFERENCES_BUDGET,
  PROJECT_THREAD_WRITER,
  PROJECT_SETUP_VERSION,
  isPinned,
  type ProjectFileChange,
  projectThreadPaths,
  readThreadFile,
  removeTrustedCompletedNotes,
  threadFileLines,
  threadFilePath,
  withThreadFileLock,
  writeThreadFile,
  type ProjectThreadPaths,
  type ThreadLineOp,
} from './projectFiles.js'
import type { Store, WorkHandoffNote } from './store.js'

/**
 * Why Manor starts a project thread turn that the user did not type. Each reason grants
 * less than their own message does: only `brief` may start a session, and only the user's
 * own message may propose one on a card.
 */
export type ProjectThreadReason = 'question' | 'report' | 'result' | 'brief' | 'seed'

export interface ProjectThreadOrigin {
  source: 'project_thread'
  reason: ProjectThreadReason
  /** The thread notes whose waiting prompts this wake's message carries (`threadDelivered`). */
  delivered?: readonly string[]
}

/** A wake's message, composed when the thread's queue reaches it. */
export interface ThreadWakeMessage {
  /** Manor's words to the thread's model; no surface shows it. */
  instruction: string
  /** What the user may read of it, such as a forwarded brief's task. Absent when there is none. */
  text?: string
  /** The notes it delivers; none of them rides along again. */
  delivered: readonly string[]
  /** A forwarded brief's attachments, copied onto the wake's message. */
  images?: ImageAttachment[]
  files?: FileAttachment[]
}

/**
 * The row that carries waiting items into a turn something else started. It is never
 * that turn's request, so anything looking for the request looks past it.
 */
export const ridesAlong = (event: ThreadEvent): boolean =>
  event.type === 'user_message' && event.source === 'project_thread' && event.threadReason === 'report'

/** How long a question wake waits for others arriving with it, so they share one turn. */
const QUESTION_SETTLE_MS = 1_000

/** After three answers in a row from preferences, the next question goes to the user. */
export const SELF_ANSWER_STREAK_MAX = 3

type AcceptOptions = Pick<Extract<ClientMessage, { type: 'accept_work_handoff' }>, 'checkout' | 'mode' | 'runtime'>

export interface ProjectThreadsOptions {
  store: Store
  /** Models turned off in Settings; a new thread never starts on one. */
  offModels?: () => readonly string[]
  /** `<memory dir>/memory/structured`; absent without a local checkout, where threads are refused. */
  structuredRoot: string | undefined
  agentName: (agentId: string) => string
  emit: (message: ServerMessage) => void
  broadcastDirectory: () => Promise<void>
  /**
   * Queues one thread turn; returns at once. `compose` runs when the thread's own queue
   * reaches the wake, so a live turn finishes first, and undefined drops the wake.
   */
  wake: (threadChatId: string, origin: ProjectThreadOrigin, compose: () => Promise<ThreadWakeMessage | undefined>) => void
  /** Tests pass 0; the default lets questions arriving together share one wake. */
  questionSettleMs?: number
  /** The live ask broker: resolves the held `ask_user` call of the session, naming the line the thread quoted. */
  answerQuestion: (chatId: string, requestId: string, answers: UserInputAnswers, fromPreference: PreferenceSource) => Promise<boolean>
  /** Request ids each chat is blocked on right now. */
  awaitingInput: () => Readonly<Record<string, readonly string[]>>
  isActiveTurn: (chatId: string, agentId: string, turnId: string) => boolean
  /** Accepts the thread's own session card for a brief the user already accepted in a DM. */
  acceptHandoff: (handoffId: string, options: AcceptOptions & { task?: string }) => Promise<string>
  /** The Unsettle the user clicks in a settled Session before they type there. */
  reopenSession: (sessionChatId: string) => Promise<void>
  /** Their message in the Session as if typed there, including active-turn steering; resolves once stored. */
  acceptInSession: (sessionChatId: string, message: ForwardedMessage) => Promise<void>
}

/** The user's message as it goes on to a Session, with the pictures and text files they sent along. */
export interface ForwardedMessage {
  text: string
  forwardedFrom: { threadChatId: string; eventId: string }
  images?: Extract<ThreadEvent, { type: 'user_message' }>['images']
  files?: Extract<ThreadEvent, { type: 'user_message' }>['files']
}

export interface SessionForwardInput {
  /** A Session's chat id, or its exact title. */
  session: string
  message: string
}

/** A Session this thread started and the user accepted. */
export interface ThreadSession {
  chat: Chat
  handoff: WorkHandoff
}

/** The Sessions this thread started and the user accepted, newest first, archived ones left out. */
export async function threadSessions(store: Store, threadChatId: string): Promise<ThreadSession[]> {
  const sessions: ThreadSession[] = []
  for (const handoff of await store.listWorkHandoffs()) {
    if (handoff.sourceChatId !== threadChatId || handoff.workChatId === null || handoff.acceptedAt === null) continue
    const chat = await store.getChat(handoff.workChatId)
    if (chat !== undefined && chat.archivedAt === null) sessions.push({ chat, handoff })
  }
  return sessions.sort((a, b) => b.chat.lastMessageAt - a.chat.lastMessageAt)
}

/** How many Sessions a thread turn is shown; older ones are still reachable by id or title. */
const SESSIONS_LISTED = 12

const sessionState = ({ chat, handoff }: ThreadSession): string =>
  chat.settledAt !== null ? 'settled'
    : handoff.goalReachedAt !== undefined && handoff.goalConfirmedAt === undefined ? 'result waits for Confirm'
      : 'open'

/** The Sessions list a thread turn the user started reads, so it can send a follow-up on. */
export function threadSessionsBlock(sessions: readonly ThreadSession[]): string {
  if (sessions.length === 0) return '[Manor] This thread has started no Sessions yet, so there is nothing to send a follow-up to.'
  return [
    '[Manor] Sessions this thread started, newest first:',
    ...sessions.slice(0, SESSIONS_LISTED).map((session) => {
      const about = (session.handoff.summary ?? session.handoff.goalReport?.result ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      return `- ${JSON.stringify(session.handoff.title)} (id ${session.chat.id}, ${sessionState(session)})${about === '' ? '' : `: ${about}`}`
    }),
  ].join('\n')
}

/** What one finished turn touched, as the turn runner measured it. */
export interface GuardedTurn {
  chatId: string
  agentId: string
  /** Files its edit tools changed in calls that succeeded, resolved against the folder the tool ran in. */
  editedPaths: readonly string[]
  /** Files its shell commands certainly wrote, as absolute paths (`shellWriteDestinations`). */
  shellWrites?: readonly string[]
}

/** A file line without its bullet marker. */
const bareLine = (line: string): string => line.replace(/^\s*-\s+/, '').trim()

export interface FileWriteInput {
  /** `preferences.md`, `notes.md`, or a memory card in the same folder. */
  file: string
  action: ThreadLineOp['action'] | 'create'
  line?: string
  old?: string
  /** A new card's catalogue title, description and when-it-applies, for `create` only. */
  title?: string
  description?: string
  when?: string
}

export interface SessionAnswerInput {
  requestId: string
  answers: UserInputAnswers
  preference: string
}

export interface ProjectReportInput {
  project: string
  kind: 'preference' | 'note'
  text: string
  quote?: string
}

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

const BRIEF_KEY = /^brief-(.+)$/

/** A server-owned approval card (computer use, a connector write): only the user answers it. */
const isPermission = (questions: readonly UserInputQuestion[]): boolean => questions.some((question) => question.optionsOnly === true)

/** A self-answer must quote a preferences line, at least a recognisable piece of one. */
export function quotesPreference(lines: readonly string[], quote: string): boolean {
  const wanted = normalize(quote.replace(/^\s*-\s+/, ''))
  return wanted.length >= 8 && lines.some((line) => normalize(line).includes(wanted))
}

const QUESTION_TEXT_MAX = 400

/**
 * The thread that lists a project in the sidebar. Undefined when the project has no
 * thread or is hidden: a hidden project keeps its thread, archived (2026-11-12), and
 * acts as a project without one until the user adds it back.
 */
export async function liveProjectThread(
  store: Pick<Store, 'getChat'>, project: Pick<Project, 'threadChatId'> | undefined,
): Promise<string | undefined> {
  if (project?.threadChatId === undefined) return undefined
  return (await store.getChat(project.threadChatId))?.archivedAt === null ? project.threadChatId : undefined
}

/**
 * Owns the project thread (decided 2026-10-10): creating and removing it, the two files
 * it alone writes, the questions its sessions send it, reports from personas that may
 * not write those files, and the DM brief it turns into a session.
 */
export class ProjectThreads {
  /** Self-answers in a row per session since the user last answered one of its questions. */
  private readonly streaks = new Map<string, number>()
  /** Answers the user is replacing right now, so a double press sends one message. */
  private readonly changing = new Set<string>()
  /** What Manor last wrote or accepted for each owned file; a turn that changes it is checked. */
  private readonly known = new Map<string, string>()
  private readonly noteSources = new Map<string, Awaited<ReturnType<typeof loadNotesEvidence>>['sources']>()
  /**
   * Turns the guard watches right now. A change none of them claims is adopted only
   * once all of them have checked, so an overlapping turn cannot adopt another's write.
   */
  private readonly guarded = new Set<string>()
  /** Threads with a question wake queued that has not read the queue yet; later questions join it. */
  private readonly questionWakes = new Set<string>()
  /** Forwards being sent right now, by the user's message and Session, so a parallel call cannot send it twice. */
  private readonly forwarding = new Set<string>()

  constructor(private readonly options: ProjectThreadsOptions) {}

  private paths(project: Project): ProjectThreadPaths {
    if (this.options.structuredRoot === undefined) {
      throw new Error('Project threads need a memory folder, because their files are edited in place.')
    }
    return projectThreadPaths(this.options.structuredRoot, project.name)
  }

  private liveThread(project: Project | undefined): Promise<string | undefined> {
    return liveProjectThread(this.options.store, project)
  }

  /**
   * The project whose live thread this chat is. A thread turn still running when its
   * project is hidden holds no thread tools from then on.
   */
  async threadProject(chatId: string): Promise<Project | undefined> {
    const chat = await this.options.store.getChat(chatId)
    if (chat?.projectId == null || chat.archivedAt !== null) return undefined
    const project = await this.options.store.getProject(chat.projectId)
    return project?.threadChatId === chatId ? project : undefined
  }

  /** The live thread that started this session, with the handoff that links them. A hidden project's Session stands alone. */
  async sessionThread(sessionChatId: string): Promise<{ project: Project; handoff: WorkHandoff; threadChatId: string } | undefined> {
    const handoff = await this.options.store.workHandoffForTarget(sessionChatId)
    if (handoff === undefined) return undefined
    const project = await this.options.store.getProject(handoff.projectId)
    const threadChatId = await this.liveThread(project)
    if (project === undefined || threadChatId === undefined || threadChatId !== handoff.sourceChatId) return undefined
    return { project, handoff, threadChatId }
  }

  private async append(chatId: string, note: WorkHandoffNote): Promise<ThreadEvent> {
    const event = await this.options.store.appendEvent(chatId, note)
    this.options.emit({ type: 'event', chatId, event })
    return event
  }

  /** Reconciles and archives Notes at boot, then records the remainder for the owner guard. */
  async prime(): Promise<void> {
    await this.adoptWhenIdle()
  }

  /**
   * Startup keeps the setup of every project in the sidebar current. A project without a
   * live thread is hidden (2026-10-14): it is skipped whole, and this never creates
   * or restores a thread. Only creating or re-adding a project in the sidebar does. No provider turns.
   */
  async reconcileSetup(dryRun = false): Promise<{
    project: string; thread: 'keep' | 'hidden' | 'error'; files: ProjectFileChange[]; error?: string
  }[]> {
    if (this.options.structuredRoot === undefined) {
      throw new Error('Project setup needs a memory folder; no setup files were changed.')
    }
    const report = []
    for (const project of await this.options.store.listProjects()) {
      try {
        if (await this.liveThread(project) === undefined) {
          report.push({ project: project.name, thread: 'hidden' as const, files: [] })
          continue
        }
        const setup = await this.options.store.getProjectSetup(project.id)
        if (setup !== undefined && setup.version > PROJECT_SETUP_VERSION) {
          throw new Error(`Project ${project.name} needs a newer project setup version.`)
        }
        const files = await ensureProjectThreadFiles(this.paths(project), project.name, { dryRun })
        if (!dryRun) await this.options.store.setProjectSetupVersion(project.id, PROJECT_SETUP_VERSION)
        report.push({ project: project.name, thread: 'keep' as const, files })
      } catch (error) {
        report.push({ project: project.name, thread: 'error' as const, files: [], error: error instanceof Error ? error.message : String(error) })
      }
    }
    return report
  }

  async create(projectId: string, options: { seed?: boolean; broadcast?: boolean; runtime?: ChatOverride } = {}): Promise<string> {
    const { store } = this.options
    // A thread makes a project show in the sidebar and gives it memory files. The home room has neither.
    if (projectId === HOME_PROJECT_ID) throw new Error('Sessions without a project have no project thread.')
    const project = await store.getProject(projectId)
    if (project === undefined) throw new Error('That project no longer exists.')
    const live = await this.liveThread(project)
    if (live !== undefined) return live
    const paths = this.paths(project)
    await ensureProjectThreadFiles(paths, project.name)
    // A hidden project comes back with the thread it had, history included. It was
    // seeded when it was made, so it gets no second seed.
    const hidden = project.threadChatId !== undefined && await store.getChat(project.threadChatId) !== undefined
      ? project.threadChatId : undefined
    if (hidden !== undefined) await store.setChatArchived(hidden, false)
    const threadChatId = hidden ?? await this.newThread(project, options.runtime)
    // A folder taken off the picker and then made a project is listed again.
    if (project.unlisted === true) await store.setProjectUnlisted(projectId, false)
    for (const file of [paths.preferences, paths.notes]) this.known.set(file, await readThreadFile(file))
    await store.setProjectSetupVersion(projectId, PROJECT_SETUP_VERSION)
    if (options.broadcast !== false) await this.options.broadcastDirectory()
    // A brief handed over before the project was hidden starts now.
    if (hidden !== undefined) await this.recoverBriefs(projectId).catch((error: unknown) => console.warn('[manor] could not recover forwarded briefs', error))
    if (hidden === undefined && options.seed !== false) {
      const seed = seedPrompt(project.name, paths)
      this.options.wake(threadChatId, { source: 'project_thread', reason: 'seed' }, async () => ({ instruction: seed, delivered: [] }))
    }
    return threadChatId
  }

  private async newThread(project: Project, runtime: ChatOverride | undefined): Promise<string> {
    const { store } = this.options
    const chat = await store.createChat({ kind: 'project', projectId: project.id, mode: 'single', title: project.name })
    try {
      await store.setChatOverride(chat.id, SINGLE_CHAT_VOICE.id, { ...(runtime ?? runtimeOn(NEW_SINGLE_CHAT_DEFAULT, this.options.offModels?.() ?? [])) })
      await store.setProjectThread(project.id, chat.id)
    } catch (error) {
      await store.deleteChat(chat.id).catch(() => undefined)
      throw error
    }
    return chat.id
  }

  /**
   * The first turn of a project the user just made: the thread reads the project's
   * folders and says hello. One turn on the user's subscription, asked for by making
   * the project. A project re-added from an older setup gets the seed instead.
   */
  async welcome(projectId: string): Promise<void> {
    const project = await this.options.store.getProject(projectId)
    if (project?.threadChatId === undefined) return
    const instruction = welcomePrompt(project.name, project.repoPaths)
    this.options.wake(project.threadChatId, { source: 'project_thread', reason: 'seed' }, async () => ({ instruction, delivered: [] }))
  }

  /**
   * Hide the project: archive its thread, so the sidebar drops it. The project keeps
   * the thread, and its Sessions and memory files stay exactly as they are, so a re-add
   * brings back the same conversation. Refused while a session the thread started is still open.
   */
  async remove(projectId: string): Promise<void> {
    const { store } = this.options
    const project = await store.getProject(projectId)
    const threadChatId = await this.liveThread(project)
    if (project === undefined || threadChatId === undefined) return
    const open = []
    for (const handoff of await store.listWorkHandoffs()) {
      if (handoff.sourceChatId !== threadChatId || handoff.state !== 'active' || handoff.workChatId === null) continue
      const session = await store.getChat(handoff.workChatId)
      if (session !== undefined && session.settledAt === null && session.archivedAt === null && handoff.goalConfirmedAt === undefined) open.push(handoff.title)
    }
    if (open.length > 0) {
      throw new Error(`Settle the sessions this thread started first: ${open.map((title) => `“${title}”`).join(', ')}.`)
    }
    if (this.options.structuredRoot !== undefined) {
      const paths = this.paths(project)
      this.known.delete(paths.preferences)
      this.known.delete(paths.notes)
    }
    await store.setChatArchived(threadChatId, true)
    await this.options.broadcastDirectory()
  }

  /**
   * A thread-started session asked something. The card goes to the thread, which checks
   * preferences first; after three self-answers in a row the thread is not woken and
   * the card waits for the user. A permission card never wakes it: that one is theirs alone.
   * False when the session is not thread-started.
   */
  async forwardQuestion(sessionChatId: string, agentId: string, requestId: string, questions: readonly UserInputQuestion[]): Promise<boolean> {
    const linked = await this.sessionThread(sessionChatId)
    if (linked === undefined) return false
    const { handoff, threadChatId } = linked
    const project = await this.options.store.getProject(handoff.projectId)
    const asker = this.options.agentName(agentId)
    const permission = isPermission(questions)
    const capped = (this.streaks.get(sessionChatId) ?? 0) >= SELF_ANSWER_STREAK_MAX
    await this.append(threadChatId, {
      type: 'system_note',
      kind: 'info',
      text: `${handoff.title} ${permission ? 'is waiting for your approval' : `asks ${project?.name ?? 'the project'}`}: ${questions.map((question) => question.question).join('; ').slice(0, QUESTION_TEXT_MAX)}`,
      sessionQuestion: { sessionChatId, requestId, agentId, title: handoff.title.slice(0, 200), questions: [...questions] },
      ...(permission || capped ? {} : { threadPending: questionPrompt(handoff.title, asker, requestId, questions) }),
    })
    if (permission) return true
    if (capped) {
      await this.append(threadChatId, {
        type: 'system_note', kind: 'info',
        text: `The previous ${SELF_ANSWER_STREAK_MAX} questions from “${handoff.title}” were answered from preferences.md. This one waits for you.`,
      })
      return true
    }
    this.wakeForQuestions(threadChatId)
    return true
  }

  /**
   * The one wake a blocked Session needs. Questions arriving before it reads the queue
   * join it; a live thread turn finishes first. When it runs it carries everything
   * queued, and it is dropped when another turn already took every question.
   */
  private wakeForQuestions(threadChatId: string): void {
    if (this.questionWakes.has(threadChatId)) return
    this.questionWakes.add(threadChatId)
    const settle = this.options.questionSettleMs ?? QUESTION_SETTLE_MS
    this.options.wake(threadChatId, { source: 'project_thread', reason: 'question' }, async () => {
      if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle))
      this.questionWakes.delete(threadChatId)
      const queued = await this.takeQueued(threadChatId, { questions: true, alongside: false })
      return queued !== undefined && queued.questions > 0 ? queued : undefined
    })
  }

  /**
   * Everything waiting for this thread's next turn, as one prompt, and the notes it
   * delivers. Only a turn that may answer takes the questions, and only those a Session
   * still waits on; one that no longer waits is consumed silently. Read and delivered
   * on the thread's own queue, so two turns never take the same note.
   */
  async takeQueued(threadChatId: string, take: { questions: boolean; alongside: boolean }): Promise<(ThreadWakeMessage & { questions: number }) | undefined> {
    const events = await this.options.store.loadEvents(threadChatId)
    const delivered = new Set(events.flatMap((event) => event.type === 'user_message' ? event.threadDelivered ?? [] : []))
    const awaiting = this.options.awaitingInput()
    const taken: string[] = []
    const answers: string[] = []
    const learnings: string[] = []
    const reports: string[] = []
    const asked: string[] = []
    for (const event of events) {
      if (event.type !== 'system_note' || event.threadPending === undefined || delivered.has(event.id)) continue
      const question = event.sessionQuestion
      if (question !== undefined) {
        if (!take.questions) continue
        taken.push(event.id)
        if ((awaiting[question.sessionChatId] ?? []).includes(question.requestId)) asked.push(event.threadPending)
        continue
      }
      taken.push(event.id)
      const into = event.projectReport !== undefined ? reports : event.sessionAnswer !== undefined ? answers : learnings
      into.push(event.threadPending)
    }
    const parts = [...answers, ...learnings, ...(reports.length === 0 ? [] : [reportPrompt(reports)]), ...asked]
    if (parts.length === 0) return undefined
    return {
      // Each prompt keeps its wake's wording; the head scopes its "nothing else" to that item.
      instruction: [...(take.alongside ? [QUEUED_ALONGSIDE] : parts.length > 1 ? [QUEUED_TOGETHER] : []), ...parts].join('\n\n'),
      delivered: taken,
      questions: asked.length,
    }
  }

  /** The thread answers a session's question from a preferences line it quotes. */
  async answerFromThread(context: UserInputContext, input: SessionAnswerInput): Promise<string> {
    const project = await this.threadProject(context.chatId)
    if (project === undefined || !this.options.isActiveTurn(context.chatId, context.agentId, context.turnId)) {
      throw new Error('Only a running project thread turn can answer a session question.')
    }
    if (context.mayAnswer !== true) {
      throw new Error('Only a thread turn that the user\'s own message or a Session question started can answer a session question; a report or result wake leaves the card for the user.')
    }
    const asked = (await this.options.store.loadEvents(context.chatId)).find((event) =>
      event.type === 'system_note' && event.sessionQuestion?.requestId === input.requestId)
    const question = asked?.type === 'system_note' ? asked.sessionQuestion : undefined
    if (question === undefined) throw new Error('No session question with that requestId is in this thread.')
    if (isPermission(question.questions)) throw new Error('Only the user answers a permission card. Leave it for them.')
    if (!(this.options.awaitingInput()[question.sessionChatId] ?? []).includes(input.requestId)) {
      throw new Error('That question no longer waits for an answer.')
    }
    if ((this.streaks.get(question.sessionChatId) ?? 0) >= SELF_ANSWER_STREAK_MAX) {
      throw new Error(`The last ${SELF_ANSWER_STREAK_MAX} questions of this session were answered from preferences. Leave this one for the user.`)
    }
    const paths = this.paths(project)
    const preferences = await readThreadFile(paths.preferences)
    // A line's detail lives on the card it links to, so a quote from that card covers too.
    const file = quotesPreference(threadFileLines(preferences), input.preference)
      ? 'preferences.md'
      : (await linkedCardLines(paths, preferences)).find(({ line }) => quotesPreference([line], input.preference))?.file
    if (file === undefined) {
      throw new Error('`preference` must quote a line of preferences.md or of a card one of its lines links to. Without one, leave the question for the user.')
    }
    const fromPreference = { file, quote: input.preference.trim().slice(0, 2_000) }
    if (!await this.options.answerQuestion(question.sessionChatId, input.requestId, input.answers, fromPreference)) {
      throw new Error('The answer did not match the questions, or the question closed. Check the ids and options.')
    }
    this.streaks.set(question.sessionChatId, (this.streaks.get(question.sessionChatId) ?? 0) + 1)
    return 'Answered. The session continues.'
  }

  /** Every recorded answer to a forwarded question, from the user's card or from the thread's quoted line. */
  async recordAnswer(sessionChatId: string, requestId: string, answers: UserInputAnswers, fromPreference?: PreferenceSource): Promise<void> {
    const linked = await this.sessionThread(sessionChatId)
    if (linked === undefined) return
    const asked = (await this.options.store.loadEvents(linked.threadChatId)).find((event) =>
      event.type === 'system_note' && event.sessionQuestion?.requestId === requestId)
    const question = asked?.type === 'system_note' ? asked.sessionQuestion : undefined
    if (question === undefined) return
    if (fromPreference === undefined) this.streaks.delete(sessionChatId)
    const text = Object.values(answers).map(userInputAnswerText).join('; ')
    // Their own answer waits for the thread's next turn, which keeps it only when it is lasting.
    const keep = fromPreference === undefined && !isPermission(question.questions)
    await this.append(linked.threadChatId, {
      type: 'system_note',
      kind: 'info',
      text: fromPreference === undefined ? `Answered: ${text}` : `Answered from ${fromPreference.file}: ${text}`,
      sessionAnswer: { sessionChatId, requestId, answers, by: fromPreference === undefined ? 'user' : 'thread', ...(fromPreference === undefined ? {} : { preference: fromPreference.quote }) },
      ...(keep ? { threadPending: answerPrompt(linked.handoff.title, question.questions, answers) } : {}),
    })
  }

  /**
   * The user replaces an answer the thread gave a Session from a preference, for the
   * questions in `answers`. It reaches the Session as their own message, steering a running
   * answer or starting a new one, also after the Session moved on; the thread then hears
   * it as their answer, so it can retire the line they overruled. Once per answer.
   */
  async changeAnswer(threadChatId: string, requestId: string, answers: UserInputAnswers): Promise<void> {
    // Claimed before the first await: socket frames run concurrently, and a double click must send once.
    if (this.changing.has(requestId)) throw new Error('You already changed this answer.')
    this.changing.add(requestId)
    try {
      await this.changeAnswerOnce(threadChatId, requestId, answers)
    } finally {
      this.changing.delete(requestId)
    }
  }

  private async changeAnswerOnce(threadChatId: string, requestId: string, answers: UserInputAnswers): Promise<void> {
    const notes = (await this.options.store.loadEvents(threadChatId)).flatMap((event) => event.type === 'system_note' ? [event] : [])
    const given = notes.find((note) => note.sessionAnswer?.requestId === requestId && note.sessionAnswer.by === 'thread')
    const asked = notes.find((note) => note.sessionQuestion?.requestId === requestId)?.sessionQuestion
    if (given?.sessionAnswer === undefined || asked === undefined) throw new Error('That is not an answer Manor gave in this thread.')
    const { sessionChatId, answers: before } = given.sessionAnswer
    if (notes.some((note) => note.sessionAnswer?.requestId === requestId && note.sessionAnswer.by !== 'thread')) {
      throw new Error('You already changed this answer.')
    }
    const changed = asked.questions.filter((question) => answers[question.id] !== undefined)
    if (changed.length === 0 || Object.keys(answers).length !== changed.length || !answersMatch(changed, answers)) {
      throw new Error('That answer does not fit the question.')
    }
    const linked = await this.sessionThread(sessionChatId)
    const session = await this.options.store.getChat(sessionChatId)
    if (linked?.threadChatId !== threadChatId || session === undefined) throw new Error('That Session is no longer part of this thread.')
    // The Session's own record decides, so a note that failed to save never sends it twice.
    const delivered = (await this.options.store.loadEvents(sessionChatId)).some((event) =>
      event.type === 'user_message' && event.forwardedFrom?.threadChatId === threadChatId && event.forwardedFrom.eventId === given.id)
    if (!delivered) {
      if (session.settledAt !== null) await this.options.reopenSession(sessionChatId)
      await this.options.acceptInSession(sessionChatId, {
        text: changedAnswerMessage(changed, answers, before),
        forwardedFrom: { threadChatId, eventId: given.id },
      })
    }
    this.streaks.delete(sessionChatId)
    await this.append(threadChatId, {
      type: 'system_note',
      kind: 'info',
      text: `Changed to: ${Object.values(answers).map(userInputAnswerText).join('; ')}`,
      sessionAnswer: { sessionChatId, requestId, answers, by: 'user' },
      threadPending: changedAnswerPrompt(linked.handoff.title, changed, answers, given.sessionAnswer.preference),
    })
  }

  /**
   * Sends the user's latest thread message on to a Session this thread started, as their own
   * message there. Only a thread turn their message started holds the tool, and the
   * capability says so again here: a wake for a Session's report, result or question
   * never forwards, so a Session can never set off a message back into a Session. Each
   * of their messages reaches one Session once. The thread shows it under their bubble.
   */
  async forwardToSession(context: UserInputContext, input: SessionForwardInput): Promise<string> {
    const project = await this.threadProject(context.chatId)
    if (project?.threadChatId === undefined || !this.options.isActiveTurn(context.chatId, context.agentId, context.turnId)) {
      throw new Error('Only a running project thread turn can send a message to a Session.')
    }
    if (context.mayForward !== true) {
      throw new Error('Only a thread turn that the user\'s own message started can send to a Session; a report, result or question from a Session never does.')
    }
    const threadChatId = project.threadChatId
    const sessions = await threadSessions(this.options.store, threadChatId)
    const wanted = input.session.trim()
    const named = sessions.filter(({ handoff }) => normalize(handoff.title) === normalize(wanted))
    const target = sessions.find(({ chat }) => chat.id === wanted) ?? (named.length === 1 ? named[0] : undefined)
    if (target === undefined) {
      if (named.length > 1) throw new Error(`Several Sessions are called ${JSON.stringify(wanted)}. Pass the id of the one you mean.`)
      const other = await this.options.store.getChat(wanted)
      if (other !== undefined && other.projectId !== project.id) {
        throw new Error(`That Session belongs to another project. Send only to a Session of ${project.name}.`)
      }
      const listed = sessions.slice(0, SESSIONS_LISTED).map(({ chat, handoff }) => `${JSON.stringify(handoff.title)} (${chat.id})`).join(', ')
      throw new Error(`No Session this thread started matches ${JSON.stringify(wanted)}. Its Sessions: ${listed || 'none'}. New work gets start_work instead.`)
    }
    const events = await this.options.store.loadEvents(threadChatId)
    // The message this turn runs on: their newest one that is not still queued behind it.
    const source = [...events].reverse().find((event): event is Extract<ThreadEvent, { type: 'user_message' }> =>
      event.type === 'user_message' && event.source === undefined &&
      event.dispatchState !== 'pending' && event.dispatchState !== 'uncertain')
    if (source === undefined) throw new Error('There is no message from the user in this thread to send on.')
    const title = target.handoff.title.slice(0, 200)
    const key = `${source.id}:${target.chat.id}`
    const receipted = events.some((event) =>
      event.type === 'system_note' && event.hintFor === source.id && event.sessionForward?.sessionChatId === target.chat.id)
    if (this.forwarding.has(key) || receipted) throw new Error(`This message already went to “${title}”.`)
    this.forwarding.add(key)
    try {
      // The Session's own record decides too: a receipt that failed to save must not send it twice.
      const delivered = (await this.options.store.loadEvents(target.chat.id)).some((event) =>
        event.type === 'user_message' && event.forwardedFrom?.threadChatId === threadChatId && event.forwardedFrom.eventId === source.id)
      // What the user does themselves in a settled Session: Unsettle, then their message.
      const reopened = !delivered && target.chat.settledAt !== null
      if (reopened) await this.options.reopenSession(target.chat.id)
      if (!delivered) {
        await this.options.acceptInSession(target.chat.id, {
          text: input.message.trim(),
          forwardedFrom: { threadChatId, eventId: source.id },
          ...(source.images === undefined || source.images.length === 0 ? {} : { images: source.images }),
          ...(source.files === undefined || source.files.length === 0 ? {} : { files: source.files }),
        })
      }
      await this.append(threadChatId, {
        type: 'system_note',
        kind: 'info',
        text: `Sent to “${title}”.`,
        hintFor: source.id,
        sessionForward: { sessionChatId: target.chat.id, title, turnId: context.turnId, agentId: context.agentId },
      })
      return `Sent to “${title}” as the user's message${reopened ? '; it was settled and is open again' : ''}. Say so in one sentence that names the Session; its link shows under your reply. Start no Session for this.`
    } finally {
      this.forwarding.delete(key)
    }
  }

  /** The thread's one way to write its files: one line, under the shared lock, shown as an event with Undo. */
  async writeFile(context: UserInputContext, input: FileWriteInput): Promise<string> {
    const project = await this.threadProject(context.chatId)
    if (project === undefined || !this.options.isActiveTurn(context.chatId, context.agentId, context.turnId)) {
      throw new Error('Only a running project thread turn can write its project files.')
    }
    if (!isProjectThreadFile(input.file)) return this.writeCard(context, project, input)
    const file = input.file
    const written = input.line === undefined || file !== 'preferences.md' ? input.line : datedPreference(input.line, new Date())
    if (file === 'preferences.md' && written !== undefined && written.length > PREFERENCE_LINE_MAX) {
      throw new Error(`A preference line holds at most ${PREFERENCE_LINE_MAX} characters, its date included; this one has ${written.length}. Keep the rule itself short, ideally as [Rule](card.md): when it applies, and put its reason and detail on that card with update_project_file.`)
    }
    if (file === 'notes.md' && written !== undefined && bareLine(written).length > NOTES_LINE_MAX) {
      throw new Error(`A notes.md line holds at most ${NOTES_LINE_MAX} characters; this one has ${bareLine(written).length}. Keep the row to its status and next step, and put detail on a card.`)
    }
    const op: ThreadLineOp | undefined =
      input.action === 'add' && written !== undefined ? { action: 'add', line: written }
        : input.action === 'replace' && written !== undefined && input.old !== undefined ? { action: 'replace', old: input.old, line: written }
          : input.action === 'remove' && input.old !== undefined ? { action: 'remove', old: input.old }
            : undefined
    if (op === undefined) throw new Error('add needs `line`, replace needs `old` and `line`, remove needs `old`. create is for a new card.')
    if (file === 'notes.md' && op.action === 'add') {
      const owned = await this.openSessionTitled(context.chatId, op.line)
      if (owned !== undefined) {
        throw new Error(`Manor already keeps the notes.md row for the Session “${owned.title}”, from its proposal to done, and its status updates land there. Add no row for it; edit that row with replace if it needs a different status.`)
      }
    }
    const applied = await this.applyLine(project, file, op)
    await this.recordWrite(context, project, {
      file, action: op.action,
      ...('line' in applied.op ? { line: applied.op.line } : {}),
      ...('old' in applied.op ? { old: applied.op.old } : {}),
      ...(applied.noteId === undefined ? {} : { noteId: applied.noteId }),
    }, !applied.archived)
    // A row's age counts from this write, not from the next Session turn that happens to reconcile.
    if (file === 'notes.md' && this.guarded.size === 0) await this.adoptWhenIdle().catch(() => undefined)
    return applied.over
      ? `Saved in ${file}. It is now past its one-screen budget of ${PREFERENCES_BUDGET} characters: shorten its lines and move their detail into the linked cards before you add another.`
      : applied.archived ? 'Saved in notes.md. Completed notes moved to _archive/notes.md.'
      : `Saved in ${file}.`
  }

  /**
   * A proposal or open Session of this thread whose title the new Notes row starts with.
   * This only refuses a duplicate row; closing a row still never goes by title.
   */
  private async openSessionTitled(threadChatId: string, line: string): Promise<WorkHandoff | undefined> {
    const fold = (text: string) => asLine(text).toLowerCase()
    const row = fold(bareLine(line).replace(/^\[[ xX]\]\s+/, ''))
    return (await this.options.store.listWorkHandoffs()).find((handoff) => {
      if (handoff.sourceChatId !== threadChatId || handoff.state !== 'active' || handoff.version === 0) return false
      const title = fold(handoff.title)
      return title.length > 0 && row.startsWith(title) && !/[\p{L}\p{N}]/u.test(row.charAt(title.length))
    })
  }

  /**
   * One line change to preferences.md or notes.md. The file is read again just before
   * the rename and the change is redone on what it then reads, so a hand edit made
   * meanwhile is kept. Returns the change as it landed, without a Notes marker. `exact`
   * is for Undo, which takes back a preference only as it was written, date included.
   */
  private async applyLine(project: Project, file: ProjectThreadFile, op: ThreadLineOp, exact = false): Promise<{ op: ThreadLineOp; over: boolean; archived: boolean; noteId?: string }> {
    const paths = this.paths(project)
    const target = threadFilePath(paths, file)
    await ensureProjectThreadFiles(paths, project.name)
    return withThreadFileLock(target, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await readThreadFile(target)
        if (isPinned(current)) throw new Error('This project file is pinned.')
        if (file === 'notes.md' && this.guarded.size !== 0 && current !== this.known.get(target)) {
          throw new Error('Notes have pending Session edits. Retry after the Session turns end.')
        }
        let ownerOp = op
        // A preference may be quoted without the date Manor appended to it.
        if (file === 'preferences.md' && op.action !== 'add' && !exact) {
          const undated = (text: string) => bareLine(text).replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '')
          const matches = threadFileLines(current).filter((line) => undated(line) === undated(op.old))
          if (matches.length === 1) ownerOp = { ...op, old: matches[0]! }
        }
        // A Notes row is quoted without its marker, and a rewritten row stays its Session's.
        if (file === 'notes.md' && op.action !== 'add') {
          const matches = threadFileLines(current).filter((line) => noteText(line) === noteText(bareLine(op.old)))
          if (matches.length === 1) {
            const old = matches[0]!
            ownerOp = op.action === 'remove' ? { ...op, old } : { ...op, old, line: diskNote(bareLine(op.line), noteHandoff(old)) }
          }
        }
        const applied = applyThreadLineOp(current, ownerOp)
        if ('error' in applied) throw new Error(applied.error)
        const content = file === 'notes.md' ? await archiveCompletedNotes(paths, applied.content) : applied.content
        if (!await writeThreadFile(target, content, current)) continue
        this.known.set(target, content)
        const shown = (text: string) => noteText(bareLine(text))
        const noteId = ownerOp.action === 'remove' ? noteHandoff(ownerOp.old) : undefined
        return {
          op: ownerOp.action === 'add' ? { action: 'add', line: shown(ownerOp.line) }
            : ownerOp.action === 'remove' ? { action: 'remove', old: shown(ownerOp.old) }
              : { action: 'replace', old: shown(ownerOp.old), line: shown(ownerOp.line) },
          over: file === 'preferences.md' && overPreferencesBudget(content),
          archived: content !== applied.content,
          ...(noteId === undefined ? {} : { noteId }),
        }
      }
      throw new Error(`${file} kept changing while Manor wrote to it. Read it again and retry.`)
    })
  }

  /**
   * The event a write leaves in the thread. One with a line to put back can be undone;
   * a checked row that already left for the archive cannot.
   */
  private async recordWrite(
    context: UserInputContext, project: Project,
    write: Pick<ProjectFileWrite, 'file' | 'action' | 'line' | 'old' | 'noteId'>,
    undoable = true,
  ): Promise<void> {
    const stored: ProjectFileWrite = {
      ...write,
      ...(write.line === undefined ? {} : { line: write.line.slice(0, 2_000) }),
      ...(write.old === undefined ? {} : { old: write.old.slice(0, 2_000) }),
      by: PROJECT_THREAD_WRITER,
      turnId: context.turnId,
      ...(undoable && inverseWrite(write) !== undefined ? { writeId: randomUUID() } : {}),
    }
    await this.append(context.chatId, {
      type: 'system_note',
      kind: 'info',
      text: `${projectFileWriteLabel(stored, project.name)}: ${projectFileWriteDetail(stored) ?? ''}`,
      projectFileWrite: stored,
    })
  }

  /**
   * Undo on one write of the thread: the reverse line change, only while the line it
   * wrote still reads exactly that way. Returns why nothing was undone, or undefined when it was.
   */
  async undoWrite(threadChatId: string, write: ProjectFileWrite): Promise<string | undefined> {
    const project = await this.threadProject(threadChatId)
    const reverse = inverseWrite(write)
    if (project === undefined || reverse === undefined) return 'There is no memory write to undo here.'
    try {
      if (isProjectThreadFile(write.file)) {
        const back = reverse.action === 'add' && write.noteId !== undefined ? { ...reverse, line: diskNote(reverse.line, write.noteId) } : reverse
        await this.applyLine(project, write.file, back, true)
      } else {
        // A card only ever takes an add from the thread, so its Undo removes that dated line.
        const target = path.join(this.paths(project).folder, write.file)
        await withThreadFileLock(target, async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = await readThreadFile(target)
            if (isPinned(current)) throw new Error('This card is pinned.')
            const applied = applyThreadLineOp(current, reverse)
            if ('error' in applied) throw new Error(applied.error)
            if (await writeThreadFile(target, applied.content, current)) return
          }
          throw new Error(`${write.file} kept changing while Manor wrote to it.`)
        })
      }
    } catch (error) {
      return `Nothing was undone: ${error instanceof Error ? error.message : 'the file could not be written.'}`
    }
    return undefined
  }

  /**
   * A card beside the thread's files (2026-10-19): one dated line on a card its
   * MEMORY.md lists, or a new card they confirmed in this turn, because each new card adds
   * a catalogue row every persona pays for. Never a replace or a removal; rewriting a card
   * stays with a session the user runs.
   */
  private async writeCard(context: UserInputContext, project: Project, input: FileWriteInput): Promise<string> {
    const { file } = input
    if (!PROJECT_CARD_FILE.test(file)) {
      throw new Error('A card is a lowercase .md filename in this project\'s memory folder, such as project_<project>_<topic>.md.')
    }
    if (input.action !== 'add' && input.action !== 'create') {
      throw new Error('A card takes add (one dated line on its Decision section) or create. Replacing or removing card text needs a session the user runs.')
    }
    if (input.line === undefined) throw new Error(`${input.action} on a card needs \`line\`.`)
    const line = datedPreference(input.line, new Date())
    const paths = this.paths(project)
    const target = path.join(paths.folder, file)
    await ensureProjectThreadFiles(paths, project.name)
    if (input.action === 'add') {
      if (!indexedCards(await readThreadFile(paths.index)).has(file)) {
        throw new Error(`${file} is not a card in this project's MEMORY.md. Add to a listed card, or propose a new one with create.`)
      }
      await withThreadFileLock(target, async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await readThreadFile(target)
          if (current === '') throw new Error(`${file} is listed in MEMORY.md but missing on disk.`)
          if (isPinned(current)) throw new Error('This card is pinned.')
          const applied = appendCardDecision(current, line)
          if ('error' in applied) throw new Error(applied.error)
          if (await writeThreadFile(target, applied.content, current)) return
        }
        throw new Error(`${file} kept changing while Manor wrote to it. Try again in a moment.`)
      })
    } else {
      const { title, description, when } = input
      if (title === undefined || description === undefined || when === undefined) {
        throw new Error('create needs title, description, when and line.')
      }
      if (!await this.confirmedCard(context, file)) {
        throw new Error(`Ask the user first: call ask_user with a question that names ${file}, the confirming option first. create works only after they pick that option in this turn.`)
      }
      const card = newCard({ file, title, description, when, line })
      if ('error' in card) throw new Error(card.error)
      const exists = () => new Error(`${file} already exists. Add a line to it instead.`)
      await withThreadFileLock(paths.index, () => withThreadFileLock(target, async () => {
        if (isPinned(await readThreadFile(paths.index))) throw new Error('This project\'s MEMORY.md is pinned.')
        if (indexedCards(await readThreadFile(paths.index)).has(file)) throw exists()
        if (!await createThreadFile(target, card.content)) throw exists()
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const index = await readThreadFile(paths.index)
          if (indexedCards(index).has(file)) return
          const next = `${index.length === 0 || index.endsWith('\n') ? index : `${index}\n`}${card.row}\n`
          if (await writeThreadFile(paths.index, next, index)) return
        }
        // Only Manor's own untouched copy goes; a card someone else changed meanwhile stays.
        if (await readThreadFile(target) === card.content) await rm(target, { force: true })
        throw new Error('MEMORY.md kept changing while Manor listed the card, so the card was not created. Try again in a moment.')
      }))
    }
    await this.recordWrite(context, project, { file, action: input.action, line })
    return input.action === 'add' ? `Saved one dated line on ${file}.` : `Created ${file} and listed it in MEMORY.md.`
  }

  /** The user picked the confirming (first) option of an ask_user question naming this card, in this turn. */
  private async confirmedCard(context: UserInputContext, file: string): Promise<boolean> {
    const events = await this.options.store.loadEvents(context.chatId)
    return events.some((request) => request.type === 'user_input_request' && request.turnId === context.turnId &&
      events.some((response) => response.type === 'user_input_response' && response.requestId === request.requestId &&
        request.questions.some((question) => {
          const answer = response.answers[question.id]
          return question.question.includes(file) && answer !== undefined &&
            userInputAnswerLines(answer).includes(question.options[0]!.label)
        })))
  }

  /** A persona who may not write the files reports to the thread; it reads the report in its next turn. */
  async report(context: UserInputContext, input: ProjectReportInput): Promise<string> {
    if (!this.options.isActiveTurn(context.chatId, context.agentId, context.turnId)) {
      throw new Error('Only a running turn can report to a project thread.')
    }
    const projects = []
    for (const candidate of await this.options.store.listProjects()) {
      const threadChatId = await this.liveThread(candidate)
      if (threadChatId !== undefined) projects.push({ ...candidate, threadChatId })
    }
    const project = projects.find((candidate) => candidate.id === input.project) ??
      projects.find((candidate) => normalize(candidate.name) === normalize(input.project))
    if (project === undefined) {
      throw new Error(`No project thread matches ${JSON.stringify(input.project)}. Projects with a thread: ${projects.map((candidate) => candidate.name).join(', ') || 'none'}.`)
    }
    if (project.threadChatId === context.chatId) throw new Error('The project thread writes its files itself.')
    await this.queueReport(project.threadChatId, {
      from: this.options.agentName(context.agentId),
      kind: input.kind,
      text: input.text.trim().slice(0, 2_000),
      ...(input.quote === undefined ? {} : { quote: input.quote.trim().slice(0, 2_000) }),
      sourceChatId: context.chatId,
    })
    return `Reported to the ${project.name} thread. It decides whether this goes into its files.`
  }

  /** The report note, waiting for the thread's next turn. */
  private async queueReport(threadChatId: string, report: NonNullable<Extract<ThreadEvent, { type: 'system_note' }>['projectReport']>): Promise<void> {
    const line = `- ${report.from} (${report.kind}): ${JSON.stringify(report.text)}${report.quote === undefined ? '' : `, the user said ${JSON.stringify(report.quote)}`}`
    await this.append(threadChatId, {
      type: 'system_note',
      kind: 'info',
      text: `${report.from} reports a ${report.kind === 'preference' ? 'preference' : 'note'}: ${report.text}`,
      projectReport: report,
      threadPending: line,
    })
  }

  /**
   * A thread-started session reached its goal with learnings. Its own status went to
   * notes.md through `set_session_status`; what is left waits for the thread's next turn.
   */
  async goalReached(handoffId: string): Promise<void> {
    const handoff = (await this.options.store.listWorkHandoffs()).find((row) => row.id === handoffId)
    if (handoff?.workChatId == null) return
    await this.idleTick()
    const linked = await this.sessionThread(handoff.workChatId)
    const learnings = handoff.goalReport?.learnings ?? []
    if (linked === undefined || learnings.length === 0) return
    await this.append(linked.threadChatId, {
      type: 'system_note',
      kind: 'info',
      text: `“${handoff.title}” reached its goal with ${learnings.length === 1 ? 'one learning' : `${learnings.length} learnings`} for this thread.`,
      threadPending: learningsPrompt(handoff.title, learnings),
    })
  }

  private sessionStatusRow(handoff: WorkHandoff) {
    const title = asLine(handoff.title)
    const ownLine = (content: string) => threadFileLines(content).find((existing) => noteHandoff(existing) === shortNoteId(handoff.id))
    return { title, ownLine }
  }

  /**
   * `start_work` from this thread writes the proposal's one Notes row, `[ ] <title>: proposed`
   * with its marker, before the call returns. A newer version takes over the row of the
   * one it replaces. From then on Accept, the Session's own status, Confirm, landed
   * commits and Reject all change that same row. A pinned file stays untouched.
   */
  async noteProposal(handoff: WorkHandoff): Promise<void> {
    const project = await this.options.store.getProject(handoff.projectId)
    if (project === undefined || this.options.structuredRoot === undefined || await this.liveThread(project) !== handoff.sourceChatId) return
    const id = shortNoteId(handoff.id)
    const replaced = new Set((await this.options.store.listWorkHandoffs())
      .filter((row) => row.supersededById === handoff.id).map((row) => shortNoteId(row.id)))
    const line = diskNote(proposedNote(handoff.title), handoff.id)
    const withRow = (content: string): string => {
      const rows = threadFileLines(content)
      if (rows.some((row) => noteHandoff(row) === id)) return content
      const previous = rows.find((row) => replaced.has(noteHandoff(row) ?? '') && /^\[ \] /.test(row))
      const applied = applyThreadLineOp(content, previous === undefined ? { action: 'add', line } : { action: 'replace', old: previous, line })
      return 'error' in applied ? content : applied.content
    }
    const paths = this.paths(project)
    await ensureProjectThreadFiles(paths, project.name, { files: ['notes.md'] })
    await withThreadFileLock(paths.notes, async () => {
      // A hand edit or pin made between the read and the write is kept, and the row redone on it.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await readThreadFile(paths.notes)
        if (isPinned(current)) return
        const next = withRow(current)
        if (next !== current && !await writeThreadFile(paths.notes, next, current)) continue
        // Only this row becomes known; any other change stays the owner guard's to judge.
        this.known.set(paths.notes, withRow(this.known.get(paths.notes) ?? current))
        return
      }
      throw new Error('notes.md kept changing while Manor wrote the proposal row.')
    })
  }

  /** Refuse a locked or unavailable Notes file before Confirm is stored. */
  async assertSessionStatusWritable(sessionChatId: string): Promise<void> {
    const linked = await this.sessionThread(sessionChatId)
    if (linked === undefined) return
    const paths = this.paths(linked.project)
    await withThreadFileLock(paths.notes, async () => {
      if (isPinned(await readThreadFile(paths.notes))) throw new Error('This project file is pinned.')
    })
  }

  /** Confirm and Close reconcile the source-bound row and archive its completed text with evidence. */
  async completeSessionStatus(sessionChatId: string): Promise<void> {
    const linked = await this.sessionThread(sessionChatId)
    if (linked === undefined) return
    await this.idleTick()
  }

  /**
   * A thread-started Session's one checkbox row in notes.md: `[ ] <title>: <status>`.
   * Confirmation checks it, reopening clears it, and other hand checks stay intact. It reaches no other line and never
   * preferences.md, and the owner guard keeps this write as known content.
   */
  async writeSessionStatus(context: UserInputContext, status: string): Promise<string> {
    if (!this.options.isActiveTurn(context.chatId, context.agentId, context.turnId)) {
      throw new Error('Only a running Session turn can write its status line.')
    }
    const linked = await this.sessionThread(context.chatId)
    if (linked === undefined) throw new Error('Only a Session its project thread started has a status line in notes.md.')
    const { project, handoff, threadChatId } = linked
    await this.idleTick()
    const { title, ownLine } = this.sessionStatusRow(handoff)
    const text = asLine(status)
    if (text.length === 0) throw new Error('`status` must be one non-empty line.')
    if (text.length > SESSION_STATUS_MAX) throw new Error(`\`status\` holds at most ${SESSION_STATUS_MAX} characters; this one has ${text.length}. Say what works and what stays open, shorter.`)
    const statusLine = `${title}: ${text}`
    let line = diskNote(`[ ] ${statusLine}`, handoff.id)
    const withLine = (content: string): string => {
      const previous = ownLine(content)
      if (previous === line) return content
      const applied = applyThreadLineOp(content, previous === undefined ? { action: 'add', line } : { action: 'replace', old: previous, line })
      if ('error' in applied) throw new Error(applied.error)
      return applied.content
    }
    const paths = this.paths(project)
    let old: string | undefined
    await ensureProjectThreadFiles(paths, project.name, { files: ['notes.md'] })
    await withThreadFileLock(paths.notes, async () => {
      const current = await readThreadFile(paths.notes)
      if (isPinned(current)) throw new Error('This project file is pinned.')
      old = ownLine(current)
      const currentHandoff = await this.options.store.workHandoffForTarget(context.chatId)
      const confirmed = currentHandoff !== undefined && confirmedAndLanded(currentHandoff) && currentHandoff.unsettledAt === undefined
      const reopened = currentHandoff?.unsettledAt !== undefined || (currentHandoff?.goalConfirmations?.length ?? 0) > 0
      const check = confirmed ? '[x]' : reopened ? '[ ]' : old?.match(/^\[[ xX]\]/)?.[0] ?? '[ ]'
      line = diskNote(`${check} ${statusLine}`, handoff.id)
      if (old !== undefined && noteText(old) === noteText(line)) line = old
      if (old !== line) await writeThreadFile(paths.notes, withLine(current))
      // Only this line becomes known, also when the file already read it: any other
      // change in the file stays the guard's to judge.
      this.known.set(paths.notes, withLine(this.known.get(paths.notes) ?? current))
    })
    if (old === line) return 'Your status line in notes.md already reads that.'
    const write: ProjectFileWrite = {
      file: 'notes.md',
      action: old === undefined ? 'add' : 'replace',
      line: noteText(line).slice(0, 2_000),
      ...(old === undefined ? {} : { old: noteText(old).slice(0, 2_000) }),
      by: title.slice(0, 200),
    }
    await this.append(threadChatId, {
      type: 'system_note',
      kind: 'info',
      text: `${projectFileWriteLabel(write, project.name)}: ${projectFileWriteDetail(write) ?? ''}`,
      projectFileWrite: write,
    })
    await this.idleTick()
    return `Saved your status line in the ${project.name} notes.md.`
  }

  /**
   * Accept on a DM brief for a project with a thread hands the brief to that thread,
   * which starts the session itself in one turn. The approved prompt and the user's choices
   * are stored on the brief, so only the card made for it inherits them, also after a
   * restart. True when it was handed over.
   */
  async forwardBrief(handoff: WorkHandoff, options: AcceptOptions, task?: string): Promise<boolean> {
    const project = await this.options.store.getProject(handoff.projectId)
    const threadChatId = await this.liveThread(project)
    if (project === undefined || threadChatId === undefined || handoff.sourceChatId === threadChatId) return false
    const now = Date.now()
    const saved = await this.options.store.linkWorkHandoff(handoff.id, {
      acceptedAt: now, forwardedAt: now, forwardAccept: options, ...(task === undefined ? {} : { task }),
    }, {
      type: 'system_note',
      kind: 'info',
      text: `Session “${handoff.title}” was forwarded to ${project.name}.`,
      workHandoffId: handoff.id,
    })
    const receipt = [...await this.options.store.loadEvents(saved.sourceChatId)].reverse().find((event) =>
      event.type === 'system_note' && event.workHandoffId === saved.id && event.workHandoffVersion === saved.version)
    if (receipt !== undefined) this.options.emit({ type: 'event', chatId: saved.sourceChatId, event: receipt })
    await this.options.broadcastDirectory()
    this.wakeForBrief(threadChatId, saved)
    return true
  }

  private wakeForBrief(threadChatId: string, brief: WorkHandoff): void {
    const author = brief.authorAgentId === undefined ? 'A persona' : this.options.agentName(brief.authorAgentId)
    const { instruction, text } = briefPrompt(author, brief)
    // One turn per brief, since each must leave its own card; a brief whose card exists by then needs none.
    this.options.wake(threadChatId, { source: 'project_thread', reason: 'brief' }, async () => {
      const handoffs = await this.options.store.listWorkHandoffs()
      const current = handoffs.find((row) => row.id === brief.id)
      const carded = current?.threadHandoffId !== undefined ||
        handoffs.some((row) => row.sourceChatId === threadChatId && row.assignmentKey === `brief-${brief.id}`)
      // A project hidden since the hand-over starts nothing; the brief waits for its return.
      const hidden = (await this.options.store.getChat(threadChatId))?.archivedAt !== null
      if (current?.state !== 'active' || carded || hidden) return undefined
      return { instruction, text, delivered: [], ...attachmentFields(await loadHandoffAttachments(this.options.store, current.attachments ?? [])) }
    })
  }

  /**
   * The thread published a proposal. Only the card it made for a forwarded brief, named
   * by `brief-<id>` in the same project, is accepted with that brief's stored choices.
   * Its task must be the approved prompt exactly, or that prompt and a blank line before
   * any thread context; otherwise the session runs the approved prompt alone.
   */
  async proposed(handoff: WorkHandoff): Promise<void> {
    const briefId = BRIEF_KEY.exec(handoff.assignmentKey ?? '')?.[1]
    if (briefId === undefined) return
    const { store } = this.options
    const brief = (await store.listWorkHandoffs()).find((row) => row.id === briefId)
    if (brief?.forwardedAt === undefined || brief.projectId !== handoff.projectId) return
    if (await this.liveThread(await store.getProject(brief.projectId)) !== handoff.sourceChatId) return
    if (brief.threadHandoffId !== undefined && brief.threadHandoffId !== handoff.id) return
    if (brief.threadHandoffId === undefined) await store.linkWorkHandoff(brief.id, { threadHandoffId: handoff.id })
    const approved = (brief.task ?? brief.kickoff ?? brief.title).trim()
    const task = (handoff.task ?? '').trim()
    // Thread context may follow only after a blank line, so `Report.md.bak` is not `Report.md`.
    const carries = task === approved || task.startsWith(`${approved}\n\n`)
    await this.options.acceptHandoff(handoff.id, { ...brief.forwardAccept, ...(carries ? {} : { task: approved }) })
  }

  /**
   * After a restart: a forwarded brief whose card was never accepted is accepted now,
   * also when the card was linked before its acceptance failed, and one whose thread
   * never made a card wakes the thread again. A card the user rejected or that was
   * replaced stays as it is. A hidden project's briefs wait, and adding the project
   * back recovers its own.
   */
  async recoverBriefs(projectId?: string): Promise<void> {
    const { store } = this.options
    const handoffs = await store.listWorkHandoffs()
    for (const brief of handoffs) {
      if (brief.forwardedAt === undefined || brief.state !== 'active') continue
      if (projectId !== undefined && brief.projectId !== projectId) continue
      const threadChatId = await this.liveThread(await store.getProject(brief.projectId))
      if (threadChatId === undefined) continue
      const cards = handoffs.filter((row) => row.sourceChatId === threadChatId && row.assignmentKey === `brief-${brief.id}` &&
        (brief.threadHandoffId === undefined || row.id === brief.threadHandoffId))
      const open = cards.find((row) => row.state === 'active' && row.supersededById === undefined && row.acceptedAt === null)
      // One brief that still cannot start must not keep the others waiting.
      if (open !== undefined) await this.proposed(open).catch((error: unknown) => console.warn(`[manor] forwarded brief ${brief.id} could not start`, error))
      else if (cards.length === 0 && brief.threadHandoffId === undefined) this.wakeForBrief(threadChatId, brief)
    }
  }

  /**
   * Every owned file of every listed project, under that project. A hidden project is
   * neither tidied nor guarded: with no thread to route a write through, guarding would
   * leave its files writable by nobody until a re-add.
   */
  private async ownedFiles(): Promise<{ project: Project & { threadChatId: string }; file: ProjectThreadFile; target: string }[]> {
    if (this.options.structuredRoot === undefined) return []
    const owned = []
    for (const project of await this.options.store.listProjects()) {
      const threadChatId = await this.liveThread(project)
      if (threadChatId === undefined) continue
      const paths = this.paths(project)
      for (const file of ['preferences.md', 'notes.md'] as const) {
        owned.push({ project: { ...project, threadChatId }, file, target: threadFilePath(paths, file) })
      }
    }
    return owned
  }

  /** Every idle pass can archive trusted rows, even with another Session still running. */
  async idleTick(): Promise<void> {
    await this.adoptWhenIdle()
  }

  private async adoptWhenIdle(): Promise<void> {
    for (const { project, file, target } of await this.ownedFiles()) {
      await withThreadFileLock(target, async () => {
        const current = await readThreadFile(target)
        if (isPinned(current)) return
        if (file !== 'notes.md') {
          if (this.guarded.size === 0) this.known.set(target, current)
          return
        }
        const baseline = this.guarded.size === 0 ? current : this.known.get(target)
        if (baseline === undefined) return
        try {
          const now = Date.now()
          const working = hydrateNotes(baseline, await this.options.store.loadNoteAges(project.id), now)
          const evidence = await loadNotesEvidence(this.options.store, project.threadChatId, working, now, this.noteSources.get(target))
          this.noteSources.set(target, evidence.sources)
          // Rows go back to disk with only their Session's short id; their dates stay in the store.
          const { content: reconciled, ages } = dehydrateNotes(reconcileNotes(evidence.rows, evidence.sessions, evidence.git).join('\n'))
          await this.options.store.saveNoteAges(project.id, ages)
          // Server changes apply only to exact trusted rows. Pending foreign edits stay guarded.
          const oldRows = baseline.split('\n')
          const newRows = reconciled.split('\n')
          const replacements = new Map(oldRows.map((row, at) => [row, newRows[at]!]))
          const updated = current.split('\n').map((row) => replacements.get(row) ?? row).join('\n')
          const accepted = await archiveCompletedNotes(this.paths(project), reconciled)
          const content = removeTrustedCompletedNotes(updated, reconciled)
          if (await readThreadFile(target) !== current) return
          if (content !== current) await writeThreadFile(target, content)
          this.known.set(target, this.guarded.size === 0 ? content : accepted)
        } catch (error) {
          console.warn('[manor] Completed Notes could not be archived', error)
          if (this.guarded.size === 0) this.known.set(target, await readThreadFile(target))
        }
      })
    }
  }

  /**
   * Start of a turn the guard watches. When idle, archive completed hand-edited Notes
   * and adopt the remaining content, so a later undo keeps those accepted edits.
   */
  async turnStarted(turnId: string): Promise<void> {
    if (this.guarded.size === 0) await this.adoptWhenIdle()
    this.guarded.add(turnId)
  }

  /**
   * End of every turn that is not a project thread's own. A change to an owned file
   * that this turn demonstrably wrote, with an edit tool or a shell write whose
   * destination resolves to the file, is undone and reported to the thread. Any other change waits until the last
   * overlapping guarded turn has checked. Completed hand-edited Notes are then archived
   * and the remaining content becomes known. The restore reaches the thread with its next turn.
   */
  async turnEnded(turn: GuardedTurn & { turnId: string }): Promise<void> {
    try {
      for (const { project, file, target } of await this.ownedFiles()) {
        if (project.threadChatId === turn.chatId) continue
        await withThreadFileLock(target, async () => {
          const current = await readThreadFile(target)
          const known = this.known.get(target)
          // Only a path that resolves to this very file is evidence; a guess would undo the user.
          const wrote = [...turn.editedPaths, ...turn.shellWrites ?? []].some((written) =>
            path.isAbsolute(written) && path.resolve(written) === path.resolve(target))
          if (known === undefined || current === known || !wrote) return
          await writeThreadFile(target, known)
          const who = this.options.agentName(turn.agentId)
          await this.append(turn.chatId, {
            type: 'system_note', kind: 'info', agentId: turn.agentId,
            text: `Restored ${file}: only the ${project.name} project thread writes it. The change went to the thread as a report.`,
          })
          const restore: ProjectFileWrite = { file, action: 'restore', by: who }
          await this.append(project.threadChatId, {
            type: 'system_note', kind: 'info',
            text: `${projectFileWriteLabel(restore, project.name)}: ${projectFileWriteDetail(restore) ?? ''}`,
            projectFileWrite: restore,
          })
          const added = threadFileLines(current).filter((line) => !threadFileLines(known).includes(line))
          await this.queueReport(project.threadChatId, {
            from: who,
            kind: file === 'preferences.md' ? 'preference' : 'note',
            text: added.length === 0 ? `Tried to change ${file} directly; the change was undone.` : added.join(' / ').slice(0, 2_000),
            sourceChatId: turn.chatId,
          })
        })
      }
    } finally {
      this.guarded.delete(turn.turnId)
      await this.adoptWhenIdle().catch(() => undefined)
    }
  }
}

/** Heads what rides along with a turn that runs for another reason, such as the user's message. */
const QUEUED_ALONGSIDE = '[Manor] Queued for this thread since its last turn. Handle it in this turn too, after the message above. Each item\'s instructions, "nothing else" included, cover that item only; mention an item only when you wrote something for it.'

/** Heads a wake that carries more than one item. */
const QUEUED_TOGETHER = '[Manor] Several items for this thread. Each item\'s instructions, "nothing else" included, cover that item only.'

/** What a brand-new project's thread is told, once: look around, then greet. */
export function welcomePrompt(projectName: string, repoPaths: readonly string[]): string {
  const look = repoPaths.length === 0
    ? 'The project has no folder yet, so there is nothing to read.'
    : `First get to know the project by reading its ${repoPaths.length === 1 ? 'folder' : 'folders'}: ${repoPaths.join(', ')}. Look at the top level, the README and the main manifest or entry point. Stop once you can say in a sentence what this project is; do not read everything.`
  return [
    `[Manor] This is the new project thread for ${projectName}. The user made the project a moment ago and opens this thread for the first time.`,
    look,
    'Then write one short welcome, in the language the user writes in, of at most four sentences. Open the message with exactly "Hi <first name> \u{1F44B}" (the waving hand directly after the first name), then the rest of the welcome. When you do not know the name, open with "Hi \u{1F44B}". '
      + (repoPaths.length === 0 ? '' : 'Say in one sentence what you understood this project to be. ')
      + 'Tell them they can hand you one thing or a whole list, and that you start the Sessions for the work and keep them posted here. '
      + `End with one concrete suggestion for where to start${repoPaths.length === 0 ? '' : ', taken from what you read'}.`,
    'This turn only says hello: start no work, ask no question with ask_user, and write nothing to your files.',
  ].join('\n')
}

function seedPrompt(projectName: string, paths: ProjectThreadPaths): string {
  return [
    `[Manor] This is the new project thread for ${projectName}. You own two files: ${paths.preferences} and ${paths.notes}.`,
    `Propose a seed. For notes.md, the current status lines from ${path.resolve(paths.folder, '..', '..', 'projects')}/<slug>.md for this project, when that file exists. For preferences.md, the preference-shaped lines in the project's topic notes in ${paths.folder} (things the user wants or does not want), each with its source file and line.`,
    'Show the seed to the user with ask_user, confirming option first. Write only what they confirm, one line per update_project_file call, and remove each moved line from its source file so no old copy contradicts it later. If there is nothing to seed, say so in one sentence.',
  ].join('\n')
}

function questionPrompt(title: string, asker: string, requestId: string, questions: readonly UserInputQuestion[]): string {
  return [
    `[Manor] The session “${title}” is waiting on a question from ${asker} (requestId ${requestId}):`,
    JSON.stringify(questions.map((question) => ({ id: question.id, question: question.question, options: question.options.map((option) => option.label), ...(question.multi ? { multi: true } : {}) }))),
    'Check preferences.md. When one of its lines answers every question, call answer_session_question with this requestId, an answer per question id, and that line quoted in `preference`. Otherwise do not answer: the card waits for the user here, and your reply stands on it as your advice. Reply with the option you would pick and why, in one or two sentences, without restating the question; with no pick, say in one sentence what the user needs to weigh. Start no session and send nothing else to the session.',
  ].join('\n')
}

function answerPrompt(title: string, questions: readonly UserInputQuestion[], answers: UserInputAnswers): string {
  return [
    `[Manor] The user answered a question from the session “${title}” themselves:`,
    ...questions.map((question) => `- ${JSON.stringify(question.question)}: ${JSON.stringify(answers[question.id] === undefined ? '' : userInputAnswerText(answers[question.id]!))}`),
    'Apply the write rule. Keep this as a preference only when it is lasting: they said it holds beyond this session, it corrects an agent, or it repeats an earlier wish. A one-off choice for this session is not one. Replace an older line it supersedes. Use update_project_file and nothing else; if nothing qualifies, say so in one sentence.',
  ].join('\n')
}

/** What the Session reads, in the user's voice, when they replace the thread's answer. */
function changedAnswerMessage(questions: readonly UserInputQuestion[], answers: UserInputAnswers, before: UserInputAnswers): string {
  return [
    'I am changing the answer Manor gave you from my preferences. Go with mine, and redo what rested on Manor\'s.',
    ...questions.map((question) => {
      const was = before[question.id]
      return `${JSON.stringify(question.question)}: ${userInputAnswerText(answers[question.id]!)}${was === undefined ? '' : `, not ${userInputAnswerText(was)}`}`
    }),
  ].join('\n')
}

function changedAnswerPrompt(title: string, questions: readonly UserInputQuestion[], answers: UserInputAnswers, quote: string | undefined): string {
  return [
    `[Manor] The user overruled the answer this thread gave the session “${title}”${quote === undefined ? '' : ` from the line ${JSON.stringify(quote)}`}:`,
    ...questions.map((question) => `- ${JSON.stringify(question.question)}: ${JSON.stringify(userInputAnswerText(answers[question.id]!))}`),
    'Apply the write rule. When their choice holds beyond this session, replace the line it overrules; a one-off choice for this session changes nothing. Use update_project_file and nothing else; if nothing qualifies, say so in one sentence.',
  ].join('\n')
}

function reportPrompt(lines: readonly string[]): string {
  return [
    '[Manor] Reports for this project from someone who may not write its files:',
    ...lines,
    'Apply the write rule. Write a preference only when the user stated it, corrected an agent or repeated a wish; a one-off ask is not one. Replace an older line it supersedes instead of adding a contradiction. Update notes.md in place for status. Use update_project_file and nothing else.',
  ].join('\n')
}

function learningsPrompt(title: string, learnings: readonly GoalLearning[]): string {
  return [
    `[Manor] The session “${title}” reached its goal and reported what it learned:`,
    ...learnings.map((learning) => `- ${learning.kind}: ${JSON.stringify(learning.text)}${learning.quote === undefined ? '' : `, the user said ${JSON.stringify(learning.quote)}`}`),
    'Fold these into preferences.md and notes.md under the write rule, with update_project_file. Drop what the rule rejects. Its result card above waits for the user; do not confirm or commit anything.',
  ].join('\n')
}

/** The thread's transcript shows only the task, which is the message's text; the rest is its instruction. */
function briefPrompt(author: string, handoff: WorkHandoff): { instruction: string; text: string } {
  const head = [
    `[Manor] ${author} handed this brief over from a DM, and the user already accepted it there. Call start_work in this turn with assignmentKey brief-${handoff.id}, this title, and the task below word for word. Add only what the session needs from notes.md after it, separated by a blank line. Keep ${handoff.firstExecutor?.agentName ?? handoff.leadAgentName} as firstExecutor. Do not ask the user again.`,
    `Title: ${handoff.title}`,
    ...(handoff.firstExecutor === undefined ? [] : [`First executor: ${handoff.firstExecutor.agentName}`]),
    ...(handoff.attachments === undefined || handoff.attachments.length === 0 ? [] : [
      `Attachments: ${handoff.attachments.map((attachment) => attachment.name).join(', ')}. They are on this message and go with your card by themselves; do not attach them again.`,
    ]),
    'Task:',
  ]
  return { instruction: `${head.join('\n')}\n`, text: handoff.task ?? handoff.kickoff ?? handoff.title }
}
