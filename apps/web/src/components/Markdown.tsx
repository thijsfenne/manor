import {
  Alert01Icon,
  Alert02Icon,
  BookOpen01Icon,
  CheckmarkCircle02Icon,
  Globe02Icon,
  HelpCircleIcon,
  Idea01Icon,
  InformationCircleIcon,
  Note01Icon,
  QuoteDownIcon,
} from '@hugeicons/core-free-icons'
import { createContext, createElement, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ElementType, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps, type UrlTransform } from 'react-markdown'
import { faviconSource, isSingleUseConnectLink, markdownImageSource } from '@manor/contracts'
import remarkGfm from 'remark-gfm'
import { rehypeRevealWords, type RevealCount } from '../revealWords'
import { isSourceLink, sourceItemHref } from '../sourceLinks'
import { calloutTone, type CalloutTone } from '../vaultNotes'
import { ExternalLink } from './ExternalLink'
import { MermaidBlock } from './MermaidDiagram'
import { Icon } from './Icon'
import { useRepoFileLink } from './RepoFileLink'
import { ScrollFade } from './ui/ScrollFade'
import { ZoomableImage } from './ui/ZoomableImage'
import { StreamingMarkdown, type StreamingTail } from '../streamingMarkdown'

type RemarkPlugins = NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']> & unknown[]

/**
 * Chat rhythm, not document rhythm. Every block trims its outer margin so a
 * one-line answer stays one line tall, and long unbroken tokens wrap instead of
 * stretching the bubble. Raw HTML stays disabled: agent output is untrusted text.
 */
const chat: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  // Sized in em against the message body rather than in pixels, because the body is
  // not one size: the stage reads at 17px and the side panel at 14px, so a fixed 17px
  // heading was level with the text on the stage and a shout in the panel. Weight is
  // 500 everywhere in this app, which leaves size as the only rank a heading has.
  h1: ({ children }) => <h2 className="mt-4 mb-2 text-[1.25em] leading-snug font-medium first:mt-0">{children}</h2>,
  h2: ({ children }) => <h3 className="mt-4 mb-2 text-[1.15em] leading-snug font-medium first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1.5 text-[1.08em] font-medium first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-3 mb-1.5 text-[1em] font-medium first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="mt-3 mb-1.5 text-[0.85em] font-medium text-muted first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-3 mb-1.5 text-[0.85em] font-medium text-muted first:mt-0">{children}</h6>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0 marker:text-dim">
      <InBullets.Provider value={true}>{children}</InBullets.Provider>
    </ul>
  ),
  // `start` is carried, never assumed: a bullet list between two numbered items ends
  // the first list, so item 2 arrives as a second <ol> that begins at 2. Dropping the
  // attribute is what makes a three-step checklist read as three step ones.
  ol: ({ children, start }) => (
    <ol start={start} className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0 marker:text-dim">
      <InBullets.Provider value={false}>{children}</InBullets.Provider>
    </ol>
  ),
  // A task item wears its checkbox where the bullet would be, never both. remark-gfm
  // marks exactly those items, so a mixed list keeps bullets on the plain ones.
  li: ({ children, className, node }) => (
    <ListItem className={className} node={node}>{children}</ListItem>
  ),
  input: ({ type, checked, disabled }) =>
    type !== 'checkbox' ? null : (
      // Read-only on purpose: ticking a box is a write, and every write in this tab
      // is one the user pressed Save on.
      <input
        type="checkbox"
        checked={checked === true}
        disabled={disabled !== false}
        readOnly
        className="mr-2 -ml-6 h-[13px] w-[13px] translate-y-[2px] cursor-default accent-[var(--color-control)]"
      />
    ),
  a: ({ children, href, node }) => (
    <InLink.Provider value={true}>
      <MarkdownLink href={href} source={isSourceLink(href, node)}>{children}</MarkdownLink>
    </InLink.Provider>
  ),
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-dim line-through">{children}</del>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line pl-3 text-muted first:mt-0 last:mb-0">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-0 border-t border-line" />,
  img: ({ src, alt }) => {
    const source = typeof src === 'string' && src !== '' ? src : undefined
    return <MarkdownImage key={source} src={source} alt={alt ?? ''} />
  },
  // Inline code reads as a chip; the same element inside <pre> is stripped back
  // to plain text so the block owns the frame.
  code: ({ children, className }) => (
    <code className={`rounded-sm bg-surface-2 px-1 py-px font-mono text-[13px] ${className ?? ''}`}>{children}</code>
  ),
  pre: withDiagrams(({ children }) => (
    <pre className="my-2 whitespace-pre-wrap rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[13px] leading-[1.55] [overflow-wrap:anywhere] first:mt-0 last:mb-0 [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:whitespace-pre-wrap">
      {children}
    </pre>
  )),
  // Rows are the only rule the eye needs, so the grid is dropped and the scroller
  // does the rest: the table takes the width its content asks for and slides
  // sideways, instead of squeezing five columns into the width of one.
  table: ({ children }) => (
    <ScrollFade className="my-3 first:mt-0 last:mb-0">
      <table className="w-max min-w-full border-collapse text-[14px]">{children}</table>
    </ScrollFade>
  ),
  tr: ({ children }) => <tr className="border-b border-line">{children}</tr>,
  th: ({ children }) => (
    <th className="px-3 py-2 text-left align-top font-semibold text-muted first:pl-0 last:pr-0">
      <Cell>{children}</Cell>
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 align-top first:pl-0 last:pr-0">
      <Cell>{children}</Cell>
    </td>
  ),
}

