import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from 'react'
import { ArrowUp01Icon, Attachment01Icon, BotIcon, BoxIcon, ComputerIcon, File01Icon, Globe02Icon, Image01Icon, MessageMultiple01Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import { MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_QUOTES, MAX_PAGE_CONTEXT_ATTACHMENTS, addsAgentMention, compactQuoteRefs, formatImageRef, imageRefSpans, quoteRefSpans, renumberImageRefs, snapRefDeletion } from '@manor/contracts'
import { insertQuote } from '@manor/client-runtime/message-quotes'
import type { AgentConfig, ChatCommandContext, ChatOverride, InlineQuote, MessageReply, PageContextAttachment, SkillConfig } from '@manor/contracts'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import { accentStyle } from '../accent'
import {
  activeImageRef,
  activeMention,
  activeSkill,
  applyImageRef,
  addressDraft,
  applyMention,
  applySkill,
  composerRecipients,
  eligibleSkills,
  insertTrigger,
  matchAgents,
  matchesBrowserMention,
  matchesWorkMention,
  matchFiles,
  matchImageRefs,
  matchSkills,
  parseMentions,
  replyFallbackTargets,
} from '../mentions'
import { desktopComputer } from '../desktopBrowser'
import { composerEscapeStep, useReplyOnType } from '../focusMode'
import { CHAT_ATTACH_ACCEPT, isAttachable, readAttachments } from '../chatFiles'
import { base64Bytes, describeBytes, utf8Size, type ComposerAttachments } from '@manor/client-runtime/attachments'
import { scrollCaretIntoView } from '../caretScroll'
import { COMPOSER_GROW, INSTANT, SPRING_COMPOSER } from '../motion'
import { EMPTY_DRAFT, appendedText, readDraft, subscribeDraftInsert, writeDraft } from '../composerDrafts'
import { continueComposerList, normalizeComposerLists, startComposerList } from '@manor/client-runtime/composer-formatting'
import { effectiveDriver, isAutoPending, runtimeParts } from '../runtimeChoices'
import { Avatar } from './Avatar'
import { FileMark } from './fileMark'
import { ContextRing } from './ContextRing'
import type { ContextMeter } from '@manor/client-runtime/context-meter'
import { chatCommandRows, commandDraft, draftCommandRefusal, type ChatCommandRow } from '@manor/client-runtime/chat-commands'
import { ComposerEditor, IMAGE_REF_DRAG_TYPE, type ComposerEditorHandle } from './ComposerEditor'
import { ImageNumberBadge } from './MentionText'
import { COMPOSER_CARD_HEIGHTS, useComposerCardHeight, useComposerRow, type ComposerCardHeights } from './useComposerCardHeight'
import { Icon } from './Icon'
import { ProviderMark } from './ProviderMark'
import { PageContextChip } from './PageContextChip'
import { ReplyContextChip } from './ReplyContextChip'
import { RuntimeLabel } from './RuntimeLabel'
import { IconSwap } from './ui/IconSwap'
import { MENU_SURFACE, MenuItem } from './ui/Menu'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'
import { ZoomableImage } from './ui/ZoomableImage'
import { useHostAuto } from '../useHostAuto'

const MAX_TEXTAREA_PX = 200
/** A one-row card is a pill. `rounded-full` is also what opts a corner out of the squircle. */
const PILL = 'rounded-full'
const NO_MENTIONABLE_AGENTS: AgentConfig[] = []
const NO_RECIPIENTS: AgentConfig[] = []
const NO_FILES: string[] = []
const NO_SKILLS: SkillConfig[] = []
const NO_QUOTES: InlineQuote[] = []
const NO_PAGE_CONTEXTS: PageContextAttachment[] = []
const NO_OVERRIDES: Record<string, ChatOverride> = {}

/** One mention menu names every target this composer can reach. */
export function plusMentionLabel(
  canMentionAgents: boolean,
  hasFiles: boolean,
  extras: { browser?: boolean; computer?: boolean; work?: boolean } = {},
): string | null {
  const browser = extras.browser !== false
  const computer = extras.computer === true
  const work = extras.work === true
  if (computer) {
    const targets = [canMentionAgents && 'agent', hasFiles && 'file', browser && 'browser', 'computer', work && 'Sessions'].filter((part): part is string => Boolean(part))
    return `Mention ${targets.slice(0, -1).join(', ')} or ${targets[targets.length - 1]}`
  }
  if (!canMentionAgents && !hasFiles) {
    if (browser && work) return 'Use the Manor browser or send to Sessions'
    if (browser) return 'Use the Manor browser'
    if (work) return 'Send to Sessions'
    return null
  }
  if (!canMentionAgents) {
    if (work && !browser) return 'Reference a file or send to Sessions'
    if (browser && work) return 'Reference a file, browser or Sessions'
    if (browser) return 'Reference a file or browser'
    return 'Reference a file'
  }
  const rest = [hasFiles && 'file', browser && 'browser', work && 'Sessions'].filter((part): part is string => Boolean(part))
  if (rest.length === 0) return 'Mention an agent'
  if (rest.length === 1) return `Mention an agent or ${rest[0]}`
  return `Mention an agent, ${rest.slice(0, -1).join(', ')} or ${rest[rest.length - 1]}`
}

/** One autocomplete row. Every kind shares the list and its keyboard behaviour. */
type MentionRow =
  | { kind: 'browser' }
  | { kind: 'computer' }
  | { kind: 'work' }
  | { kind: 'agent'; agent: AgentConfig }
  | { kind: 'file'; path: string }
  | { kind: 'skill'; skill: SkillConfig }
  | { kind: 'image'; number: number }
  | { kind: 'command'; command: ChatCommandRow }

interface ComposerProps {
  /** The personas this room can seat: the `@` picker offers these. */
  agents: AgentConfig[]
  /** Read only when a draft opens with `/`, because it walks the transcript. Absent sends commands unchecked. */
  commandContext?: (() => ChatCommandContext) | undefined
  /**
   * The whole roster typed names are read against, as the server reads them. A name
   * outside `agents` is a mention that reaches nobody, not a fall back. Defaults to `agents`.
   */
  household?: AgentConfig[]
  /**
   * This chat's pins, so a mention row names the model the turn will actually run
   * on rather than the persona's saved one. Absent means no pins, not no chat.
   */
  overrides?: Record<string, ChatOverride>
  /**
   * Mentionable files in this project's linked folders, as `<folder-name>/<path>`.
   * Empty is the ordinary state for a project with no folder linked, and also what a
   * listing that has not arrived yet looks like: the menu simply offers personas.
   */
  files?: string[]
  /** The server's cap cut the file list, which the menu says out loud. */
  filesTruncated?: boolean
  /** Imported skills. Agent attachment decides which ones the `$` menu offers. */
  skills?: SkillConfig[]
  /**
   * Who an un-mentioned draft goes to — the DM's recipient or the chat's follow-up
   * target — so the `$` menu offers that persona's skills. Absent means the chief
   * of staff, the server's last fallback.
   */
  fallbackTargets?: AgentConfig[]
  /** DMs have a fixed recipient, so another persona cannot be addressed from them. */
  allowAgentMentions?: boolean
  /**
   * The draft just gained a persona tag it did not have. The new-session stage uses
   * it to leave Single for Multiple; everywhere else it stays unset.
   */
  onAgentMention?: () => void
  /** Work is a DM-only destination, separate from addressing another agent. */
  allowWorkDestination?: boolean
  /** Tool-free side chats cannot target the integrated browser. */
  allowBrowserMentions?: boolean
  /** Computer use is a Mac desktop capability, never a phone or side chat target. */
  allowComputerMentions?: boolean
  /**
   * Whether pictures and text files can ride along. False in the side panel, and not
   * only to keep a narrow card tidy: an attachment reaches a persona as a path on disk
   * or as quoted text, and the panel's whole promise is a voice that holds no tools at
   * all.
   */
  allowAttachments?: boolean
  /**
   * Whether `$` means anything here. False where no skill could run whatever is
   * imported: the menu deliberately opens with no rows to explain the trigger, and
   * that explanation ("import one under Plugins → Skills") is a wrong answer in a panel whose
   * voice can never run one.
   */
  allowSkills?: boolean
  /** A bare session offers the imported registry without filtering through a persona. */
  allSkillsAvailable?: boolean
  /**
   * Name who the draft would reach, next to the plus. Only a thread that has
   * begun earns it: there routing is history-dependent and worth saying out
   * loud, while the new-chat stage and a DM already name their addressee.
   */
  showRecipients?: boolean
  /**
   * Invited ids of a group. Mentions are parsed against the full roster, then
   * filtered to this set, the way the server drops an outsider. Absent in a
   * project chat, which has no membership.
   */
  memberIds?: readonly string[]
  /**
   * A turn is running or queued, so an unmarked draft's follow-up target is
   * not yet known. Explicit mentions stay visible; the label must not guess.
   */
  recipientsUnknown?: boolean
  /**
   * The one agent a message sent now would steer: exactly one turn runs in this chat and
   * the draft addresses no one else. Names that agent where an unknown follow-up target
   * would otherwise read "…". Absent keeps the "…".
   */
  steeredAgent?: AgentConfig
  /** Contextual copy. A DM names its recipient and deliberately omits the `@` hint. */
  placeholder?: string
  /**
   * Which draft this composer is editing — a chat id, or the new-chat stage's own
   * key. Changing it parks the current draft under the old key and picks up the
   * new one. Absent means nothing is remembered, which is what a composer with no
   * stable identity wants.
   */
  draftKey?: string
  /** False means the socket rejected the send and the draft must stay intact. */
  onSend: (
    text: string,
    attachments: ComposerAttachments,
    pageContexts: PageContextAttachment[],
    replyTo?: MessageReply,
    quotes?: InlineQuote[],
  ) => boolean
  /** Browser quotes attached to this draft. The browser owns adding; the chip owns removal. */
  pageContexts?: PageContextAttachment[]
  onRemovePageContext?: (id: string) => void
  /** A finished answer this draft explicitly responds to; one draft targets one answer. */
  replyTo?: MessageReply
  onRemoveReply?: () => void
  /** Selected words from one message; unlike replyTo this never affects routing. */
  /** False while the socket is down, creation is in flight, or no destination exists. */
  canSend: boolean
  /** Why sending is off, shown instead of the keyboard hint. */
  blockedNote: string
  /** Focus the input when it is the primary action on an empty stage. */
  autoFocus?: boolean
  /**
   * Chat-scoped runtime menus in the bottom row. Slots rather than knowledge, so
   * the composer stays dumb about what a chat is; the new-chat stage simply passes
   * nothing.
   */
  controls?: ReactNode
  /**
   * Single Work session fill, drawn next to send. Absent on new-chat, Multiple,
   * DM, house and side, so the composer never decides who gets a ring.
   */
  contextMeter?: ContextMeter
  /**
   * Where this chat writes, as its own row under the card. Outside it on purpose: it
   * describes the whole thread rather than the draft in the box, and it is read before
   * every send while being set roughly once.
   */
  checkout?: ReactNode
  /**
   * Stops every turn running in this chat. Given only where a chat exists, so
   * the new-chat stage never grows a stop button.
   */
  onStop?: () => void
  /** Whether this chat has a turn in flight, which is what turns Send into Stop. */
  running?: boolean
  /** Makes the phone's important composer controls explicit and finger-sized. */
  touchMode?: boolean
  /**
   * The side panel's narrower build: a shorter resting box and smaller round controls,
   * because a panel beside a chat has less room to spend and a shorter question to hold.
   * Ignored under `touchMode`, where finger size wins over saved pixels.
   */
  compact?: boolean
  /**
   * The card's height range on the desktop (`COMPOSER_CARD_HEIGHTS`): at the foot of any
   * chat, or centred on a new chat's page. The card then grows with the draft up to its
   * max and the text scrolls inside it. Absent keeps the editor's own sizing, for the
   * side chat's shorter box; ignored under `touchMode`.
   */
  heights?: ComposerCardHeights
  /**
   * Rests as one row, plus, text and send on a line, and stacks into the usual card once
   * the draft is more than one plain line. For a DM, whose composer has nothing else to
   * hold. Needs `heights`, so it is ignored under `touchMode` too.
   */
  oneRow?: boolean
  /**
   * The composer's own box, for whoever has to read where it was standing before it
   * was replaced by another one.
   */
  boxRef?: MutableRefObject<HTMLDivElement | null>
  /**
   * The top of that box a moment ago, in viewport pixels, handed over exactly once: a
   * new chat's composer arrives at the foot of the thread it just created, and paints
   * at the old top before springing to the real one. Absent every other time, which is
   * what keeps switching views instant. Deliberately measured rather than a shared
   * `layoutId`, because that name would have to be worn from the first render by both
   * boxes, and then every view switch and every line the textarea grows would travel
   * too.
   */
  travelFrom?: number | null
  /**
   * ⌘. reading (`focusMode.ts`): the box waits out of sight and out of the pointer's
   * way, still in layout. A typed key or focus brings it back; a send or Esc puts it
   * away. Not hover: the thread's foot is where Jump to latest sits.
   */
  focusMode?: boolean
  /** New-Session stage only: Escape with nothing open drops the project. Absent, there is nothing to drop. */
  onEscapeIdle?: () => void
}

/**
 * Nothing here is disabled while a turn runs. Queueing is the server's job, so
 * the user can keep typing and keep sending into a busy thread — which is why
 * the one button flips to Stop only on an empty draft. The moment there is
 * something to send, sending wins.
 */
/**
 * With nothing above the text in a sized card (no image, chip or quote, `:has` sees an
 * image row until its fold-out ends), the text's scroller reaches up through the card's
 * top padding, so scrolled text runs to the border instead of stopping short of it. The
 * value is the card's own padding, `p-3` or `p-2`; the scroller spends it on margin and
 * padding at once, so the text stands where it did.
 */
const CARD_REACH = '[&:not(:has([data-composer-above]:not(:empty)))]:[--composer-reach:12px]'
const CARD_REACH_DENSE = '[&:not(:has([data-composer-above]:not(:empty)))]:[--composer-reach:8px]'

export function Composer({ agents, commandContext, household, overrides = NO_OVERRIDES, files = NO_FILES, filesTruncated = false, skills = NO_SKILLS, fallbackTargets, allowAgentMentions = true, onAgentMention, allowWorkDestination = true, allowBrowserMentions = true, allowComputerMentions, allowAttachments = true, allowSkills = true, allSkillsAvailable = false, showRecipients = false, memberIds, recipientsUnknown = false, steeredAgent, placeholder, draftKey, onSend, pageContexts = NO_PAGE_CONTEXTS, onRemovePageContext, replyTo, onRemoveReply, canSend, blockedNote, autoFocus = false, controls, contextMeter, checkout, onStop, running = false, touchMode = false, compact = false, heights, oneRow = false, boxRef, travelFrom = null, focusMode = false, onEscapeIdle }: ComposerProps) {
  const hostAuto = useHostAuto()
  const canMentionComputer = (allowComputerMentions ?? desktopComputer() !== undefined) && !touchMode
  const reduceMotion = useReducedMotion()
  /** One size for every round control in the row, so they never disagree about the line. */
  const controlSize = touchMode ? 'h-11 w-11' : compact ? 'h-7 w-7' : 'h-8 w-8'
  const dense = compact && !touchMode
  const rootRef = useRef<HTMLDivElement | null>(null)
  const travelY = useMotionValue(0)
  const travelled = useRef(false)
  const travelAnimation = useRef<ReturnType<typeof animate> | null>(null)
  // Motion's host keeps a compositor layer even at `y: 0`. The new-chat box never
  // travels, so it is a plain div. Arrival is the only mount that uses motion, and
  // the translate lasts only while that spring is running.
  const [usesMotion, setUsesMotion] = useState(travelFrom !== null)
  const [travelLayer, setTravelLayer] = useState(travelFrom !== null)
  // One identity, so a re-render does not detach and reattach the node on every pass.
  const setRoot = (node: HTMLDivElement | null) => {
    rootRef.current = node
    if (boxRef !== undefined) boxRef.current = node
  }

  /**
   * The one move this box ever makes: it was standing in the middle of the new-chat
   * stage, and the chat it created put it at the foot of the thread. Measured in a
   * layout effect so the offset is on screen before the first paint, then sprung to
   * zero. Once per mount, because a second run would mean something other than that
   * one arrival asked for it.
   */
  useLayoutEffect(() => {
    if (travelFrom === null || travelled.current) return
    travelled.current = true
    if (reduceMotion) {
      setTravelLayer(false)
      return
    }
    const box = rootRef.current?.getBoundingClientRect()
    if (box === undefined) {
      setTravelLayer(false)
      return
    }
    const delta = travelFrom - box.top
    if (Math.abs(delta) < 1) {
      setTravelLayer(false)
      return
    }
    setUsesMotion(true)
    setTravelLayer(true)
    travelY.set(delta)
    travelAnimation.current = animate(travelY, 0, {
      ...SPRING_COMPOSER,
      onComplete: () => setTravelLayer(false),
    })
  }, [travelFrom, reduceMotion, travelY])
  // The draft drops travelFrom once its chat arrives. Let the move finish;
  // stopping it there would strand the composer at an intermediate offset.
  // Restore the initial state on cleanup so StrictMode can replay the effect.
  useLayoutEffect(() => () => {
    travelAnimation.current?.stop()
    travelY.set(0)
    travelled.current = false
  }, [travelY])
  const editorRef = useRef<ComposerEditorHandle>(null)
  // Focus within is what shows the box in focus mode, so putting it away is a blur.
  const putAway = () => {
    const held = document.activeElement
    if (held instanceof HTMLElement && rootRef.current?.contains(held) === true) held.blur()
  }
  // Entering starts in reading: a caret left in the box would keep it shown.
  useEffect(() => {
    if (focusMode) putAway()
  }, [focusMode, putAway])
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const plusRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pendingSelection = useRef<{ start: number; end: number } | null>(null)
  // The touch field's selection before an edit, so typing over a picked reference keeps what was typed.
  const touchSelection = useRef<{ start: number; end: number } | undefined>(undefined)
  const [value, setValue] = useState(() => readDraft(draftKey).text)
  // Focus lands before the key's default action, after the draft, so the key types there.
  useReplyOnType(focusMode && !touchMode, () => editorRef.current?.focusAt(value.length))
  // Past the end of a restored draft, where `autoFocus` puts the real caret and
  // where the plus menu should type into. Zero would insert `@` before the text.
  const [caret, setCaret] = useState(() => readDraft(draftKey).text.length)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [images, setImages] = useState(() => readDraft(draftKey).images)
  const [textFiles, setTextFiles] = useState(() => readDraft(draftKey).files)
  const [documents, setDocuments] = useState(() => readDraft(draftKey).documents ?? [])
  const [quotes, setQuotes] = useState(() => readDraft(draftKey).quotes ?? NO_QUOTES)
  /** The user left the caret in this field when they last pressed outside it. */
  const caretHeld = useRef(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const cardRange = touchMode || heights === undefined ? undefined : COMPOSER_CARD_HEIGHTS[heights]
  const cardMax = cardRange === undefined ? undefined : images.length > 0 ? cardRange.maxWithImage : cardRange.max
  useComposerCardHeight(cardRef, cardMax, draftKey)
  const [attachError, setAttachError] = useState<string | null>(null)
  // Why a command did not run, until the draft changes.
  const [commandNote, setCommandNote] = useState<string | null>(null)
  /**
   * How many slots are spoken for right now, reads in flight included. The rendered
   * counts cannot answer that: reading a dropped file is asynchronous, so a second
   * drop landing during the first one would measure a composer that still looks
   * empty and both would fit. The wire refuses the ninth attachment by dropping the
   * whole message in silence, so this is counted synchronously and reserved before
   * the first `await` rather than checked twice against stale state.
   */
  const staged = useRef(images.length + textFiles.length + documents.length)
  /**
   * Which draft the reads in flight belong to. Sending and switching chats empty this
   * composer, and a read that was still running when that happened has nothing left to
   * attach to: without this it would drop its picture into the message after the one it
   * was meant for, and leave `staged` counting a slot nobody is using. Bumping the
   * number is the cancel; every read checks the number it started under before it
   * touches anything.
   */
  const era = useRef(0)
  /**
   * How many reads are running for this draft. Sending waits for them, because a
   * message sent mid-read leaves without the attachment its sender watched go in —
   * silently, since the file lands in the emptied composer a moment later.
   */
  const [reading, setReading] = useState(0)
  const [plusOpen, setPlusOpen] = useState(false)
  const [recipientMenuOpen, setRecipientMenuOpen] = useState(false)
  const recipientMenuRef = useRef<HTMLDivElement>(null)
  /**
   * Something draggable is over the card. Counted rather than flagged, because
   * dragging across a child element fires a leave on the way in and the highlight
   * would flicker off under the cursor it is answering.
   */
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)

  // Read during cleanup, which runs long after the last render that could pass it
  // an argument. Written after every commit: a composer a parent unmounts does not
  // render in that commit, so the draft it shows is the one its last commit wrote.
  const liveDraft = useRef(EMPTY_DRAFT)
  const liveCaret = useRef(0)
  useLayoutEffect(() => {
    liveDraft.current = { text: value, images, files: textFiles, documents, quotes }
    liveCaret.current = caret
  })
  const parkedKey = useRef(draftKey)
  // The draft the state below holds. One render behind `draftKey` on a switch, when the
  // row reads the incoming draft from where it is parked instead.
  const [heldKey, setHeldKey] = useState(draftKey)

  const empty = value.trim() === '' && images.length === 0 && textFiles.length === 0 && documents.length === 0 && pageContexts.length === 0
  const showStop = running && empty && onStop !== undefined
  const rowDraft = heldKey === draftKey ? { text: value, images, files: textFiles, documents } : readDraft(draftKey)
  const row = useComposerRow(
    cardRef,
    oneRow && cardRange !== undefined,
    !rowDraft.text.includes('\n') && rowDraft.images.length === 0 && rowDraft.files.length === 0 && (rowDraft.documents ?? []).length === 0 &&
      pageContexts.length === 0 && replyTo === undefined &&
      // A note, an error or a read still under way belongs to the draft being left.
      (heldKey !== draftKey || (commandNote === null && attachError === null && reading === 0)),
    rowDraft.text === '',
    cardRange?.rest ?? 0,
    draftKey,
  )

  const mention = activeMention(value, caret)
  // A `$` that opens nothing is left as the character it is, so a price or a variable
  // typed into a composer with no skills behind it stays plain text.
  const skillQuery = allowSkills ? activeSkill(value, caret) : null
  const imageQuery = mention === null && skillQuery === null && allowAttachments ? activeImageRef(value, caret, images.length) : null
  const commandQuery = commandContext === undefined || images.length + textFiles.length + documents.length + pageContexts.length > 0 ? null : commandDraft(value)
  const completion = mention !== null
    ? { kind: 'mention' as const, ...mention }
    : skillQuery !== null
      ? { kind: 'skill' as const, ...skillQuery }
      : imageQuery !== null
        ? { kind: 'image' as const, ...imageQuery }
        : commandQuery === null ? null : { kind: 'command' as const, query: commandQuery, start: 0 }
  // Personas first and always: the roster is short, it is the reason `@` exists, and
  // a file list arriving later must never push a persona off the top of the menu.
  const mentionableAgents = allowAgentMentions ? agents : NO_MENTIONABLE_AGENTS
  const parsedAgents = allowAgentMentions ? household ?? agents : NO_MENTIONABLE_AGENTS
  // Compared against the previous value rather than hooked into the menu pick, so a
  // name typed out in full or pasted in counts the same as one picked from the list.
  const previousValue = useRef(value)
  useEffect(() => {
    const before = previousValue.current
    previousValue.current = value
    if (onAgentMention !== undefined && addsAgentMention(before, value, mentionableAgents)) onAgentMention()
  }, [value, mentionableAgents, onAgentMention])
  useEffect(() => setCommandNote(null), [value])
  const agentRows = completion?.kind === 'mention'
    ? matchAgents(mentionableAgents, completion.query)
      .filter((agent) => memberIds === undefined || memberIds.includes(agent.id))
    : []
  const fileRows = completion?.kind === 'mention' ? matchFiles(files, completion.query) : []
  const effectiveFallbackTargets = replyFallbackTargets(replyTo, agents, fallbackTargets, memberIds)
  // Read off `parsedAgents`, which is empty where mentions do not route: in a DM the
  // server parses none (`isSoloRoom`), so `@Smith $` there addresses the DM's persona
  // and must offer that persona's skills. Parsing the roster would offer Smith's.
  const availableSkills = allSkillsAvailable
    ? skills
    : eligibleSkills(value, parsedAgents, skills, effectiveFallbackTargets, memberIds, mentionableAgents)
  const skillRows = completion?.kind === 'skill' ? matchSkills(availableSkills, completion.query) : []
  /**
   * Who the draft reaches, for the label next to the plus. Parsed like the server
   * (`parsedAgents`, empty in a DM), then limited to who this room can seat.
   */
  const reached = showRecipients
    ? composerRecipients(value, parsedAgents, { fallback: effectiveFallbackTargets, memberIds, seats: mentionableAgents, busy: recipientsUnknown, replying: replyTo !== undefined })
    : NO_RECIPIENTS
  const followUpUnknown = reached === 'unknown'
  const recipients = reached === 'unknown' ? NO_RECIPIENTS : reached
  const matches: MentionRow[] = completion?.kind === 'command' && commandContext !== undefined
    ? chatCommandRows(commandContext(), completion.query).map((command): MentionRow => ({ kind: 'command', command }))
    : completion?.kind === 'skill'
    ? skillRows.map((skill): MentionRow => ({ kind: 'skill', skill }))
    : completion?.kind === 'image'
    ? matchImageRefs(images.length, completion.query).map((number): MentionRow => ({ kind: 'image', number }))
    : [
        ...agentRows.map((agent): MentionRow => ({ kind: 'agent', agent })),
        ...(allowBrowserMentions && completion?.kind === 'mention' && matchesBrowserMention(completion.query) ? [{ kind: 'browser' as const }] : []),
        ...(canMentionComputer && completion?.kind === 'mention' && 'computer'.includes(completion.query.toLowerCase()) ? [{ kind: 'computer' as const }] : []),
        ...(allowWorkDestination && completion?.kind === 'mention' && matchesWorkMention(completion.query) ? [{ kind: 'work' } as const] : []),
        ...fileRows.map((path): MentionRow => ({ kind: 'file', path })),
      ]
  // A `$` menu with no eligible rows still opens. Silence reads as a broken trigger;
  // the empty state can instead point to the missing import or agent attachment.
  const menuOpen = completion !== null && (matches.length > 0 || completion.kind === 'skill') && completion.start !== dismissedAt
  const index = Math.min(activeIndex, Math.max(matches.length - 1, 0))

  useEffect(() => {
    setActiveIndex(0)
  }, [completion?.kind, completion?.query])

  // No `layoutMoved`: the composer is pinned to the footer, so a scrolling
  // transcript moves nothing this menu is anchored to.
  useDismiss(plusOpen, () => setPlusOpen(false), { within: [plusRef], escape: true })
  const focusDraft = () => {
    if (touchMode) areaRef.current?.focus()
    else editorRef.current?.focusAt(caret)
  }
  // Escape hands focus back to the draft, so the next key types where it stood.
  useDismiss(recipientMenuOpen, () => setRecipientMenuOpen(false), {
    within: [recipientMenuRef],
    onEscape: () => {
      setRecipientMenuOpen(false)
      focusDraft()
    },
  })

  /**
   * Switching chats parks this draft under the key it belonged to and picks up
   * whatever was parked under the new one. Deliberately without focusing: the
   * composer is not what someone was reaching for when they clicked another chat.
   * `value` and `images` still hold the outgoing draft here — this render is the
   * first with the new key, and state has not moved yet.
   */
  useLayoutEffect(() => {
    if (parkedKey.current === draftKey) return
    writeDraft(parkedKey.current, { text: value, images, files: textFiles, documents, quotes })
    parkedKey.current = draftKey
    setHeldKey(draftKey)
    const next = readDraft(draftKey)
    setValue(next.text)
    setImages(next.images)
    setTextFiles(next.files)
    setDocuments(next.documents ?? [])
    setQuotes(next.quotes ?? NO_QUOTES)
    caretHeld.current = false
    staged.current = next.images.length + next.files.length + (next.documents?.length ?? 0)
    // Whatever was still being read belonged to the chat we just left, so it is
    // cancelled here rather than allowed to land in this one.
    era.current += 1
    setReading(0)
    setCaret(next.text.length)
    setAttachError(null)
    setDismissedAt(null)
    setPlusOpen(false)
  }, [draftKey])

  // A selection elsewhere blurs this field on its first press, so the caret they left
  // has to be noted at that press: it was here, and selecting text is not moving away.
  // The later presses of a double click and a press on the quote action say nothing
  // about the caret. `detail` counts presses on mouse events only, not pointer events.
  useEffect(() => {
    const noteCaret = (event: MouseEvent) => {
      if (event.detail > 1) return
      if (event.target instanceof Element && event.target.closest('[data-quote-action]') !== null) return
      caretHeld.current = rootRef.current?.contains(document.activeElement) === true
    }
    const page = rootRef.current?.ownerDocument
    page?.addEventListener('mousedown', noteCaret, true)
    return () => page?.removeEventListener('mousedown', noteCaret, true)
  }, [])

  // Text handed in from another surface lands at the end of the draft, a quote at the
  // caret they left here, or at the end when they left none. Either way the caret follows
  // and focus comes here, so what came in is ready to be talked about.
  useEffect(() => {
    if (draftKey === undefined) return
    return subscribeDraftInsert(draftKey, (insert) => {
      const draft = liveDraft.current
      if (insert.kind === 'text') {
        const next = appendedText(draft.text, insert.text)
        pendingSelection.current = { start: next.length, end: next.length }
        setValue(next)
        setCaret(next.length)
        return
      }
      const atCaret = caretHeld.current || rootRef.current?.contains(document.activeElement) === true
      const next = insertQuote(draft.text, draft.quotes ?? NO_QUOTES, insert.quote, atCaret ? liveCaret.current : draft.text.length)
      if (next === null) {
        setAttachError(`A message can hold up to ${MAX_MESSAGE_QUOTES} quotes.`)
        return
      }
      if (next.text === draft.text) return
      pendingSelection.current = { start: next.caret, end: next.caret }
      setQuotes(next.quotes)
      setValue(next.text)
      setCaret(next.caret)
      setAttachError(null)
    })
  }, [draftKey])

  // The other way this composer loses a draft: the new-chat stage replaces it, or
  // the last chat closes. Same park, from the one place that still runs.
  useEffect(() => () => writeDraft(parkedKey.current, liveDraft.current), [])

  // The touch surface keeps the platform textarea instead of mounting a contenteditable.
  // Grow it up to the same cap as the desktop editor when field-sizing is unavailable.
  useLayoutEffect(() => {
    const area = areaRef.current
    if (!touchMode || !area) return
    if (typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content')) return
    const scrolled = area.scrollTop
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, MAX_TEXTAREA_PX)}px`
    area.scrollTop = scrolled
    scrollCaretIntoView(area)
  }, [touchMode, value])

  // Programmatic edits restore their selection after the value has rendered.
  useLayoutEffect(() => {
    const selection = pendingSelection.current
    if (selection === null) return
    pendingSelection.current = null
    const area = areaRef.current
    if (touchMode && area !== null) {
      area.setSelectionRange(selection.start, selection.end)
      area.focus()
      scrollCaretIntoView(area)
      return
    }
    editorRef.current?.focusAt(selection.end)
  }, [touchMode, value])

  const pick = (row: MentionRow) => {
    if (!completion) return
    if (row.kind === 'command') {
      // A refused row already says why.
      if (row.command.refusal !== undefined) return
      if (row.command.runs) submit(row.command.command)
      else {
        const typed = `${row.command.command} `
        pendingSelection.current = { start: typed.length, end: typed.length }
        setValue(typed)
        setCaret(typed.length)
      }
      return
    }
    const next = row.kind === 'skill'
      ? applySkill(value, caret, completion.start, row.skill.id)
      : row.kind === 'image'
        ? applyImageRef(value, caret, completion.start, row.number)
        : applyMention(value, caret, completion.start, row.kind === 'agent' ? row.agent.name : row.kind === 'file' ? row.path : row.kind)
    pendingSelection.current = { start: next.caret, end: next.caret }
    setValue(next.text)
    setCaret(next.caret)
    setDismissedAt(null)
  }

  const submit = (picked?: string) => {
    // A command picked from the list is its own words; a typed draft goes out with only
    // the quotes whose pill is still in it, numbered in reading order.
    const placed = picked === undefined ? compactQuoteRefs(normalizeComposerLists(value), quotes) : { text: picked, quotes: NO_QUOTES }
    const text = placed.text.trim()
    if ((text === '' && images.length === 0 && textFiles.length === 0 && documents.length === 0 && pageContexts.length === 0) || !canSend || reading > 0) return
    // Refused here, so the draft stays and the reason stands right under it.
    const refusal = commandContext === undefined || !text.startsWith('/') ? undefined
      : draftCommandRefusal({ text, images, files: textFiles, documents, pageContexts, replyTo, quotes: placed.quotes }, commandContext())
    if (refusal !== undefined) {
      setCommandNote(refusal)
      return
    }
    if (!onSend(text, { images, files: textFiles, documents }, pageContexts.slice(0, MAX_PAGE_CONTEXT_ATTACHMENTS), replyTo, placed.quotes)) return
    // Before the clear, so the editor applies it without taking the focus back.
    if (focusMode) putAway()
    setValue('')
    setCaret(0)
    setDismissedAt(null)
    setImages([])
    setTextFiles([])
    setDocuments([])
    setQuotes(NO_QUOTES)
    staged.current = 0
    era.current += 1
    setAttachError(null)
    // Forgotten here rather than on the next render, because sending from the
    // new-chat stage unmounts this composer before it gets one, and the parking
    // cleanup would file the message that just went out as an unsent draft.
    liveDraft.current = EMPTY_DRAFT
    writeDraft(draftKey, EMPTY_DRAFT)
  }

  /**
   * The one gate for every way in: the plus row, the picker it opens, a paste and a
   * drop. A composer that takes no attachments must not take one off the clipboard
   * either. Order is what was handed over, so a mixed drop keeps the pictures and the
   * notes in the order they were dragged, and what does not fit is said out loud
   * rather than quietly dropped.
   */
  const attach = async (picked: File[]) => {
    if (!allowAttachments || picked.length === 0) return
    const usable = picked.filter(isAttachable)
    const skipped = picked.length - usable.length
    const taking = usable.slice(0, Math.max(MAX_MESSAGE_ATTACHMENTS - staged.current, 0))
    // Reserved here, before anything is read, so a second drop landing mid-read
    // measures a full composer instead of the one this drop has not filled yet.
    staged.current += taking.length
    // The draft these files are for. Everything below only counts while it is still
    // the draft on screen.
    const mine = era.current
    const problems: string[] = []
    if (skipped > 0) {
      problems.push(skipped === 1 ? 'One file is not a picture, text, PDF or Word file.' : `${skipped} files are not pictures, text, PDF or Word files.`)
    }
    if (taking.length < usable.length) problems.push(`You can attach up to ${MAX_MESSAGE_ATTACHMENTS} files.`)
    if (taking.length > 0) setReading((count) => count + 1)
    const read = await readAttachments(taking)
    // Sent or switched away while this was reading: these files belong to a draft that
    // no longer exists, and putting them in the one on screen would be attaching them
    // to somebody else's message. Its reservations went with that draft too, so
    // nothing here is given back either.
    if (era.current !== mine) return
    setReading((count) => count - (taking.length > 0 ? 1 : 0))
    // Slots held for files that turned out to be unreadable go back, or the composer
    // would refuse the next drop over room nothing is using.
    staged.current -= read.slotsFreed
    if (read.images.length > 0) setImages((current) => [...current, ...read.images])
    if (read.files.length > 0) setTextFiles((current) => [...current, ...read.files])
    if (read.documents.length > 0) setDocuments((current) => [...current, ...read.documents])
    setAttachError([...problems, ...read.problems][0] ?? null)
  }

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    if (!allowAttachments) return
    const picked = Array.from(event.clipboardData.files).filter(isAttachable)
    if (picked.length === 0) return
    event.preventDefault()
    void attach(picked)
  }

  /**
   * Dropping onto the card attaches; dropping anywhere else in the app is still the
   * browser's business, so nothing is prevented until a drag actually carries files.
   */
  const carriesFiles = (event: { dataTransfer: DataTransfer | null }) =>
    allowAttachments && (event.dataTransfer?.types.includes('Files') ?? false)

  const handleCommand = (key: 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Escape' | 'Tab', event: KeyboardEvent) => {
    if (menuOpen) {
      if (key === 'ArrowDown' && matches.length > 0) {
        setActiveIndex((current) => (current + 1) % matches.length)
        return true
      }
      if (key === 'ArrowUp' && matches.length > 0) {
        setActiveIndex((current) => (current - 1 + matches.length) % matches.length)
        return true
      }
      if ((key === 'Enter' || key === 'Tab') && matches.length > 0) {
        const row = matches[index]
        if (row) {
          pick(row)
          return true
        }
      }
    }
    if (key === 'Escape') {
      const step = composerEscapeStep({ menuOpen, plusOpen, focusMode, canClearProject: onEscapeIdle !== undefined })
      if (step === 'close-menu') setDismissedAt(completion?.start ?? null)
      else if (step === 'put-away') putAway()
      else if (step === 'clear-project') onEscapeIdle?.()
      if (step !== null) return true
    }
    if (key === 'Enter' && !event.shiftKey) {
      submit()
      return true
    }
    return false
  }

  const handleTouchKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const key = event.key
    if (
      (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === 'Escape' || key === 'Tab')
      && handleCommand(key, event.nativeEvent)
    ) {
      event.preventDefault()
      return
    }
    if (key !== 'Enter' || !event.shiftKey || event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) return
    const next = continueComposerList(value, event.currentTarget.selectionStart)
    if (next === null) return
    event.preventDefault()
    pendingSelection.current = { start: next.selectionStart, end: next.selectionEnd }
    setValue(next.text)
    setCaret(next.selectionEnd)
  }

  /** Says why the draft cannot go, or what the last attachment did. Empty is the normal case. */
  const note = commandNote ?? attachError ?? (reading > 0 ? 'Adding your attachment…' : canSend ? '' : blockedNote)

  /**
   * Types a trigger character for someone who does not know it exists, at the caret
   * they left behind. The autocomplete that follows is the same one typing `@` opens
   * — this menu is a way in, not a second mechanism.
   */
  const typeTrigger = (trigger: '@' | '$' | '#') => {
    const next = insertTrigger(value, caret, trigger)
    pendingSelection.current = { start: next.caret, end: next.caret }
    setValue(next.text)
    setCaret(next.caret)
    setDismissedAt(null)
    setPlusOpen(false)
  }

  /** The room's seated personas in roster order, as the `@` menu lists them. */
  const seatedAgents = matchAgents(mentionableAgents, '').filter((agent) => memberIds === undefined || memberIds.includes(agent.id))

  /**
   * The recipient menu's pick: the same `@Name ` the `@` menu writes, put at the head of
   * the draft, so `draftRecipients` stays the one reader of who the message reaches.
   */
  const addressTo = (agent: AgentConfig) => {
    setRecipientMenuOpen(false)
    const named = parseMentions(value, parsedAgents)
    if (named.length === 1 && named[0] === agent.id) {
      focusDraft()
      return
    }
    const next = addressDraft(value, parsedAgents, agent.name)
    // The caret keeps its place in the words after the mention it replaced.
    const at = value.trim() === '' ? next.caret : Math.max(next.caret, caret + next.text.length - value.length)
    pendingSelection.current = { start: at, end: at }
    setValue(next.text)
    setCaret(at)
    setDismissedAt(null)
  }

  const canMentionAgents = allowAgentMentions && mentionableAgents.length > 0
  const mentionLabel = plusMentionLabel(canMentionAgents, files.length > 0, {
    browser: allowBrowserMentions,
    computer: canMentionComputer,
    work: allowWorkDestination,
  })
  // Nothing to attach, nobody to point at, no skill to run: the button would open on
  // an empty sheet, so it is not drawn at all.
  const hasPlusRows = allowAttachments || mentionLabel !== null || (allowSkills && skills.length > 0)

  /**
   * Everything the composer can do that is not typing, in the one place a person
   * looks for it. The rows only name what this chat actually has: a DM cannot
   * address anyone else, a project with no folder has no files to point at, and a
   * house with no skills imported has no `$` worth advertising.
   */
  const plus = !hasPlusRows ? null : (
    <div ref={plusRef} className={`relative flex-none ${row ? '-order-1' : ''}`}>
      <button
        type="button"
        className={`grid cursor-pointer place-items-center rounded-full border-0 bg-user-bg text-muted hover:bg-menu-selected hover:text-text ${controlSize}`}
        aria-haspopup="menu"
        aria-expanded={plusOpen}
        title="Attach and insert"
        onClick={() => setPlusOpen((current) => !current)}
      >
        <Icon icon={PlusSignIcon} size={18} />
        <span className="sr-only">Attach and insert</span>
      </button>

      <Popover
        open={plusOpen}
        className={`absolute bottom-[calc(100%+8px)] left-0 z-[6] w-max min-w-[240px] max-w-[calc(100vw-24px)] ${MENU_SURFACE}`}
        role="menu"
      >
        {allowAttachments ? (
          <MenuItem
            icon={Attachment01Icon}
            trailing={`up to ${MAX_MESSAGE_ATTACHMENTS}`}
            onClick={() => {
              setPlusOpen(false)
              fileRef.current?.click()
            }}
          >
            Attach files
          </MenuItem>
        ) : null}
        {mentionLabel !== null ? (
          <MenuItem
            icon={canMentionAgents ? BotIcon : files.length > 0 ? File01Icon : allowBrowserMentions ? Globe02Icon : MessageMultiple01Icon}
            trailing="@"
            onClick={() => typeTrigger('@')}
          >
            {mentionLabel}
          </MenuItem>
        ) : null}
        {allowSkills && skills.length > 0 ? (
          <MenuItem icon={BoxIcon} trailing="$" onClick={() => typeTrigger('$')}>Run a skill</MenuItem>
        ) : null}
        {allowAttachments && images.length > 0 ? (
          <MenuItem icon={Image01Icon} trailing="#" onClick={() => typeTrigger('#')}>Refer to an image</MenuItem>
        ) : null}
      </Popover>

      {/* Outside the menu on purpose: a picker opened from a row that unmounts in
          the same click loses the file it was opened for. */}
      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept={CHAT_ATTACH_ACCEPT}
        multiple
        tabIndex={-1}
        onChange={(event) => {
          const picked = Array.from(event.currentTarget.files ?? [])
          // Cleared before the async work, so picking the same file twice in a row
          // still fires a change event the second time.
          event.currentTarget.value = ''
          void attach(picked)
        }}
      />
    </div>
  )

  const mentionShortcut = !touchMode || mentionLabel === null ? null : (
    <button
      type="button"
      className="flex h-11 min-w-11 cursor-pointer items-center justify-center gap-1 rounded-full border-0 bg-transparent px-2.5 text-muted hover:bg-user-bg hover:text-text"
      aria-label={mentionLabel}
      title={mentionLabel}
      onClick={() => typeTrigger('@')}
    >
      <Icon icon={canMentionAgents ? BotIcon : files.length > 0 ? File01Icon : allowBrowserMentions ? Globe02Icon : MessageMultiple01Icon} size={17} />
      <span className="font-mono text-[13px] font-medium">@</span>
    </button>
  )

  /**
   * Where the draft would land if sent now, right of the plus. It answers the
   * mistake it exists for — replying into a busy thread and reaching the wrong
   * persona — so it must only ever restate what `draftRecipients` says the server
   * will do, never guess on its own. "no one" is a real state (a group whose
   * chief of staff is not in the room) and saying it beats going quiet. An
   * unmarked draft while a turn is still running cannot know the follow-up
   * target yet, so it says so instead of naming yesterday's speaker.
   */
  // While a turn runs and no one is mentioned, the draft joins the running turn: the one
  // agent it steers is named, and with none or several known the label stays "…".
  const shownRecipients = followUpUnknown ? (steeredAgent === undefined ? null : [steeredAgent]) : recipients
  const recipientChips = shownRecipients === null ? (
    <span>…</span>
  ) : shownRecipients.length === 0 ? (
    <span>no one</span>
  ) : (
    shownRecipients.map((agent) => (
      <span
        key={agent.id}
        className="flex min-w-0 items-center gap-1 text-[color:var(--accent)]"
        style={accentStyle(agent.color)}
      >
        <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} size={16} />
        <span className="max-w-[120px] truncate py-px font-medium">{agent.name}</span>
      </span>
    ))
  )
  const recipientTitle = shownRecipients === null
    ? 'Who receives this depends on the turn still in progress.'
    : shownRecipients.length === 0
      ? 'No one receives this message. @mention an agent to summon one.'
      : followUpUnknown
        ? `Joins ${shownRecipients[0]?.name}'s running turn`
        : `Sends to ${shownRecipients.map((agent) => agent.name).join(', ')}`
  // Without its own placeholder, a composer that names one recipient asks for a message to that agent.
  const shownPlaceholder = placeholder ?? (showRecipients && shownRecipients?.length === 1 ? `Message ${shownRecipients[0]!.name}` : 'Ask anything…')

  /** Arrow keys walk the menu's rows with focus, which is what makes each one a real stop. */
  const walkRecipients = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      setRecipientMenuOpen(false)
      return
    }
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const at = rows.findIndex((row) => row === document.activeElement)
    const target = event.key === 'ArrowDown' ? rows[(at + 1) % rows.length]
      : event.key === 'ArrowUp' ? rows[(at - 1 + rows.length) % rows.length]
      : event.key === 'Home' ? rows[0]
      : event.key === 'End' ? rows[rows.length - 1]
      : undefined
    if (target === undefined) return
    event.preventDefault()
    target.focus()
  }

  const recipientLabel = showRecipients ? (
    seatedAgents.length === 0 ? (
      <div className="flex min-w-0 flex-none items-center gap-1.5 text-[12px] text-dim" title={recipientTitle}>
        <span aria-hidden="true">to</span>
        <span className="sr-only">This message goes to</span>
        {recipientChips}
      </div>
    ) : (
      <div ref={recipientMenuRef} className="relative flex min-w-0 flex-none">
        <button
          type="button"
          className={`flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-2 text-[12px] text-dim hover:bg-user-bg focus-visible:bg-user-bg ${touchMode ? 'h-11' : 'h-7'}`}
          aria-haspopup="menu"
          aria-expanded={recipientMenuOpen}
          title={recipientTitle}
          onClick={() => setRecipientMenuOpen((current) => !current)}
          onKeyDown={(event) => {
            if (recipientMenuOpen || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
            event.preventDefault()
            setRecipientMenuOpen(true)
          }}
        >
          <span aria-hidden="true">to</span>
          <span className="sr-only">This message goes to</span>
          {recipientChips}
          <Icon icon={ArrowUp01Icon} size={12} />
        </button>

        <Popover
          open={recipientMenuOpen}
          onReady={() => {
            const menu = recipientMenuRef.current
            const start = menu?.querySelector<HTMLElement>('[data-current]') ?? menu?.querySelector<HTMLElement>('[role="menuitem"]')
            start?.focus()
          }}
          className="absolute bottom-[calc(100%+8px)] left-0 z-[6] max-h-[min(640px,calc(100dvh-128px))] w-max min-w-[220px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-line surface-floating p-1.5"
          role="menu"
          aria-label="Send to"
        >
          <div role="none" onKeyDown={walkRecipients}>
            {seatedAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                role="menuitem"
                className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-label text-text outline-none hover:bg-user-bg focus-visible:bg-user-bg"
                {...(shownRecipients?.some((recipient) => recipient.id === agent.id) === true ? { 'data-current': '' } : {})}
                onClick={() => addressTo(agent)}
              >
                <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} size={20} />
                <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
                {agent.role === '' ? null : <span className="min-w-0 flex-none truncate text-meta text-dim">{agent.role}</span>}
              </button>
            ))}
          </div>
        </Popover>
      </div>
    )
  ) : null

  const actions = (
    <div className="flex flex-none items-center gap-2">
      {contextMeter === undefined ? null : <ContextRing controlSize={controlSize} {...contextMeter} />}
      {/* One button rather than two, which is what lets the mark change in place: two
          of them would remount on the switch and there would be nothing to cross-fade
          between. Which act it carries is still the same rule, an empty draft while a
          turn runs, so a press can never mean both. */}
      <button
        type="button"
        className={`grid cursor-pointer place-items-center rounded-full border-0 bg-text font-medium text-bg disabled:cursor-default disabled:opacity-[0.3] ${dense ? 'text-[15px]' : 'text-[16px]'} ${controlSize}`}
        onClick={showStop ? onStop : () => submit()}
        disabled={showStop ? false : !canSend || empty || reading > 0}
        title={showStop ? 'Stop' : reading > 0 ? 'Still adding your attachment' : canSend ? 'Send (Enter)' : blockedNote}
      >
        <IconSwap swapKey={showStop ? 'stop' : 'send'}>
          {showStop ? (
            <span aria-hidden="true" className={`rounded-xs bg-bg ${dense ? 'h-[9px] w-[9px]' : 'h-[11px] w-[11px]'}`} />
          ) : (
            <span aria-hidden="true">↑</span>
          )}
        </IconSwap>
        <span className="sr-only">{showStop ? 'Stop' : 'Send'}</span>
      </button>
    </div>
  )

  /**
   * A picture leaves the tray and every number after it moves up one, so the draft's
   * references follow: its own go, later ones count down with the thumbnails.
   */
  const removeImage = (index: number) => {
    staged.current -= 1
    const next = renumberImageRefs(value, index + 1, images.length)
    if (next !== value) {
      setValue(next)
      setCaret((current) => Math.min(current, next.length))
    }
    setImages((current) => current.filter((_, at) => at !== index))
  }

  // Each thumbnail wears the number `#` and its chip refer to it by, and drags into the
  // text as that chip. Dragging is a pointer's way in; the `#` menu is everyone's.
  const imageThumbs = images.map((image, index) => (
    <div
      key={`${image.name}-${index}`}
      className="group/image relative flex-none cursor-grab"
      draggable={!touchMode}
      title={touchMode ? undefined : `Drag into your message to refer to Image #${index + 1}`}
      onDragStart={(event) => {
        // The picture's own drag would carry the file, and the card would attach it again.
        event.dataTransfer.clearData()
        event.dataTransfer.setData(IMAGE_REF_DRAG_TYPE, String(index + 1))
        event.dataTransfer.setData('text/plain', formatImageRef(index + 1))
        event.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <ZoomableImage src={image.dataUrl} alt={image.name} className="h-15 w-15 rounded-lg object-cover" gallery={{ images: images.map((each) => ({ src: each.dataUrl, alt: each.name })), index }} />
      <ImageNumberBadge number={index + 1} />
      <button type="button" aria-label={`Remove ${image.name}`} className="absolute top-1 right-1 h-6 w-6 cursor-pointer rounded-full border-0 bg-media-scrim text-on-media" onClick={() => removeImage(index)}>×</button>
    </div>
  ))

  // Typed as the motion host: `style.y` is only passed while travelLayer is on, and
  // travelLayer never runs without usesMotion, so the plain div never receives it.
  const Box = (usesMotion ? motion.div : 'div') as typeof motion.div

  return (
    <Box
      ref={setRoot}
      className="relative w-full min-w-0 max-w-[760px]"
      {...(focusMode ? { 'data-focus-composer': '' } : {})}
      {...(travelLayer ? { style: { y: travelY } } : {})}
    >
      <Popover
        open={menuOpen}
        element="ul"
        className="absolute bottom-[calc(100%+6px)] left-0 z-[5] max-h-[260px] w-full overflow-y-auto rounded-panel border border-line surface-floating p-1 shadow-popover"
        contentClassName="m-0 list-none"
        role="listbox"
      >
        {completion?.kind === 'skill' || completion?.kind === 'image' ? (
          <li className="px-[9px] pt-1.5 pb-1 text-meta font-semibold tracking-[0.08em] text-dim uppercase">
            {completion.kind === 'skill' ? 'Skills' : 'Images'}
          </li>
        ) : null}
        {completion?.kind === 'skill' && matches.length === 0 ? (
          <li className="px-[9px] py-3 text-[12px] leading-relaxed text-dim">
            {skills.length === 0
              ? 'No skills imported. Import one under Plugins → Skills.'
              : availableSkills.length === 0
                ? 'No shared skills for the addressed agent. Attach them under Agents.'
                : 'No skill matches this search.'}
          </li>
        ) : null}
        {matches.map((row, position) => {
          const selected = position === index
          const highlight = selected
            ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]'
            : 'bg-transparent'
          const secondary = selected ? 'text-text/75' : 'text-dim'
          // No `items-*` here: an agent row is two lines and a file row is one, so
          // each picks its own alignment. Tailwind resolves a duplicated property by
          // stylesheet order, not by which class was appended last.
          const shell = `flex w-full cursor-pointer gap-2 rounded-md border-0 px-[9px] py-1.5 text-left text-[13px] text-text [font:inherit] ${highlight}`
          // mousedown, so the pick happens before the textarea loses focus.
          const grab = (event: { preventDefault: () => void }) => {
            event.preventDefault()
            pick(row)
          }

          if (row.kind === 'command') {
            const { command, description, refusal } = row.command
            return (
              <li key={`command:${command}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={refusal !== undefined}
                  className={`${shell} items-center`}
                  onMouseDown={grab}
                  onMouseEnter={() => setActiveIndex(position)}
                >
                  <span className={`flex-none font-mono text-meta ${refusal === undefined ? 'text-text' : 'text-dim'}`}>{command}</span>
                  <span className={`min-w-0 flex-1 truncate text-meta ${refusal === undefined ? secondary : 'text-dim'}`}>{refusal ?? description}</span>
                </button>
              </li>
            )
          }

          if (row.kind === 'agent') {
            const { agent } = row
            return (
              <li key={`agent:${agent.id}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`${shell} items-center`}
                  style={accentStyle(agent.color)}
                  // The sentence the title is short for, for whoever wants it.
                  title={agent.description}
                  onMouseDown={grab}
                  onMouseEnter={() => setActiveIndex(position)}
                >
                  <span className="flex min-w-0 flex-none items-center gap-1.5">
                    <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} size={20} />
                    {/* Name capped rather than shrinking, so a long one eats itself
                        instead of squeezing the title next to it down to nothing. */}
                    <span className="max-w-[140px] flex-none truncate">{agent.name}</span>
                  </span>
                  {/* What this persona does, in the words a person scans for. */}
                  <span className={`min-w-0 flex-1 truncate text-meta ${secondary}`}>{agent.role}</span>
                  {/* The runtime this mention will actually run on, pins included. */}
                  {isAutoPending(agent, overrides[agent.id] ?? {}, hostAuto) ? null : (
                    <ProviderMark driver={effectiveDriver(agent, overrides[agent.id] ?? {})} size={12} />
                  )}
                  <RuntimeLabel
                    {...runtimeParts(agent, overrides[agent.id] ?? {}, hostAuto)}
                    className="max-w-[150px] flex-none text-meta"
                  />
                </button>
              </li>
            )
          }

          if (row.kind === 'browser') {
            return (
              <li key="browser">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`${shell} items-center`}
                  onMouseDown={grab}
                  onMouseEnter={() => setActiveIndex(position)}
                >
                  <span className="grid h-5 w-5 flex-none place-items-center">
                    <Icon icon={Globe02Icon} size={14} className="text-muted" />
                  </span>
                  <span className="flex-none">Browser</span>
                  <span className={`min-w-0 flex-1 truncate text-meta ${secondary}`}>Integrated Manor browser</span>
                  <span className={`font-mono text-meta ${secondary}`}>@browser</span>
                </button>
              </li>
            )
          }

          if (row.kind === 'computer') {
            return (
              <li key="computer">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`${shell} items-center`}
                  onMouseDown={grab}
                  onMouseEnter={() => setActiveIndex(position)}
                >
                  <span className="grid h-5 w-5 flex-none place-items-center">
                    <Icon icon={ComputerIcon} size={14} className="text-muted" />
                  </span>
                  <span className="flex-none">Computer Use</span>
                  <span className={`min-w-0 flex-1 truncate text-meta ${secondary}`}>Use Mac apps through Cua</span>
                  <span className={`font-mono text-meta ${secondary}`}>@computer</span>
                </button>
              </li>
            )
          }

          if (row.kind === 'work') {
            return (
              <li key="destination:work">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`${shell} items-center`}
                  onMouseDown={grab}
                  onMouseEnter={() => setActiveIndex(position)}
                >
                  <span className="grid h-5 w-5 flex-none place-items-center">
                    <Icon icon={MessageMultiple01Icon} size={14} className="text-muted" />
                  </span>
                  <span>Sessions</span>
                  <span className={`min-w-0 flex-1 truncate text-meta ${secondary}`}>Send a task or this discussion to Sessions</span>
                  <span className={`text-meta ${secondary}`}>Destination</span>
                </button>
              </li>
            )
          }

          if (row.kind === 'skill') {
            const { skill } = row
            return (
              <li key={`skill:${skill.id}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`${shell} items-center`}
                  title={skill.description}
                  onMouseDown={grab}
                  onMouseEnter={() => setActiveIndex(position)}
                >
                  <span className="grid h-5 w-5 flex-none place-items-center">
                    <Icon icon={BoxIcon} size={14} className="text-muted" />
                  </span>
                  <span className="max-w-[150px] flex-none truncate">{skill.name}</span>
                  <span className={`min-w-0 flex-1 truncate text-meta ${secondary}`}>{skill.description}</span>
                  <span className={`max-w-[160px] flex-none truncate font-mono text-meta ${secondary}`}>${skill.id}</span>
                </button>
              </li>
            )
          }

          if (row.kind === 'image') {
            const image = images[row.number - 1]
            return (
              <li key={`image:${row.number}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`${shell} items-center`}
                  onMouseDown={grab}
                  onMouseEnter={() => setActiveIndex(position)}
                >
                  {image === undefined ? null : <img src={image.dataUrl} alt="" className="h-5 w-5 flex-none rounded-xs object-cover" />}
                  <span className="flex-none">Image #{row.number}</span>
                  <span className={`min-w-0 flex-1 truncate text-meta ${secondary}`}>{image?.name}</span>
                  <span className={`font-mono text-meta ${secondary}`}>#{row.number}</span>
                </button>
              </li>
            )
          }

          // The file name leads and its folder trails in the dim half, because the
          // name is what someone typed and the folder is only there to tell two of
          // them apart. The whole pointer is still what gets inserted.
          const cut = row.path.lastIndexOf('/')
          return (
            <li key={`file:${row.path}`}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={`${shell} items-center`}
                title={row.path}
                onMouseDown={grab}
                onMouseEnter={() => setActiveIndex(position)}
              >
                <span className="grid h-5 w-5 flex-none place-items-center">
                  <Icon icon={File01Icon} size={14} className="text-muted" />
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="flex-none">{row.path.slice(cut + 1)}</span>
                  <span className={`min-w-0 truncate text-meta ${secondary}`} dir="rtl">
                    {row.path.slice(0, Math.max(cut, 0))}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
        {/* Said only where it could mislead: the list looks complete either way. */}
        {completion?.kind === 'mention' && filesTruncated && fileRows.length > 0 ? (
          <li className="px-[9px] py-1.5 text-meta text-dim">
            Showing part of this project’s files; keep typing to narrow it down.
          </li>
        ) : null}
      </Popover>
      {/* z-[1] lifts the card over the checkout tray tucked behind it, and no higher:
          the tray's own menus sit at z-[6] and still open over the card. No drop shadow:
          the tray reads as one object with the card, and a shadow falling across it made
          two. The card's own border and the tray's darker fill are the seam instead. */}
      <div
        ref={cardRef}
        className={`relative z-[1] border ${row ? `${PILL} grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5 p-[7px]` : `rounded-composer ${cardRange === undefined ? '' : `flex flex-col ${dense ? CARD_REACH_DENSE : CARD_REACH}`} ${dense ? 'p-2' : 'p-3'}`} ${dropping ? 'border-text/40' : 'border-composer-line'}`}
        // A one-row card's min-height is its hook's, which lets go of it while the card eases.
        {...(cardRange === undefined || oneRow ? {} : { style: { minHeight: cardRange.rest || undefined } })}
        onDragEnter={(event) => {
          if (!carriesFiles(event)) return
          event.preventDefault()
          dragDepth.current += 1
          setDropping(true)
        }}
        onDragOver={(event) => {
          if (!carriesFiles(event)) return
          // Without both the over-handler and this effect the browser navigates to
          // the dropped file instead of handing it over.
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(event) => {
          if (!carriesFiles(event)) return
          dragDepth.current -= 1
          if (dragDepth.current <= 0) {
            dragDepth.current = 0
            setDropping(false)
          }
        }}
        onDrop={(event) => {
          if (!carriesFiles(event)) return
          event.preventDefault()
          dragDepth.current = 0
          setDropping(false)
          void attach(Array.from(event.dataTransfer.files))
        }}
      >
        {/* The fill and its frost sit on their own layer. On the card itself the blur
            would make the card a backdrop root, and the model and plus menus that open
            out of it could then only frost the card, never the thread above. It stays
            inside the border, because a negative layer paints over its own card's border. */}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 -z-10 ${row ? PILL : 'rounded-[calc(var(--radius-composer)-var(--default-border-width))]'} bg-[color-mix(in_srgb,var(--color-composer)_82%,transparent)] backdrop-blur-[16px] backdrop-saturate-[1.08]`}
        />
        {/* Over the card rather than replacing it: what is already typed and already
            attached stays readable, so a drop reads as adding to this draft and not as
            starting something new. Nothing here can be clicked, so the drag it is
            answering still lands on the card underneath. */}
        <motion.div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 z-[2] grid place-items-center ${row ? PILL : 'rounded-composer'} bg-composer/85 text-[13px] font-medium text-text`}
          initial={false}
          animate={{ opacity: dropping ? 1 : 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.12 }}
          style={{ visibility: dropping ? 'visible' : 'hidden' }}
        >
          <span className="flex items-center gap-2">
            <Icon icon={Attachment01Icon} size={16} className="text-muted" />
            Drop to attach
          </span>
        </motion.div>
        {cardRange === undefined ? (
          images.length > 0 ? <div className="mb-2 flex gap-2 overflow-x-auto">{imageThumbs}</div> : null
        ) : (
          // Keyed by draft, so opening another chat's draft swaps the row without a fold.
          <AnimatePresence key={draftKey} initial={false}>
            {images.length > 0 ? (
              <motion.div
                key="images"
                data-composer-above=""
                className="flex shrink-0 gap-2 overflow-x-auto overflow-y-hidden"
                initial={{ height: 0, marginBottom: 0 }}
                animate={{ height: 'auto', marginBottom: 8 }}
                exit={{ height: 0, marginBottom: 0 }}
                transition={reduceMotion === true ? INSTANT : COMPOSER_GROW}
              >
                {imageThumbs}
              </motion.div>
            ) : null}
          </AnimatePresence>
        )}
        {/* Everything staged beside the text scrolls as one region once the card is at its
            max. The text's scroller shrinks far faster, so this region gives way only when
            the text is down to its rest, and always keeps what the text leaves it. */}
        <div className={row ? 'hidden' : cardRange === undefined ? undefined : 'min-h-0 overflow-y-auto'} data-composer-above="">
          {textFiles.length > 0 || documents.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {[
                ...textFiles.map((file, at) => ({
                  key: `file-${file.name}-${at}`, name: file.name, size: utf8Size(file.content),
                  remove: () => setTextFiles((current) => current.filter((_, index) => index !== at)),
                })),
                ...documents.map((document, at) => ({
                  key: `document-${document.name}-${at}`, name: document.name, size: base64Bytes(document.data),
                  remove: () => setDocuments((current) => current.filter((_, index) => index !== at)),
                })),
              ].map((chip) => (
                <span
                  key={chip.key}
                  className="flex max-w-[220px] items-center gap-1.5 rounded-chip border border-line bg-user-bg py-1 pr-1 pl-2 text-[12px] text-text"
                  title={`${chip.name}, ${describeBytes(chip.size)}`}
                >
                  <FileMark path={chip.name} size={13} />
                  <span className="min-w-0 flex-1 truncate">{chip.name}</span>
                  <span className="flex-none text-meta text-dim">{describeBytes(chip.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${chip.name}`}
                    className="grid h-5 w-5 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent text-dim hover:bg-raised hover:text-text"
                    onClick={() => {
                      staged.current -= 1
                      chip.remove()
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {pageContexts.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pageContexts.slice(0, MAX_PAGE_CONTEXT_ATTACHMENTS).map((context) => (
                <PageContextChip
                  key={context.id}
                  context={context}
                  {...(onRemovePageContext === undefined
                    ? {}
                    : { onRemove: () => onRemovePageContext(context.id) })}
                />
              ))}
            </div>
          ) : null}
          {replyTo === undefined ? null : (
            <div className="mb-2 flex min-w-0">
              <ReplyContextChip
                agents={agents}
                reply={replyTo}
                appearance="composer"
                {...(onRemoveReply === undefined ? {} : { onRemove: onRemoveReply })}
              />
            </div>
          )}
        </div>
        {touchMode ? (
          <textarea
            ref={areaRef}
            autoFocus={autoFocus}
            className="relative block min-h-[56px] max-h-[200px] w-full [field-sizing:content] resize-none overflow-y-auto border-0 bg-transparent px-2 py-1 text-[16px] leading-6 text-text placeholder:text-dim [font:inherit] whitespace-pre-wrap [overflow-wrap:break-word]"
            rows={1}
            value={value}
            placeholder={shownPlaceholder}
            onChange={(event) => {
              const snapped = snapRefDeletion(value, event.target.value, [...imageRefSpans(value, images.length), ...quoteRefSpans(value, quotes.length)], touchSelection.current)
              if (snapped !== null) {
                pendingSelection.current = { start: snapped.caret, end: snapped.caret }
                setValue(snapped.text)
                setCaret(snapped.caret)
                return
              }
              const startedList = startComposerList(event.target.value, event.target.selectionStart)
              if (startedList === null) {
                setValue(event.target.value)
                setCaret(event.target.selectionStart)
              } else {
                pendingSelection.current = { start: startedList.selectionStart, end: startedList.selectionEnd }
                setValue(startedList.text)
                setCaret(startedList.selectionEnd)
              }
              setDismissedAt(null)
            }}
            onSelect={(event) => {
              touchSelection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }
              setCaret(event.currentTarget.selectionStart)
            }}
            onKeyDown={handleTouchKeyDown}
            onPaste={handlePaste}
          />
        ) : (
          <ComposerEditor
            key={draftKey}
            ref={editorRef}
            value={value}
            caret={caret}
            agents={mentionableAgents}
            skills={allowSkills ? skills : []}
            allowBrowser={allowBrowserMentions}
            allowComputer={canMentionComputer}
            allowWork={allowWorkDestination}
            quotes={quotes}
            imageCount={allowAttachments ? images.length : 0}
            placeholder={shownPlaceholder}
            autoFocus={autoFocus}
            dense={dense}
            {...(cardRange === undefined ? {} : { fill: row || cardRange.rest > 0 ? 'line' : 'rest' })}
            onChange={(nextValue, nextCaret) => {
              setValue(nextValue)
              setCaret(nextCaret)
              setDismissedAt(null)
            }}
            onCommand={handleCommand}
            onPaste={handlePaste}
          />
        )}
        {/* No keyboard hint anywhere: Enter-to-send is table stakes. The line only
            speaks when something is wrong — a refused image or a blocked send. */}
        {/* A size container, so a control in the row can shorten itself by the
            composer's width rather than the window's (split panes, side panel). */}
        {/* In the row the plus and the send are the card's own cells, either side of the text. */}
        <div className={row ? 'contents' : `${dense ? 'mt-1' : 'mt-2'} flex items-center gap-2 shrink-0 @container`}>
          {plus}
          {mentionShortcut}
          {recipientLabel}
          {controls !== undefined ? <div className="flex min-w-0 items-center">{controls}</div> : null}
          {row ? null : <span className="min-w-0 flex-1 truncate text-[12px] text-dim">{note}</span>}
          {actions}
        </div>
      </div>
      {checkout}
    </Box>
  )
}
