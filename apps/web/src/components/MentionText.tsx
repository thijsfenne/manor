import { BoxIcon, BubbleChatIcon, ComputerIcon, File01Icon, Globe02Icon, Image01Icon, MessageMultiple01Icon } from '@hugeicons/core-free-icons'
import { numberedMarks, quoteExcerpt, quoteText, type AgentConfig, type ImageAnnotation, type InlineQuote, type SkillConfig } from '@manor/contracts'
import { quoteAuthorName } from '@manor/client-runtime/message-quotes'
import { accentStyle } from '../accent'
import { useRef, useState, type ReactNode } from 'react'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { HoverCard } from './ui/HoverCard'
import { useDismiss } from './ui/useDismiss'
import { useHoverCard } from './ui/useHoverCard'
import { ImageLightbox, type GalleryImage } from './ui/ZoomableImage'

/**
 * A file pointer from the composer. The chip shows the file name and carries the
 * whole pointer in its title: a path is long, a bubble is narrow, and the segment
 * someone scans for is the last one. The text the persona received is unchanged.
 */
export function FileChip({ path }: { path: string }) {
  return (
    <span
      title={path}
      data-inline-chip
      className="mx-[1px] inline-flex max-w-full items-center gap-[4px] rounded-chip bg-[color-mix(in_srgb,var(--color-muted)_22%,transparent)] px-[5px] py-[1px] align-middle text-[0.92em] whitespace-normal text-text"
    >
      <Icon icon={File01Icon} size={12} className="flex-none text-muted" />
      {path.slice(path.lastIndexOf('/') + 1)}
    </span>
  )
}

export function DestinationChip({ kind }: { kind: 'browser' | 'computer' | 'work' }) {
  const icon = kind === 'browser' ? Globe02Icon : kind === 'computer' ? ComputerIcon : MessageMultiple01Icon
  const label = kind === 'browser' ? 'Browser' : kind === 'computer' ? 'Computer Use' : 'Sessions'
  return (
    <span
      data-mention-target={kind}
      data-inline-chip
      className="mx-[1px] inline-flex max-w-full items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--color-muted)_18%,transparent)] py-[3px] pr-[7px] pl-[5px] align-middle text-[0.92em] leading-none font-medium whitespace-normal text-text"
    >
      <Icon icon={icon} size={13} className="flex-none text-muted" />
      {label}
    </span>
  )
}

export function SkillChip({ skill }: { skill: SkillConfig }) {
  return (
    <span
      title={skill.description}
      data-inline-chip
      data-skill-chip
      className="mx-[1px] inline-flex max-w-full items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--color-skill)_20%,transparent)] py-[3px] pr-[7px] pl-[5px] align-middle text-[0.92em] leading-none font-medium whitespace-normal text-[var(--color-skill)]"
    >
      <Icon icon={BoxIcon} size={13} className="flex-none text-[var(--color-skill)]" />
      {skill.name}
    </span>
  )
}

/**
 * One named persona, wherever a mention of it is drawn: the sent bubble, the composer and
 * an agent's own markdown through `useAgentMentions`. It carries the mentioned
 * agent's accent rather than the speaker's, so a delegation shows the colour of
 * whoever was summoned.
 */
export function AgentChip({ agent }: { agent: AgentConfig }) {
  return (
    <span
      data-inline-chip
      data-agent-chip
      className="relative -top-0.5 mx-[1px] inline-flex max-w-full items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] py-[3px] pr-[7px] pl-[4px] align-middle text-[0.92em] leading-none font-medium whitespace-normal text-[var(--accent-fg)]"
      style={accentStyle(agent.color)}
    >
      <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} size={15} />
      {/* Geist sits high at a line height of 1: the name drops a pixel inside the pill, and the pill rises two so it centres on the text around it. */}
      <span className="relative top-px">{agent.name}</span>
    </span>
  )
}

/** Pictures and quotes, what a message carries with it, rather than who or what it addresses. */
const CARRIED_CHIP = 'mx-[1px] inline-flex max-w-full items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--color-busy)_18%,transparent)] py-[3px] pr-[7px] pl-[5px] align-middle text-[0.92em] leading-none font-medium text-[var(--color-busy)]'
const IMAGE_CHIP = `${CARRIED_CHIP} whitespace-normal`
const QUOTE_CHIP = `${CARRIED_CHIP} whitespace-nowrap`
const CARRIED_CHIP_HOVER = 'hover:bg-[color-mix(in_srgb,var(--color-busy)_28%,transparent)]'

/**
 * `[Image #n]`, one of the pictures this message carries, by the number its thumbnail
 * wears. In the composer it is only the pill; in a sent message `images` makes it the
 * way back to the picture, opening the same viewer its thumbnail does.
 */