/**
 * The measure a cell is allowed to reach before it wraps. Cells carry it on an inner
 * box rather than on the cell itself: `max-width` on a `<td>` is only a hint in auto
 * table layout, and without a real cap a single long sentence makes one column as
 * wide as the whole answer.
 */
const Cell = ({ children }: { children: ReactNode }) => <div className="max-w-[46ch]">{children}</div>

/**
 * True for the block a live reply is still writing. Its fence may not be closed yet,
 * so a diagram there would be drawn from half a source; it stays code until text
 * follows it or the turn ends.
 */
const OpenBlock = createContext(false)

type PreProps = ComponentProps<'pre'> & ExtraProps

/** A code block that draws itself when it is a finished ```mermaid fence. */
function withDiagrams(Pre: (props: PreProps) => ReactNode) {
  return function DiagramPre(props: PreProps) {
    const open = useContext(OpenBlock)
    const source = open ? undefined : mermaidSource(props.node)
    if (source === undefined) return <Pre {...props} />
    return <MermaidBlock key={source} source={source} fallback={<Pre {...props} />} />
  }
}

type HastChild = NonNullable<ExtraProps['node']>['children'][number]

/** The text of a `<pre>` whose code is tagged mermaid, or nothing for any other block. */
export function mermaidSource(pre: ExtraProps['node']): string | undefined {
  const code = pre?.children[0]
  if (code?.type !== 'element' || code.tagName !== 'code') return undefined
  const className = code.properties.className
  if (!Array.isArray(className) || !className.includes('language-mermaid')) return undefined
  const source = textOf(code).trim()
  return source === '' ? undefined : source
}

const textOf = (node: HastChild): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : ''

const LINK = 'text-[var(--accent-fg)] underline underline-offset-2 hover:no-underline'
/**
 * A cited page inside a sentence. The wash and the slightly smaller type set it apart
 * from prose; its own line box stays under the paragraph's, so it never pushes the line
 * apart. It never breaks between icon and label: a title too long for the line ends in
 * an ellipsis, and the link keeps the whole title as its name.
 */
const SOURCE_PILL =
  'inline-flex max-w-full items-center gap-[0.3em] rounded-full bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)] px-[0.5em] py-[0.08em] align-[-0.18em] text-[0.88em] leading-[1.3] text-muted no-underline transition-colors hover:bg-[color-mix(in_srgb,var(--color-text)_12%,transparent)] hover:text-text'

/**
 * Where a written link goes. A path a linked folder holds opens in the files panel,
 * because that is where this app reads files and a repo path is not somewhere a
 * browser can go; everything else is a website and keeps the one policy
 * `ExternalLink` sets. A repo file is a button rather than an anchor: it navigates
 * nothing, and a middle click should not open a tab onto a path that does not exist.
 */
