import { memo, useContext, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { FaceState } from '@manor/client-runtime/face-activity'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { DISCLOSURE } from '../motion'
import { AlertCircleIcon, ArrowDown01Icon, Clock01Icon, MinusSignIcon, PencilEdit02Icon, RefreshIcon, TaskDone01Icon, Tick02Icon, Undo02Icon } from '@hugeicons/core-free-icons'
import { ROUTINE_LATE_AFTER_MS, eventImageSource, imageRefSpans, numberedMarks, originalImageIndexes, projectFileWriteDetail, projectFileWriteLabel, type EventImage, type NumberedMark, type ProjectFileWrite } from '@manor/contracts'
import type { AgentConfig, AvatarFinish, EventDocument, FileAttachment, InlineQuote, MessageQuote, MessageReply, NoteQuote, PageContextAttachment, SkillConfig, WakeItem } from '@manor/contracts'
import { wakeLines } from '../turnLabels'
import { fileWriteGroups, type MessageQuoteSource, type PendingDocument } from '@manor/client-runtime/state'
import { describeBytes, utf8Size } from '@manor/client-runtime/attachments'
import type { BubbleTint } from '@manor/client-runtime/avatar-bubble'
import { normalizeComposerLists } from '@manor/client-runtime/composer-formatting'
import { eventImageFiles } from '@manor/client-runtime/dm-files'
import { accentStyle } from '../accent'
import { FileViewer } from './agents/FileViewer'
import { Avatar } from './Avatar'
import { FileMark } from './fileMark'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { PageContextChip } from './PageContextChip'
import { ReplyContextChip } from './ReplyContextChip'
import { quoteAuthorName } from '@manor/client-runtime/message-quotes'
import { NoteQuoteContextChip, QuoteBlock } from './QuoteContextChip'
import { useAgentMentions, useMessageChips } from './mentionMarkdown'
import { AnnotateImageContext } from './annotateImage'
import { ImageNumberBadge, MarkCountBadge } from './MentionText'
import { ZoomableImage, type GalleryImage } from './ui/ZoomableImage'
import { MiddleCut } from './MiddleCut'
import { NotesActionsContext } from './NotesLine'
import { useRequest, type RequestEvents } from '../useRequest'

/**
 * One turn, signed once, and what that turn is doing.
 *
 * Small on purpose: this line repeats down the whole transcript, so the face is an
 * identifier and not a portrait. `status` is the turn's own live line, handed in
 * rather than built here, because it belongs to the turn and this component belongs
 * to the persona — the row is simply where the two meet, and they meet here because
 * "who is this" and "is she still going" are one glance.
 */
export function TurnHeader({
  name,
  color,
  avatar,
  avatarShape,
  avatarTone,
  avatarFinish,
  working = false,
  face: state,
  status,
  quiet = false,
}: {
  name: string
  color: string
  avatar?: string
  avatarShape?: string
  avatarTone?: number
  avatarFinish?: AvatarFinish
  /** Her turn is still running, which is the one thing her face here is allowed to say. */
  working?: boolean
  /** What that turn is doing, for the face to show. See `Avatar`. */
  face?: FaceState
  status?: ReactNode
  /**
   * The face alone, as in a DM's working indicator: the chat is already named after
   * her, so the name goes and the status speaks beside the face.
   */
  quiet?: boolean
}) {
  const face = <Avatar name={name} color={color} src={avatar} shape={avatarShape} tone={avatarTone} finish={avatarFinish} size={32} working={working} face={state} />
  if (quiet) {
    return (
      <div className="flex min-h-8 w-fit max-w-full items-center gap-1.5 text-[16px] leading-none font-semibold" style={accentStyle(color)}>
        <span className="-ml-1">
          {face}
          <span className="sr-only">{working ? `${name} is working` : name}</span>
        </span>
        {status}
      </div>
    )
  }
  return (
    <div
      className="flex min-h-8 items-center gap-0.5 text-[16px] leading-none font-semibold"
      style={accentStyle(color)}
    >
      <span className="-ml-1">{face}</span>
      {/* The name never gives up width to the status beside it. A persona's name is
          the shortest string on the row and the one that must stay whole; the status
          truncates instead, because half of "Worked for 4s" still reads. Ink is
          `text`, not the accent: the face already carries the colour. */}
      <span className="shrink-0 text-text">{name}</span>
      {status}
    </div>
  )
}

/**
 * A DM bubble's padding, either side. Both cap at 80% of the column; the agent's cap
 * sits on her wrapper.
 */
const DM_BUBBLE = 'px-3.5 pt-2 pb-[10px]'

/**
 * A DM bubble's corner: a capsule while its content fits on one line, the softer block
 * corner once it wraps or holds a chip row. Measured, because the line count depends on
 * the column width. `enabled` is whether the bubble is drawn, so the observer follows it.
 */
function useBubbleCorner(enabled: boolean): [ref: RefObject<HTMLDivElement>, corner: string] {
  const ref = useRef<HTMLDivElement>(null)
  const [oneLine, setOneLine] = useState(false)
  useLayoutEffect(() => {
    const node = ref.current
    if (!enabled || node === null) return
    const measure = () => {
      const style = getComputedStyle(node)
      const content = node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      setOneLine(content < parseFloat(style.lineHeight) * 1.5)
    }
    // Measured before the first paint, so a one-line bubble never shows the block corner.
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [enabled])
  return [ref, oneLine ? 'rounded-full' : 'rounded-2xl']
}

/**
 * The single human in the room. `pending` is the same bubble before the server has
 * written the message down: dimmed rather than styled apart, because it is the same
 * message and will not move when it settles.
 */
const NO_INLINE_QUOTES: readonly InlineQuote[] = []

export function UserBubble({
  text,
  agents,
  skills,
  images = [],
  files = [],
  documents = [],
  pageContexts = [],
  replyTo,
  quote,
  noteQuote,
  quotes = NO_INLINE_QUOTES,
  sourceEventId,
  onOpenQuoteSource,
  quoteAuthors = false,
  pending = false,
  tint,
  dm = false,
  badge,
}: {
  text: string
  /** The roster the mentions are resolved against; an unknown handle stays prose. */
  agents: readonly AgentConfig[]
  skills: readonly SkillConfig[]
  images?: EventImage[]
  /** Text files sent with the message. Named and sized, never quoted back at the user. */
  files?: FileAttachment[]
  /** PDF and Word files: how much text came out, and a link to the original once stored. */
  documents?: readonly (EventDocument | PendingDocument)[]
  pageContexts?: PageContextAttachment[]
  replyTo?: MessageReply
  /** The one quote a message from before inline quotes carried above its text. */
  quote?: MessageQuote
  /** The same for a Knowledge note. */
  noteQuote?: NoteQuote
  /** What the text's `[Quote #n]` pills hold. */
  quotes?: readonly InlineQuote[]
  /** Durable source identity; absent on an optimistic bubble. */
  sourceEventId?: string
  onOpenQuoteSource?: (eventId: string) => void
  /** True in a room with several personas, where a quote names who said it. */
  quoteAuthors?: boolean
  pending?: boolean
  /**
   * A DM fills the bubble with the face they are talking to. The typed text and its
   * inline chips take the ink, and the rows above it (reply, files) a white veil.
   * A pending bubble stays grey: its fade would pull the tinted ink below AA, and the
   * fill arriving doubles as the sign the message landed.
   */
  tint?: BubbleTint
  /** A DM reads as a chat: the wider, rounder bubble its replies share. */
  dm?: boolean
  /** The agent's reaction badge on the bubble's bottom right edge, in a DM. */
  badge?: ReactNode
}) {
  const hasFiles = files.length > 0 || documents.length > 0
  const author = quote === undefined ? undefined : quoteAuthorName(quote, agents, quoteAuthors)
  // A marked picture's original rides along for the persona; the user already sees it under the marks.
  const originals = originalImageIndexes(images)
  // One marked picture is read large; beside others it is a thumbnail like them, its badge counting the marks.
  const single = images.length - originals.size === 1
  const marked = images.flatMap((image) => {
    const marks = image.annotation === undefined ? [] : numberedMarks(image.annotation)
    return marks.length === 0 ? [] : [{ name: image.name, marks }]
  })
  const hasBubble = text !== '' || marked.length > 0 || hasFiles || pageContexts.length > 0 || replyTo !== undefined || quote !== undefined || noteQuote !== undefined
  const gallery = images.map((image) => ({ src: eventImageSource(image), alt: image.name }))
  // A message that refers to its pictures by number shows those numbers on them. One
  // that does not, every message from before numbering among them, stays as it was.
  const numbered = imageRefSpans(text, images.length).length > 0
  const [bubbleRef, corner] = useBubbleCorner(dm && hasBubble)
  // The rows above the text take the tint's white veil; a grey bubble keeps the page surfaces.
  const chipRow = tint === undefined
    ? {}
    : { style: { '--bubble-ink': tint.ink, '--bubble-chip': tint.chip } as CSSProperties }
  const chipClass = tint === undefined ? '' : ' bubble-chips'
  return (
    <div className={`flex min-w-0 flex-col items-end gap-1.5${pending ? ' opacity-60' : ''}`}>
      {/* Sent pictures sit above the bubble as a row of fixed squares, so a message
          keeps the same rhythm whatever their size; a press opens the full picture. */}
      {images.length > 0 ? (
        <div className={`relative flex max-w-[78%] flex-wrap justify-end gap-1.5${hasBubble || badge === undefined ? '' : ' mb-3'}`}>
          {images.map((image, index) => originals.has(index) ? null : (
            <TranscriptImage
              key={`${image.name}-${index}`}
              image={image}
              gallery={{ images: gallery, index }}
              wide={single && image.annotation !== undefined}
              {...(numbered ? { number: index + 1 } : {})}
              marks={single ? undefined : image.annotation}
            />
          ))}
          {/* A message of pictures only wears the agent's reaction on them. */}
          {hasBubble ? null : badge}
        </div>
      ) : null}
      {hasBubble ? <div
        ref={bubbleRef}
        className={`relative min-w-0 text-[length:var(--msg-size,16px)] ${dm ? `max-w-bubble ${corner} ${DM_BUBBLE}` : 'max-w-[78%] rounded-xl rounded-br-sm px-[13px] pt-[9px] pb-[11px]'} ${tint === undefined ? 'bg-user-bubble' : ''}${badge === undefined ? '' : ' mb-3'}`}
        {...(tint === undefined ? {} : { style: { backgroundColor: tint.fill } })}
      >
        {quote === undefined ? null : (
          <div
            className={`${replyTo !== undefined || noteQuote !== undefined || hasFiles || pageContexts.length > 0 || text ? 'mb-2' : ''} flex${tint === undefined ? '' : ' bubble-ink'}`}
            {...(tint === undefined ? {} : { style: { '--bubble-ink': tint.ink, '--bubble-wash': tint.wash } as CSSProperties })}
          >
            <QuoteBlock
              quote={quote}
              {...(author === undefined ? {} : { author })}
              {...(onOpenQuoteSource === undefined ? {} : { onOpen: () => onOpenQuoteSource(quote.eventId) })}
            />
          </div>
        )}
        {marked.length === 0 ? null : (
          <div className={`${noteQuote !== undefined || replyTo !== undefined || hasFiles || pageContexts.length > 0 || text ? 'mb-2' : ''}${tint === undefined ? ' bubble-plain' : ' bubble-ink'}`} {...(tint === undefined ? {} : { style: { '--bubble-ink': tint.ink } as CSSProperties })}>
            {marked.map((image, at) => (
              <MarkComments key={`${image.name}-${at}`} marks={image.marks} {...(marked.length > 1 ? { title: image.name } : {})} />
            ))}
          </div>
        )}
        {noteQuote === undefined ? null : (
          <div className={`${replyTo !== undefined || hasFiles || pageContexts.length > 0 || text ? 'mb-2' : ''} flex justify-end${chipClass}`} {...chipRow}>
            <NoteQuoteContextChip quote={noteQuote} />
          </div>
        )}
        {replyTo === undefined ? null : (
          <div className={`${hasFiles || pageContexts.length > 0 || text ? 'mb-2' : ''} flex justify-end${chipClass}`} {...chipRow}>
            <ReplyContextChip agents={agents} reply={replyTo} />
          </div>
        )}
        {hasFiles ? (
          <div className={`mb-2 flex flex-col items-end gap-1.5${chipClass}`} {...chipRow}>
            {files.map((file, index) => <FileChip key={`${file.name}-${index}`} file={file} />)}
            {documents.map((document, index) => <DocumentChip key={`${document.name}-${index}`} document={document} />)}
          </div>
        ) : null}
        {pageContexts.length > 0 ? (
          <div className={`${text ? 'mb-2' : ''} flex flex-col items-end gap-1.5${chipClass}`} {...chipRow}>
            {pageContexts.map((context) => <PageContextChip key={context.id} context={context} />)}
          </div>
        ) : null}
        {text ? (
          <div
            className={`outline-none focus-visible:ring-2 focus-visible:ring-control${tint === undefined ? ' bubble-plain' : ' bubble-ink'}`}
            {...(tint === undefined ? {} : { style: { '--bubble-ink': tint.ink, '--bubble-wash': tint.wash } as CSSProperties })}
            {...(sourceEventId === undefined ? {} : { 'data-quote-event-id': sourceEventId, tabIndex: -1 })}
          >
            <ClampedMessage clamp={wordCount(text) > CLAMP_WORDS}>
              <MessageMarkdown text={text} agents={agents} skills={skills} images={gallery} quotes={quotes} quoteAuthors={quoteAuthors} {...(onOpenQuoteSource === undefined ? {} : { onOpenQuoteSource })} />
            </ClampedMessage>
          </div>
        ) : null}
        {badge}
      </div> : null}
    </div>
  )
}

/** The box a marked picture stands in within a sent message: big enough to read its pins. */
const MARKED_IMAGE_WIDTH = 320
const MARKED_IMAGE_HEIGHT = 360

/** The numbered comments of one marked picture: its pins, then the shapes the user wrote a comment for. */
function MarkComments({ marks, title }: { marks: readonly NumberedMark[]; title?: string }) {
  return (
    <div className="[&+&]:mt-2">
      {title === undefined ? null : <div className="mb-1 text-meta opacity-70">{title}</div>}
      <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[length:var(--msg-size,16px)] leading-snug" data-mark-comments="">
        {marks.map((mark) => (
          <li key={mark.number} className="flex items-start gap-2">
            <span className="mt-px grid h-[20px] w-[20px] flex-none place-items-center rounded-full bg-mark text-[12px] leading-none font-medium text-on-media">{mark.number}</span>
            <span className="min-w-0 break-words">{mark.comment.trim() === '' ? <span className="opacity-60">No comment</span> : mark.comment}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** A text file sent with a message: named and sized, never quoted back. */
function FileChip({ file }: { file: FileAttachment }) {
  return (
    <span className="flex max-w-full items-center gap-1.5 rounded-chip border border-line bg-raised px-2 py-1 text-[12px] text-text" title={file.name}>
      <FileMark path={file.name} size={13} className="flex-none" />
      <MiddleCut text={file.name} />
      <span className="flex-none text-meta text-dim">{describeBytes(utf8Size(file.content))}</span>
    </span>
  )
}

/** The pictures and files a kickoff carries from the conversation it was handed over from. */
export function KickoffAttachments({ images, files }: { images: readonly EventImage[]; files: readonly FileAttachment[] }) {
  if (images.length === 0 && files.length === 0) return null
  const gallery = images.map((image) => ({ src: eventImageSource(image), alt: image.name }))
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {images.map((image, index) => (
        <TranscriptImage key={`${image.name}-${index}`} image={image} gallery={{ images: gallery, index }} compact />
      ))}
      {files.map((file, index) => <FileChip key={`${file.name}-${index}`} file={file} />)}
    </div>
  )
}

/**
 * What the user typed, drawn as markdown with the composer's chips in it. Older messages
 * still carry the composer's own `• ` bullet, written before sends were normalised,
 * so it is read as the list it was meant to be rather than as a bullet inside one.
 */
function MessageMarkdown({ text, agents, skills, images, quotes, quoteAuthors, onOpenQuoteSource }: { text: string; agents: readonly AgentConfig[]; skills: readonly SkillConfig[]; images: readonly GalleryImage[]; quotes: readonly InlineQuote[]; quoteAuthors: boolean; onOpenQuoteSource?: (eventId: string) => void }) {
  const { markdown, plugins, components } = useMessageChips(normalizeComposerLists(text), agents, skills, images, { quotes, showAuthor: quoteAuthors, ...(onOpenQuoteSource === undefined ? {} : { onOpenSource: onOpenQuoteSource }) })
  return <Markdown text={markdown} plugins={plugins} components={components} sources={false} />
}

/**
 * The chip line under a sent document, and its longer explanation. A document the
 * server has not written down yet is still being read; after that the line says how
 * much text came out, never that the document was "seen".
 */
function documentStatus(document: EventDocument | PendingDocument): { label: string; detail: string } {
  if (!('extraction' in document)) return { label: 'Reading…', detail: 'Manor is extracting the text.' }
  const { status, pageCount, unreadablePages = [], detail } = document.extraction
  const pages = pageCount === undefined ? '' : `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`
  const label = status === 'complete'
    ? pages || 'Text read'
    : status === 'partial'
      ? unreadablePages.length > 0 ? `${pages}, ${unreadablePages.length} unreadable` : 'Partly read'
      : status === 'unknown' ? 'Coverage unknown' : 'No readable text'
  return { label, detail: detail ?? 'All text extracted locally. Images and layout were not viewed.' }
}

/**
 * A sent PDF or Word file. The second line is how much text Manor extracted, since
 * that is all a persona reads; once stored the chip opens the original, a PDF in
 * the viewer and a Word file as a download.
 */
function DocumentChip({ document }: { document: EventDocument | PendingDocument }) {
  const { label, detail } = documentStatus(document)
  const src = 'src' in document ? document.src : undefined
  const incomplete = 'extraction' in document && document.extraction.status !== 'complete'
  const content = (
    <>
      <FileMark path={document.name} size={13} />
      <MiddleCut text={document.name} />
      <span className={`flex-none text-meta ${incomplete ? 'text-warn' : 'text-dim'}`}>{label}</span>
    </>
  )
  const chip = 'flex max-w-full items-center gap-1.5 rounded-chip border border-line bg-raised px-2 py-1 text-[12px] text-text'
  return src === undefined ? (
    <span className={chip} title={`${document.name}, ${detail}`}>{content}</span>
  ) : (
    <a className={`${chip} no-underline hover:border-control`} href={src} target="_blank" rel="noreferrer" title={`Open ${document.name}, ${detail}`}>
      {content}
    </a>
  )
}

/**
 * Past this a message stops being something the user typed and starts being something they
 * pasted, and a brief that runs a screen and a half pushes the answer they want to read
 * off the top of it. Counted in words rather than characters because a word is the unit
 * they wrote in; the cut itself is in lines, in `.clamp`.
 */
const CLAMP_WORDS = 150

const wordCount = (text: string) => {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/**
 * The long bubble, cut to ten lines with the rest behind a fade and a toggle under it.
 *
 * `clamp` is only the word-count gate: it says the message is long enough to be worth
 * cutting, not that cutting it did anything. Whether ten lines actually hides anything
 * depends on the window width and the panel it is in, so the link is hung on a measured
 * overflow instead. A "Show more" over a message that is already whole is a label that
 * lies, and this one repeats down the entire transcript.
 */
export function ClampedMessage({ clamp, lines, children }: {
  clamp: boolean
  /** Lines kept while closed, for a caller that cuts harder than a bubble's ten. */
  lines?: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  const body = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = body.current
    // Measured closed only. Open, the two heights agree by definition, and a
    // re-measure there would delete the way back the moment it is used.
    if (node === null || !clamp || open) return
    const measure = () => setClipped(node.scrollHeight - node.clientHeight > 1)
    measure()
    // The clamped box keeps its height while closed, so this fires on width: which is
    // the case that matters, a narrower column rewrapping the same words into more lines.
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [clamp, open])

  if (!clamp) return <>{children}</>

  return (
    <div>
      <div
        ref={body}
        className="clamp"
        data-open={open}
        data-clipped={clipped}
        {...(lines === undefined ? {} : { style: { '--clamp-lines': lines, '--clamp-fade-lines': Math.min(2.6, lines * 0.4) } as CSSProperties })}
      >
        {children}
      </div>
      {clipped ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          // Below the text, open or closed, so it never covers the last line. The fade
          // on the text above (see `.clamp`) still says the message is cut.
          className="mt-1 flex w-full cursor-pointer justify-end border-0 bg-transparent p-0 text-right text-text hover:underline"
        >
          <span className="text-[13px] font-medium">{open ? 'Show less' : 'Show more'}</span>
        </button>
      ) : null}
    </div>
  )
}

/** The box a picture without a known size (an SVG, say) gets, so it still cannot move the thread. */
const FALLBACK_IMAGE_SIZE = { width: 320, height: 240 }

/**
 * A picture in a message. The frame owns the size: a stored image arrives with its
 * pixel size, anything else falls back to a fixed ratio, and loading, failing and
 * retrying all fill that same frame, so scrolling back never jumps. A link that fails
 * offers another try; a data URL that fails cannot improve.
 */
/**
 * One picture in the thread. With a `gallery` it is one of the pictures the user sent:
 * a fixed 60px square, cropped to fill it, whose viewer steps through its siblings.
 * Without one it is an agent's picture, sized to its own pixels within the column,
 * and a press asks `onOpen` for the file viewer.
 */
function TranscriptImage({ image, frame = '', fit = 'object-cover', gallery, number, marks, compact = false, wide = false, onOpen }: { image: EventImage; frame?: string; fit?: string; gallery?: { images: readonly GalleryImage[]; index: number }; number?: number; marks?: EventImage['annotation'] | undefined; compact?: boolean; wide?: boolean; onOpen?: () => void }) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const source = eventImageSource(image)
  const src = attempt === 0 || image.src === undefined ? source : `${source}${source.includes('?') ? '&' : '?'}retry=${attempt}`
  // A delivered picture carries no pixel size, so its frame takes the loaded picture's own.
  const [loaded, setLoaded] = useState<{ width: number; height: number }>()
  const size = image.width !== undefined && image.height !== undefined ? { width: image.width, height: image.height } : loaded ?? FALLBACK_IMAGE_SIZE
  // The pixel width is what a shrink-wrapped bubble sizes itself to; `max-w-full`
  // then fits it to the column, and the ratio gives the height before a byte loads.
  // A marked picture is read at its own shape, not cropped to a square that may cut a pin.
  const natural = gallery === undefined || wide
  return (
    <div
      className={natural ? `relative min-h-10 max-w-full overflow-hidden rounded-lg ${frame}` : `relative flex-none overflow-hidden rounded-lg ${compact ? 'h-10 w-10' : 'h-15 w-15'}`}
      {...(natural ? { style: { width: wide ? Math.min(size.width, MARKED_IMAGE_WIDTH, (MARKED_IMAGE_HEIGHT * size.width) / size.height) : size.width, aspectRatio: `${size.width} / ${size.height}` } } : {})}
    >
      {failed && image.src !== undefined ? (
        <button
          type="button"
          onClick={() => {
            setFailed(false)
            setAttempt((value) => value + 1)
          }}
          className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-2 text-label text-muted hover:text-text"
        >
          <Icon icon={RefreshIcon} size={16} />
          {natural ? <span className="truncate">Couldn't load {image.name}. Retry</span> : <span className="sr-only">Couldn't load {image.name}. Retry</span>}
        </button>
      ) : onOpen !== undefined ? (
        <button type="button" aria-label={`Open ${image.name}`} className="absolute inset-0 h-full w-full cursor-zoom-in border-0 bg-transparent p-0" onClick={onOpen}>
          <img
            src={src}
            alt={image.name}
            className={`block h-full w-full ${fit}`}
            loading="lazy"
            decoding="async"
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget
              if (image.width === undefined && width > 0 && height > 0) setLoaded({ width, height })
            }}
            onError={() => setFailed(true)}
          />
        </button>
      ) : (
        <ZoomableImage
          src={src}
          alt={image.name}
          frame="absolute inset-0 h-full w-full"
          className={`h-full w-full ${fit}`}
          {...(gallery === undefined ? {} : { gallery })}
          thumbnail={
            <img
              src={src}
              alt={image.name}
              className={`block h-full w-full ${fit}`}
              loading="lazy"
              decoding="async"
              onError={() => setFailed(true)}
            />
          }
        />
      )}
      {number === undefined ? null : <ImageNumberBadge number={number} />}
      <MarkCountBadge annotation={marks} />
    </div>
  )
}

/**
 * Opens an agent's picture in the composer's mark-up editor, so the user can point at
 * what to change and send it back. Shows on hover, the way a picture's other actions do.
 */
function AnnotateButton({ image, annotate }: { image: EventImage; annotate: (image: EventImage) => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')
  return (
    <button
      type="button"
      data-annotate-image=""
      disabled={state === 'loading'}
      className={`absolute right-2 bottom-2 flex h-7 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-media-scrim px-2.5 text-[12px] font-medium text-on-media motion-safe:transition-opacity group-hover/picture:opacity-100 focus-visible:opacity-100 disabled:cursor-default ${state === 'idle' ? 'opacity-0' : 'opacity-100'}`}
      onClick={() => {
        setState('loading')
        annotate(image).then(() => setState('idle'), () => setState('failed'))
      }}
    >
      <Icon icon={state === 'failed' ? RefreshIcon : PencilEdit02Icon} size={13} />
      {state === 'failed' ? "Couldn't load. Retry" : 'Annotate'}
    </button>
  )
}

interface AgentBubbleProps {
  color: string
  text: string
  /** The roster its own mentions are drawn against, the same one the sent bubble uses. */
  agents: readonly AgentConfig[]
  images?: EventImage[]
  /** Set only while the text is still growing. See `Markdown`'s own note on it. */
  live?: boolean
  /** The incoming-message cloud used only in a direct message. */
  bubble?: boolean
  /** Durable messages inside this visual answer; adjacent Work beats may be joined. */
  quoteSources?: readonly MessageQuoteSource[]
  quoteAgentId?: string
  /** A reaction badge on the bubble's bottom left edge, in a DM; a short reply widens to hold it. */
  badge?: ReactNode
  /** False when the gap after the bubble already holds the hanging badge. */
  badgeRoom?: boolean
}

/**
 * One beat inside a signed turn group. Identity and actions live on the group; a DM
 * adds the incoming-message cloud while Work leaves the answer on the page.
 */
function AgentBubbleView({ color, text, agents, images = [], live = false, bubble = false, quoteSources, quoteAgentId, badge, badgeRoom = true }: AgentBubbleProps) {
  const { plugins, components } = useAgentMentions(agents)
  const annotate = useContext(AnnotateImageContext)
  // The file viewer over this message's pictures only, opened at the one pressed.
  const [viewing, setViewing] = useState<number | null>(null)
  const said = quoteSources !== undefined && quoteSources.length > 0 ? quoteSources.some((source) => source.text.length > 0) : text.length > 0
  const [bubbleRef, corner] = useBubbleCorner(bubble && said)
  // In a DM the pictures stand on the chat itself, above the bubble that holds the words.
  const pictures = images.length > 0 ? (
    <div className={`grid grid-cols-2 gap-1.5 ${said && !bubble ? 'mb-2' : ''}`}>
      {images.map((image, index) => (
        <div key={`${image.name}-${index}`} className="group/picture relative min-w-0">
          <TranscriptImage image={image} frame="max-h-[36rem]" fit="object-contain" onOpen={() => setViewing(index)} />
          {annotate === undefined ? null : <AnnotateButton image={image} annotate={annotate} />}
        </div>
      ))}
    </div>
  ) : null
  return (
    <div className={bubble ? `relative flex w-fit max-w-bubble flex-col gap-1.5${badge === undefined ? ' min-w-0' : `${badgeRoom ? ' mb-3' : ''} min-w-14`}` : 'flex min-w-0'}>
      {bubble ? pictures : null}
      {viewing === null ? null : (
        <FileViewer files={eventImageFiles(images)} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      )}
      {/* The reading size is stated on the two message bodies rather than inherited
          from the page: everything else in the transcript (work lines, the routine
          event, timestamps) names its own smaller size, so a size on the column would
          be a size on nothing. `--msg-size` is the one thing the column does set,
          so the narrow side panel can read a step smaller than the stage. */}
      {bubble && !said ? null : (
        <div
          ref={bubbleRef}
          className={
            bubble
              ? `w-full min-w-0 bg-bubble text-[length:var(--msg-size,16px)] ${corner} ${DM_BUBBLE}`
              : 'w-full min-w-0 py-[3px] text-[length:var(--msg-size,16px)]'
          }
          style={accentStyle(color)}
        >
          {bubble ? null : pictures}
          {quoteSources !== undefined && quoteSources.length > 0 ? quoteSources.map((source, index) => (
            <div
              key={source.eventId}
              data-quote-event-id={source.eventId}
              data-quote-agent-id={quoteAgentId}
              className={index === 0 ? 'outline-none focus-visible:ring-2 focus-visible:ring-control' : 'mt-2 outline-none focus-visible:ring-2 focus-visible:ring-control'}
              tabIndex={-1}
            >
              <Markdown text={source.text} plugins={plugins} components={components} />
            </div>
          )) : text.length > 0 ? (
            <Markdown text={text} plugins={plugins} components={components} reveal={live} stableBlocks />
          ) : null}
        </div>
      )}
      {bubble ? badge : null}
    </div>
  )
}

/**
 * Every finished reply in the transcript re-rendered on every streaming delta, which
 * is the whole idle cost of a long thread. The props were already stable bar the
 * empty image list, so this needs no comparator: `state.ts` hands out one shared
 * `NO_IMAGES` and the rest are strings and the roster.
 */
export const AgentBubble = memo(AgentBubbleView)

const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const LATE_DUE = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * A turn the scheduler started, announced as what it is.
 *
 * Never a `UserBubble`: the prompt was written once, months ago, in the Routines
 * view, and rendering it on the right in the user's own colour puts words in their mouth
 * every morning and ruins the transcript as a record of who said what. So it reads
 * as an event — `Routine, Morning brief, 07:12` — and opens onto the prompt for
 * the one moment anybody wants it, which is when the answer above makes no sense and
 * the question explains why. The turn beneath renders through the ordinary
 * `TurnHeader` path, because it is an ordinary turn.
 */
export function RoutineLine({ name, ts, prompt, dueAt }: { name: string | undefined; ts: number; prompt: string; dueAt?: number }) {
  const [open, setOpen] = useState(false)
  // A one-time fire that landed after a sleeping Mac says so, with the moment it was for.
  const late = dueAt !== undefined && ts - dueAt > ROUTINE_LATE_AFTER_MS
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-3 py-0.5 text-[12px] text-dim [font:inherit] hover:text-muted"
        aria-expanded={open}
        title={open ? 'Hide the prompt' : 'Show the prompt'}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon icon={Clock01Icon} size={12} />
        {/* A routine deleted or renamed since does not rewrite what happened, so the
            name is the one frozen into the event. Without one the line still stands
            for itself: this was not typed by hand. */}
        <span>
          Routine{name === undefined ? '' : `, ${name}`}, {CLOCK.format(new Date(ts))}
          {late ? `, late, due ${LATE_DUE.format(new Date(dueAt))}` : ''}
        </span>
      </button>
      {open ? (
        <div className="max-w-[78%] rounded-xl border border-line px-[13px] py-[9px] text-[13px] whitespace-pre-wrap text-muted">
          {prompt}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Where background work a persona started came back and it spoke again unasked. One
 * quiet line naming what ended. The prompt Manor sent the persona, with the child's raw
 * answer and task id, is for the model and never rendered.
 */
export function WakeLine({ items }: { items: readonly WakeItem[] }) {
  const failed = items.some((item) => item.state === 'failed')
  return (
    <div className="flex justify-center">
      <span className="flex max-w-full min-w-0 items-start gap-1.5 px-3 py-0.5 text-[12px] text-dim">
        <Icon icon={failed ? AlertCircleIcon : TaskDone01Icon} size={12} className="mt-[3px] flex-none" />
        <span className="flex min-w-0 flex-col">
          {wakeLines(items).map((line, index) => <span key={index} className="truncate">{line}</span>)}
        </span>
      </span>
    </div>
  )
}

/**
 * A project thread's write to its own file: what happened, to which file, and the line.
 * The line clamps to two rows; a click unfolds it, the hover title holds it whole.
 */
export function ProjectFileWriteCard({ write, projectName }: { write: ProjectFileWrite; projectName?: string | undefined }) {
  const [open, setOpen] = useState(false)
  const detail = projectFileWriteDetail(write)
  const mark = write.action === 'remove' ? MinusSignIcon : write.action === 'restore' ? Undo02Icon : Tick02Icon
  return (
    <div className="flex justify-center">
      <button
        type="button"
        disabled={detail === undefined}
        aria-expanded={detail === undefined ? undefined : open}
        title={detail}
        onClick={() => setOpen((current) => !current)}
        className="flex max-w-full min-w-0 cursor-pointer items-start gap-2 rounded-xl border border-line bg-composer-tray px-2.5 py-1.5 text-left text-label text-muted [font-family:inherit] hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-composer-tray"
      >
        <Icon icon={mark} size={13} className="mt-[2.5px] flex-none" />
        <span className="flex min-w-0 flex-col">
          <span>{projectFileWriteLabel(write, projectName)}</span>
          {detail === undefined ? null : (
            <span className={`text-dim [overflow-wrap:anywhere] ${open ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{detail}</span>
          )}
        </span>
      </button>
    </div>
  )
}

/**
 * What a reply wrote to memory through the memory tool, as one footnote under it:
 * "Saved 1 line to notes.md" for a project thread, "Saved 1 rule" for an agent. It
 * opens to the lines themselves, each with its own Undo.
 */
export function FileWriteFootnote({ writes }: { writes: readonly ProjectFileWrite[] }) {
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion() ?? false
  const listId = useId()
  const groups = fileWriteGroups(writes)
  const hasLines = groups.some((group) => group.lines.length > 0)
  return (
    <div className="flex min-w-0 flex-col items-start">
      <button
        type="button"
        disabled={!hasLines}
        aria-expanded={hasLines ? open : undefined}
        aria-controls={hasLines ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
        className="-mx-1.5 flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-left text-[12px] text-dim [font-family:inherit] hover:text-muted disabled:cursor-default disabled:hover:text-dim"
      >
        <Icon icon={Tick02Icon} size={12} className="flex-none" />
        <span className="min-w-0 truncate">{groups.map((group) => group.label).join(', ')}</span>
        {hasLines ? <Icon icon={ArrowDown01Icon} size={12} className={`flex-none transition-transform duration-200 ${open ? 'rotate-180' : ''}`} /> : null}
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="lines"
            id={listId}
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={DISCLOSURE}
            className="w-full overflow-hidden"
          >
            <dl className="m-0 flex flex-col gap-1 pt-1 pl-[18px] text-[12px] leading-[1.45]">
              {groups.map((group) => group.lines.length === 0 ? null : (
                <div key={group.label} className="flex flex-col">
                  {/* One kind of write is already named on the line above. */}
                  <dt className={groups.length === 1 ? 'sr-only' : 'text-dim'}>{group.label}</dt>
                  {group.writes.map((write, index) => <WrittenLine key={write.writeId ?? index} write={write} line={group.lines[index]!} />)}
                </div>
              ))}
            </dl>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

/**
 * One written line with its Undo. The server refuses when the line changed since, and
 * its reason shows beside the button; nothing is written then.
 */
function WrittenLine({ write, line }: { write: ProjectFileWrite; line: string }) {
  const actions = useContext(NotesActionsContext)
  const { pending, start } = useRequest(actions?.requestEvents ?? NO_REQUEST_EVENTS)
  const [refusal, setRefusal] = useState<string | null>(null)
  const { writeId } = write
  const undone = write.undone === true
  return (
    <dd className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 text-muted">
      <span className={`min-w-0 [overflow-wrap:anywhere] ${undone ? 'text-dim line-through' : ''}`}>{line}</span>
      {undone ? <span className="text-dim">Undone</span> : null}
      {undone || writeId === undefined || actions === undefined ? null : (
        <button
          type="button"
          disabled={pending || !actions.connected}
          className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-dim underline-offset-2 [font-family:inherit] hover:text-text hover:underline disabled:cursor-default disabled:no-underline"
          onClick={() => {
            setRefusal(null)
            start((requestId) => actions.undoWrite(writeId, requestId), { onNotice: (notice) => setRefusal(notice.text), noticeInPlace: true })
          }}
        >
          {pending ? 'Undoing…' : 'Undo'}
        </button>
      )}
      {refusal === null ? null : <span role="status" className="text-warn">{refusal}</span>}
    </dd>
  )
}

const NO_REQUEST_EVENTS: RequestEvents = { subscribe: () => () => undefined }

/** A centred note line; `action` puts one small text button after its words. */
export function SystemLine({ kind, text, action }: { kind: 'error' | 'aborted' | 'info'; text: string; action?: { label: string; onClick: () => void } }) {
  const tone = kind === 'error' ? 'text-danger' : kind === 'aborted' ? 'text-warn' : 'text-dim'
  return (
    <div className="flex justify-center">
      <div className={`px-3 py-0.5 text-center text-[12px] ${tone}`}>
        {text}
        {action === undefined ? null : (
          <>
            {' '}
            <button type="button" onClick={action.onClick} className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted [font:inherit] hover:text-text">
              {action.label}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