export function ImageRefChip({ number, images }: { number: number; images?: readonly GalleryImage[] }) {
  const [open, setOpen] = useState(false)
  const content = (
    <>
      <Icon icon={Image01Icon} size={13} className="flex-none" />
      Image #{number}
    </>
  )
  const image = images?.[number - 1]
  if (images === undefined || image === undefined) return <span data-image-ref={number} data-inline-chip className={IMAGE_CHIP}>{content}</span>
  return (
    <>
      <button
        type="button"
        data-image-ref={number}
        data-inline-chip
        aria-label={`Open image ${number}, ${image.alt}`}
        className={`${IMAGE_CHIP} cursor-zoom-in border-0 [font-family:inherit] ${CARRIED_CHIP_HOVER}`}
        onClick={() => setOpen(true)}
      >
        {content}
      </button>
      {open ? <ImageLightbox src={image.src} alt={image.alt} gallery={{ images, index: number - 1 }} className="" onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/** Where a quote came from, in the words of its hover card. Undefined when nothing is worth naming. */
function quoteSource(quote: InlineQuote, agents: readonly AgentConfig[], showAuthor: boolean) {
  if (quote.kind === 'message') return quoteAuthorName(quote, agents, showAuthor)
  return quote.kind === 'note' ? quote.path.split('/').pop() : quote.context.label
}

/**
 * `[Quote #n]`, one of the selections this message carries, at the place in the sentence
 * it was put. In the composer it is only the pill, with the full words in its title. In a
 * sent message `sent` makes it a control: hovering or pressing it opens the whole quote,
 * and a quote of a message in this chat offers the way back to it.
 */
export function QuoteRefChip({ number, quote, sent }: {
  number: number
  quote: InlineQuote
  sent?: { agents: readonly AgentConfig[]; showAuthor: boolean; onOpenSource?: (eventId: string) => void }
}) {
  const content = (
    <>
      <Icon icon={BubbleChatIcon} size={13} className="flex-none" />
      {quoteExcerpt(quote)}
    </>
  )
  if (sent === undefined) return <span data-quote-ref={number} data-inline-chip title={quoteText(quote)} className={QUOTE_CHIP}>{content}</span>
  return <SentQuoteChip number={number} quote={quote} content={content} {...sent} />
}

function SentQuoteChip({ number, quote, content, agents, showAuthor, onOpenSource }: {
  number: number
  quote: InlineQuote
  content: ReactNode
  agents: readonly AgentConfig[]
  showAuthor: boolean
  onOpenSource?: (eventId: string) => void
}) {
  const { anchorRef, card, show, hide, scheduleShow, scheduleHide } = useHoverCard<HTMLButtonElement>()
  const cardRef = useRef<HTMLDivElement>(null)
  // A click keeps the card open after the pointer leaves, until a press elsewhere or Escape.
  const pinned = useRef(false)
  const close = () => {
    pinned.current = false
    hide()
  }
  const leave = () => {
    if (!pinned.current) scheduleHide()
  }
  useDismiss(card?.open === true, close, { within: [anchorRef, cardRef] })
  const source = quoteSource(quote, agents, showAuthor)
  const openSource = quote.kind === 'message' && onOpenSource !== undefined ? () => { close(); onOpenSource(quote.eventId) } : undefined
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-quote-ref={number}
        data-inline-chip
        aria-label={`Show quote ${number}`}
        aria-expanded={card?.open === true}
        className={`${QUOTE_CHIP} cursor-pointer border-0 [font-family:inherit] ${CARRIED_CHIP_HOVER}`}
        onPointerEnter={scheduleShow}
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') leave() }}
        onClick={() => {
          pinned.current = true
          show()
        }}
      >
        {content}
      </button>
      {card === null ? null : (
        <HoverCard anchor={card.anchor} open={card.open} width={320} label="Quote" onClose={close} onPointerEnter={show} onPointerLeave={leave} className="p-3">
          <div ref={cardRef} className="flex min-h-0 flex-col gap-1.5" data-quote-card={number}>
            {source === undefined ? null : <span className="truncate text-[12px] leading-[1.4] font-medium text-text">{source}</span>}
            <p className="m-0 max-h-[280px] overflow-y-auto text-[13px] leading-[1.5] break-words whitespace-pre-wrap text-muted">{quoteText(quote)}</p>
            {openSource === undefined ? null : (
              <button type="button" className="cursor-pointer self-start border-0 bg-transparent p-0 text-[12px] font-medium text-[var(--color-busy)] [font-family:inherit] hover:underline" onClick={openSource}>
                Show source
              </button>
            )}
          </div>
        </HoverCard>
      )}
    </>
  )
}

/**
 * The number a picture answers to, on its thumbnail in the composer tray and in a sent
 * message whose text refers to its pictures. Over the picture, so it reads on any of them.
 */
export function ImageNumberBadge({ number }: { number: number }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute bottom-1 left-1 rounded-full bg-media-scrim px-1.5 py-px text-[12px] leading-4 font-medium text-on-media">
      #{number}
    </span>
  )
}

/**
 * How many numbered marks a picture carries, its pins and the shapes with a comment, on
 * its thumbnail in the composer tray and in a sent message.
 */
export function MarkCountBadge({ annotation }: { annotation: ImageAnnotation | undefined }) {
  const count = annotation === undefined ? 0 : numberedMarks(annotation).length
  if (count === 0) return null
  return (
    <span
      role="img"
      data-mark-count={count}
      aria-label={`${count} numbered ${count === 1 ? 'mark' : 'marks'}`}
      className="pointer-events-none absolute right-1 bottom-1 grid h-[19px] min-w-[19px] place-items-center rounded-full bg-mark px-1 text-[12px] leading-none font-medium text-on-media"
    >
      {count}
    </span>
  )
}