function MarkdownLink({ href, source = false, children }: { href?: string; source?: boolean; children: ReactNode }) {
  const openFile = useRepoFileLink(href)
  const cites = useContext(CitesSources)
  const inSourceItem = useContext(InSourceItem)
  if (openFile === null && source && cites && !inSourceItem) {
    return (
      <ExternalLink href={href} target="_blank" rel="noreferrer noopener" className={SOURCE_PILL}>
        <Favicon key={href} href={href} className="h-[1em] w-[1em] flex-none" />
        <span className="min-w-0 truncate">{children}</span>
      </ExternalLink>
    )
  }
  if (openFile === null) {
    return (
      <ExternalLink href={href} target="_blank" rel="noreferrer noopener" className={LINK}>
        {children}
      </ExternalLink>
    )
  }
  return (
    <button type="button" className={`${LINK} inline cursor-pointer text-left`} onClick={openFile}>
      {children}
    </button>
  )
}

/** False for text that cites nothing: a note, or a message the user wrote. Its links stay links. */
const CitesSources = createContext(true)
/** True directly inside a bulleted list, the only list whose marks a source may replace. */
const InBullets = createContext(false)
/** True inside a Sources list item, whose link stays a plain link beside its site's icon. */
const InSourceItem = createContext(false)

/**
 * A list item. In a bulleted list, an item that is only a web link is a source: the
 * site's icon takes the bullet's place and the link keeps its ordinary look, so a
 * Sources list reads as a list rather than a column of pills.
 */
function ListItem({ className, node, children }: { className: string | undefined; node: ExtraProps['node']; children: ReactNode }) {
  const bullets = useContext(InBullets)
  const cites = useContext(CitesSources)
  const source = bullets && cites && !isTask(className) ? sourceItemHref(node) : undefined
  if (source === undefined) {
    return <li className={`[&>ul]:my-1 [&>ol]:my-1 [&>p]:my-0 ${isTask(className) ? 'list-none' : ''}`}>{children}</li>
  }
  return (
    <li className="relative list-none [&>p]:my-0">
      <Favicon key={source} href={source} className="absolute top-[0.3em] -left-5 h-[1em] w-[1em]" />
      <InSourceItem.Provider value={true}>{children}</InSourceItem.Provider>
    </li>
  )
}

/**
 * A site's icon, fetched by the Mac (`faviconSource`) so the page CSP stays closed. It
 * holds its square while loading, and a site without one, or a link the proxy will not
 * fetch, shows a neutral globe instead of a broken picture.
 */
function Favicon({ href, className }: { href: string | undefined; className: string }) {
  const source = faviconSource(href)
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  // A streamed reply remounts as the finished one; a cached icon must not blink out for a frame.
  const image = useRef<HTMLImageElement>(null)
  useLayoutEffect(() => {
    if (image.current?.complete === true && image.current.naturalWidth > 0) setState('loaded')
  }, [])
  if (source === undefined || state === 'failed') {
    return <Icon icon={Globe02Icon} size="1em" strokeWidth={1.8} aria-hidden className={`${className} text-dim`} />
  }
  return (
    <img
      ref={image}
      src={source}
      alt=""
      aria-hidden
      draggable={false}
      onLoad={() => setState('loaded')}
      onError={() => setState('failed')}
      className={`${className} rounded-[3px] object-contain ${state === 'loaded' ? '' : 'opacity-0'}`}
    />
  )
}

/** True inside a written link, where a picture is the link's face and the link keeps the click. */
const InLink = createContext(false)

/**
 * A picture written into a message. A remote one comes through Manor's own proxy, so
 * the page CSP stays closed to other hosts. While it loads it holds the cap's height,
 * so a photo, which nearly always reaches the cap, lands without moving the text under
 * it. A picture that cannot be shown reads as a link with its alt text.
 */
