import { BookOpen01Icon } from '@hugeicons/core-free-icons'
import type { MessageQuote, NoteQuote } from '@manor/contracts'
import { SourceContextChip } from './PageContextChip'

/** Selected words from a Knowledge note, on a message from before inline quotes. */
export function NoteQuoteContextChip({ quote }: { quote: NoteQuote }) {
  const name = quote.path.split('/').pop() ?? quote.path
  return <SourceContextChip
    detail={quote.text}
    icon={BookOpen01Icon}
    name={name}
    title={`${quote.path}\n${quote.text}`}
  />
}

/**
 * The one quote a message from before inline quotes carried, drawn as a markdown blockquote: a thin bar, the
 * excerpt, no fill. The bar is the text colour at partial strength, so it reads on the
 * grey bubble and on every tint without a token of its own. The excerpt keeps the
 * bubble's full ink on a tint: dimming white would drop it below AA on the fill.
 * `author` is set only where the room has several personas.
 */
export function QuoteBlock({
  quote,
  author,
  onOpen,
}: {
  quote: MessageQuote
  author?: string
  onOpen?: () => void
}) {
  const body = <>
    {author === undefined ? null : <span className="block text-[12px] leading-[1.4] font-medium text-text">{author}</span>}
    <span className="line-clamp-2 text-[13px] leading-[1.45] break-words text-muted">{quote.text}</span>
  </>
  const frame = 'block min-w-0 border-0 border-l-2 border-solid border-current/35 pl-2.5 text-left'
  return onOpen === undefined ? (
    <span className={frame} title={quote.text}>{body}</span>
  ) : (
    <button
      type="button"
      className={`${frame} cursor-pointer bg-transparent p-0 pl-2.5 text-inherit [font:inherit] hover:opacity-80`}
      aria-label={author === undefined ? 'Open source message' : `Open source message from ${author}`}
      title={quote.text}
      onClick={onOpen}
    >
      {body}
    </button>
  )
}