function MarkdownImage({ src, alt }: { src: string | undefined; alt: string }) {
  const inLink = useContext(InLink)
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  // A streamed reply remounts as the finished one; a picture the browser already has
  // must not flash back to its placeholder for a frame.
  const image = useRef<HTMLImageElement>(null)
  useLayoutEffect(() => {
    if (image.current?.complete === true && image.current.naturalWidth > 0) setState('loaded')
  }, [])
  // A Composio sign-in link is single-use: loading it as an image would consume it.
  if (src !== undefined && isSingleUseConnectLink(src)) return null
  const source = markdownImageSource(src)
  if (source === undefined || state === 'failed') return <ImageFallback src={src} alt={alt} inLink={inLink} />
  const loaded = state === 'loaded'
  const picture = (
    <span
      className={loaded
        ? 'block w-fit max-w-full'
        : 'relative block h-[320px] w-[min(100%,420px)] rounded-lg bg-surface-2'}
    >
      <img
        ref={image}
        src={source}
        alt={alt}
        onLoad={() => setState('loaded')}
        onError={() => setState('failed')}
        className={loaded
          ? 'block h-auto max-h-[320px] w-auto max-w-full rounded-lg'
          : 'absolute inset-0 h-full w-full opacity-0'}
      />
    </span>
  )
  if (inLink) return <span className="my-2 block">{picture}</span>
  return <ZoomableImage src={source} alt={alt} frame="my-2 max-w-full" thumbnail={picture} />
}

function ImageFallback({ src, alt, inLink }: { src: string | undefined; alt: string; inLink: boolean }) {
  const label = alt === '' ? src : alt
  if (inLink || src === undefined || /^(data|blob):/i.test(src)) return alt === '' ? null : <>{alt}</>
  return <MarkdownLink href={src}>{label}</MarkdownLink>
}

/**
 * Document rhythm: something read for minutes rather than glanced at.
 *
 * Body text goes up to 15px at full contrast, because a note is the content and not
 * a quote from somebody else. Every heading takes its space from above rather than
 * splitting it evenly, so a section reads as belonging to the heading over it. All six
 * ranks are Medium, so the ladder is size, colour and case rather than weight: a point
 * of size each would not separate them, which is why the bottom two go small caps.
 *
 * No syntax highlighting. Async highlighting means a second paint on every note,
 * and the vault is prose with the occasional command in it.
 */
const document: Components = {
  ...chat,
  h1: ({ children }) => (
    <h2 className="mt-9 mb-3 text-[24px] leading-tight font-medium tracking-[-0.02em] text-text first:mt-0">
      {children}
    </h2>
  ),
  h2: ({ children }) => (
    <h3 className="mt-8 mb-2.5 text-[19px] leading-snug font-medium tracking-[-0.01em] text-text first:mt-0">
      {children}
    </h3>
  ),
  h3: ({ children }) => <h4 className="mt-6 mb-2 text-[16px] font-medium text-text first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-5 mb-1.5 text-[15px] font-medium text-text first:mt-0">{children}</h5>,
  h5: ({ children }) => (
    <h6 className="mt-5 mb-1.5 text-[14px] font-medium tracking-[0.02em] text-muted uppercase first:mt-0">
      {children}
    </h6>
  ),
  h6: ({ children }) => (
    <h6 className="mt-5 mb-1.5 text-[13px] font-medium tracking-[0.02em] text-dim uppercase first:mt-0">
      {children}
    </h6>
  ),
  ul: ({ children }) => (
    <ul className="my-[0.9em] list-disc space-y-1.5 pl-6 first:mt-0 last:mb-0 marker:text-dim">{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="my-[0.9em] list-decimal space-y-1.5 pl-6 first:mt-0 last:mb-0 marker:text-dim">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-[1.1em] border-l-2 border-line pl-4 text-muted italic first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-8 border-0 border-t border-line" />,
  img: ({ src, alt }) => typeof src === 'string' && isSingleUseConnectLink(src) ? null : (
    <ZoomableImage
      src={typeof src === 'string' ? src : undefined}
      alt={alt ?? ''}
      frame="my-5 max-w-full"
      className="max-w-full rounded-xl"
    />
  ),
  pre: withDiagrams(({ children }) => (
    <pre className="my-[1.1em] whitespace-pre-wrap rounded-xl border border-line bg-surface px-4 py-3 font-mono text-[13px] leading-[1.6] [overflow-wrap:anywhere] first:mt-0 last:mb-0 [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:whitespace-pre-wrap">
      {children}
    </pre>
  )),
  table: ({ children }) => (
    <ScrollFade className="my-[1.1em] first:mt-0 last:mb-0">
      <table className="w-max min-w-full border-collapse text-[13.5px]">{children}</table>
    </ScrollFade>
  ),
  th: ({ children }) => (
    <th className="px-3.5 py-2.5 text-left align-top font-semibold text-muted first:pl-0 last:pr-0">
      <Cell>{children}</Cell>
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3.5 py-2.5 align-top first:pl-0 last:pr-0">
      <Cell>{children}</Cell>
    </td>
  ),
  // Obsidian callouts arrive as divs, because the remark pass renamed them; an
  // ordinary div in a note is not a thing markdown can produce, so this only ever
  // sees callouts.
  div: (props) => {
    const type = calloutOf(props)
    if (type === null) return <div>{props.children}</div>
    const tone = calloutTone(type)
    return (
      <aside
        className={`my-[1.1em] rounded-xl border border-l-[3px] px-4 py-3 first:mt-0 last:mb-0 ${TONE_BLOCK[tone]}`}
      >
        {props.children}
      </aside>
    )
  },
  p: (props) => {
    const type = calloutOf(props)
    if (type === null) return <p className="my-[0.9em] first:mt-0 last:mb-0">{props.children}</p>
    const tone = calloutTone(type)
    return (
      <p className={`m-0 flex items-center gap-2 text-[14px] font-semibold ${TONE_TEXT[tone]}`}>
        <Icon icon={calloutIcon(type)} size={15} className="flex-none" />
        <span className="min-w-0">{props.children}</span>
      </p>
    )
  },
}

/** The type behind a callout element, or null for anything that is not one. */
function calloutOf(props: unknown): string | null {
  const value = (props as Record<string, unknown>)['data-callout']
  return typeof value === 'string' && value !== '' ? value : null
}

const TONE_BLOCK: Record<CalloutTone, string> = {
  neutral: 'border-line border-l-dim bg-surface',
  good: 'border-line border-l-ok bg-[color-mix(in_srgb,var(--color-ok)_7%,transparent)]',
  warn: 'border-line border-l-warn bg-[color-mix(in_srgb,var(--color-warn)_7%,transparent)]',
  bad: 'border-line border-l-danger bg-[color-mix(in_srgb,var(--color-danger)_7%,transparent)]',
}

const TONE_TEXT: Record<CalloutTone, string> = {
  neutral: 'text-text',
  good: 'text-ok',
  warn: 'text-warn',
  bad: 'text-danger',
}

/** One glyph per family, not per synonym: twenty words mean about eight things. */
function calloutIcon(type: string) {
  switch (type.toLowerCase()) {
    case 'abstract':
    case 'summary':
    case 'tldr':
    case 'example':
      return BookOpen01Icon
    case 'tip':
    case 'hint':
    case 'important':
      return Idea01Icon
    case 'success':
    case 'check':
    case 'done':
    case 'todo':
      return CheckmarkCircle02Icon
    case 'question':
    case 'help':
    case 'faq':
      return HelpCircleIcon
    case 'warning':
    case 'caution':
    case 'attention':
      return Alert01Icon
    case 'failure':
    case 'fail':
    case 'missing':
    case 'danger':
    case 'error':
    case 'bug':
      return Alert02Icon
    case 'quote':
    case 'cite':
      return QuoteDownIcon
    case 'info':
      return InformationCircleIcon
    default:
      return Note01Icon
  }
}

const isTask = (className: string | undefined) => className?.includes('task-list-item') === true

/**
 * A document read in a side panel: the same blocks as a note, set for a 13px body
 * (`text-label`). The heading ladder keeps the document's order of size, colour and
 * case at about two thirds of its scale, so a note's H1 stays a heading without
 * shouting over a column four hundred pixels wide.
 */
const panel: Components = {
  ...document,
  h1: ({ children }) => (
    <h2 className="mt-6 mb-2 text-[16px] leading-snug font-medium tracking-[-0.01em] text-text first:mt-0">
      {children}
    </h2>
  ),
  h2: ({ children }) => <h3 className="mt-5 mb-1.5 text-[14px] leading-snug font-medium text-text first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 mb-1 text-label font-medium text-text first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-4 mb-1 text-label font-medium text-muted first:mt-0">{children}</h5>,
  h5: ({ children }) => (
    <h6 className="mt-4 mb-1 text-meta font-medium tracking-[0.02em] text-muted uppercase first:mt-0">{children}</h6>
  ),
  h6: ({ children }) => (
    <h6 className="mt-4 mb-1 text-meta font-medium tracking-[0.02em] text-dim uppercase first:mt-0">{children}</h6>
  ),
  ul: ({ children }) => (
    <ul className="my-[0.75em] list-disc space-y-1 pl-5 first:mt-0 last:mb-0 marker:text-dim">{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="my-[0.75em] list-decimal space-y-1 pl-5 first:mt-0 last:mb-0 marker:text-dim">
      {children}
    </ol>
  ),
  hr: () => <hr className="my-5 border-0 border-t border-line" />,
  pre: withDiagrams(({ children }) => (
    <pre className="my-[0.9em] whitespace-pre-wrap rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-meta leading-[1.6] [overflow-wrap:anywhere] first:mt-0 last:mb-0 [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:whitespace-pre-wrap">
      {children}
    </pre>
  )),
  table: ({ children }) => (
    <ScrollFade className="my-[0.9em] first:mt-0 last:mb-0">
      <table className="w-max min-w-full border-collapse text-meta">{children}</table>
    </ScrollFade>
  ),
  p: (props) => {
    const type = calloutOf(props)
    if (type === null) return <p className="my-[0.75em] first:mt-0 last:mb-0">{props.children}</p>
    const tone = calloutTone(type)
    return (
      <p className={`m-0 flex items-center gap-2 text-label font-medium ${TONE_TEXT[tone]}`}>
        <Icon icon={calloutIcon(type)} size={14} className="flex-none" />
        <span className="min-w-0">{props.children}</span>
      </p>
    )
  },
}

const variants = { chat, document, panel }

/**
 * A bullet list written flush under a numbered item is two lists to the parser and
 * one to whoever wrote it. Indent it by exactly what a properly nested list would
 * get, so it reads as belonging to the step above without rewriting the text the
 * agent actually sent.
 */
const CONTINUATION: Record<keyof typeof variants, string> = {
  chat: '[&>ol+ul]:ml-5',
  document: '[&>ol+ul]:ml-6',
  panel: '[&>ol+ul]:ml-5',
}

interface MarkdownProps {
  text: string
  /** How the text is read, which is the only thing that changes between the two. */
  variant?: keyof typeof variants
  /**
   * The seam a vault note needs: its `[[wikilinks]]` are its own vocabulary, not
   * markdown's, so the plugin and the renderer that opens one are passed in rather
   * than taught here. Memoise both, or this component re-parses on every keystroke
   * of whatever is above it.
   */
  plugins?: RemarkPlugins
  components?: Components
  /**
   * Only for text still arriving. Every word becomes an element so the ones that
   * just landed can settle in, which costs a few hundred elements per message and
   * is why a finished reply never asks for it.
   */
  reveal?: boolean
  /** Custom plugins opt in only when they operate independently on each block. */
  stableBlocks?: boolean
  /**
   * Whether web links read as sources (pills inline, site icons on a Sources list).
   * On for a reply, off for a note and for what the user wrote themself.
   */
  sources?: boolean
}

/** Renders one agent reply, or one note. Memoised: the live turn repaints per delta. */
export const Markdown = memo(function Markdown({
  text,
  variant = 'chat',
  plugins,
  components,
  reveal = false,
  stableBlocks = plugins === undefined,
  sources = variant === 'chat',
}: MarkdownProps) {
  const remarkPlugins = useMemo(() => plugins === undefined ? BASE_PLUGINS : [GFM, ...plugins], [plugins])
  const merged = useMemo(() => components === undefined ? variants[variant] : { ...variants[variant], ...components }, [variant, components])
  const collector = useRef(new StreamingMarkdown())
  const blocks = reveal && stableBlocks ? collector.current.update(text) : [text]
  const nested = reveal && stableBlocks ? collector.current.nestedTail : undefined
  return (
    <div className={`[overflow-wrap:anywhere] ${CONTINUATION[variant]}`}>
      <CitesSources.Provider value={sources}>
        {blocks.map((block, index) => index === blocks.length - 1 && nested !== undefined
          ? <NestedTail key={index} tail={nested} plugins={remarkPlugins} components={merged} />
          : <MarkdownBlock key={index} text={block} reveal={reveal} open={reveal && index === blocks.length - 1} plugins={remarkPlugins} components={merged} />)}
      </CitesSources.Provider>
    </div>
  )
})

const justChildren = ({ children }: { children?: ReactNode }) => <>{children}</>
const noChildren = () => null

function NestedTail({ tail, plugins, components }: { tail: StreamingTail; plugins: RemarkPlugins; components: Components }) {
  const listComponents = useMemo<Components>(() => ({ ...components, ul: justChildren, ol: justChildren }), [components])
  const headerComponents = useMemo<Components>(() => ({ ...components, table: justChildren, thead: justChildren, tbody: noChildren }), [components])
  const rowComponents = useMemo<Components>(() => ({ ...components, table: justChildren, thead: noChildren, tbody: justChildren }), [components])
  if (tail.kind === 'list') {
    const List: ElementType = tail.ordered ? components.ol ?? 'ol' : components.ul ?? 'ul'
    return createElement(List, tail.ordered && tail.start !== 1 ? { start: tail.start } : {}, tail.items.map((item, index) =>
      <MarkdownBlock key={index} text={item} reveal open plugins={plugins} components={listComponents} />))
  }
  if (tail.kind === 'table') {
    const Table = components.table ?? 'table'
    const Head = components.thead ?? 'thead'
    const Body = components.tbody ?? 'tbody'
    return createElement(Table, {},
      createElement(Head, {}, <MarkdownBlock text={tail.header} reveal open plugins={plugins} components={headerComponents} />),
      tail.rows.length === 0 ? null : createElement(Body, {}, tail.rows.map((row, index) =>
        <MarkdownBlock key={index} text={`${tail.header}${row}`} reveal open plugins={plugins} components={rowComponents} />)),
    )
  }
  const Pre = components.pre ?? 'pre'
  const Code = components.code ?? 'code'
  const lines = (tail.value ? `${tail.value}\n` : '').match(/[^\n]*\n|[^\n]+$/g) ?? []
  return createElement(Pre, {}, createElement(Code,
    tail.language ? { className: `language-${tail.language}` } : {},
    lines.map((line, index) => <CodeLine key={index} text={line} />),
  ))
}

const CodeLine = memo(function CodeLine({ text }: { text: string }) {
  return <span>{text}</span>
})

const MarkdownBlock = memo(function MarkdownBlock({ text, reveal, open = false, plugins, components }: {
  text: string
  reveal: boolean
  open?: boolean
  plugins: RemarkPlugins
  components: Components
}) {
  // How much of this reply has already had its turn at settling in. Taking the
  // mark away from a word mid-animation cancels it and snaps the word to solid, so
  // the boundary may only move past a delta whose words have certainly finished.
  //
  // Each delta is recorded by where it *ends*, which is the correction that makes
  // this work at all: holding onto where a batch began meant the boundary was
  // always handed back its own current value and never moved.
  const boundary = useRef(0)
  const batches = useRef<{ to: number; at: number }[]>([])
  const from = boundary.current
  const counted: RevealCount = { words: 0 }
  useEffect(() => {
    if (!reveal) return
    const now = performance.now()
    const all = [...batches.current, { to: counted.words, at: now }]
    const done = all.filter((batch) => now - batch.at >= REVEAL_MS)
    batches.current = all.filter((batch) => now - batch.at < REVEAL_MS)
    // The newest batch that has finished is as far as the boundary may go. No timer
    // chases the last one: a stream that stops leaves its final words marked, and
    // the mark on a finished animation costs nothing until something re-renders, by
    // which time the turn has settled and the reply is drawn without any of this.
    const last = done.at(-1)
    if (last !== undefined) boundary.current = last.to
  })
  return (
    <OpenBlock.Provider value={open}>
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={reveal ? [rehypeRevealWords(from, counted)] : undefined}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </OpenBlock.Provider>
  )
})

/**
 * GFM without single-tilde strikethrough: a path like `com~apple~CloudDocs` is not
 * markup, and `~~double~~` still strikes.
 */
const GFM: RemarkPlugins[number] = [remarkGfm, { singleTilde: false }]
/** react-markdown's own URL policy, plus a raster data URL as a picture's source. */
const urlTransform: UrlTransform = (url, key, node) =>
  key === 'src' && node.tagName === 'img' && url.startsWith('data:') && markdownImageSource(url) === url ? url : defaultUrlTransform(url)
const BASE_PLUGINS: RemarkPlugins = [GFM]
/** The reveal animation's own duration, stated in `styles.css`. */
const REVEAL_MS = 220
