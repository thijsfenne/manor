import { CheckmarkSquare02Icon, Globe02Icon, SquareIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { faviconSource, imageRefSpans, markdownImageSource, mentionSpans, quoteExcerpt, quoteRefSpans, webLinkOrigin, type AgentConfig, type InlineQuote } from '@manor/contracts'
import { personaOf } from '@manor/client-runtime/state'
import { readWikilink } from '@manor/client-runtime/vault-notes'
import { Image } from 'expo-image'
import { createContext, Fragment, memo, useContext, useState, type ReactNode } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type TextStyle, type ViewStyle } from 'react-native'

import { ImageViewer } from '@/components/Attachments'
import { useBubbleTint } from '@/components/bubbleTint'
import { imageParts } from '@/components/markdownImageParts'
import { sourceItemHref } from '@/components/sourceLinks'
import { Text } from '@/components/Text'
import { serverMediaUri } from '@/lib/config'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/** A vault's `[[wikilinks]]`: which note a name means, and how to open the one it found. */
export interface NoteLinks {
  resolve: (target: string) => string | null
  open: (path: string) => void
}

/** A chat's current repo listing: resolve a written path, then open it in Files. */
export interface RepoLinks {
  resolve: (href: string) => string | null
  open: (path: string) => void
}

/**
 * What a link in this text can reach. Without it every link is inert text, which is
 * what a chat reply's `[[brackets]]` and `../paths` are: nothing there knows what
 * they would point at.
 */
export interface MarkdownLinks {
  /** Follows a path relative to the file this text came from. */
  relative?: (href: string) => void
  notes?: NoteLinks
  repo?: RepoLinks
}

/**
 * What a persona said, rendered the way the Mac renders it and no further: headings,
 * bold, italic, code, links, lists, task boxes, quotes, fenced code and tables. Raw
 * HTML never renders: agent output is untrusted text. Resolved persona mentions read
 * as chips; destination pills belong to the user's sent bubble, not agent prose.
 */
export const Markdown = memo(function Markdown({
  text,
  agents,
  links,
  sent,
  small = false,
  sources = sent === undefined,
}: {
  text: string
  agents: readonly AgentConfig[]
  links?: MarkdownLinks
  /** Only for a message the user wrote: their routing pills, and the long press that quotes it. */
  sent?: SentMessage
  /** A step below the reading size, for a card that should not outweigh the messages (a kickoff). */
  small?: boolean
  /**
   * Whether web links read as sources (pills inline, site icons on a Sources list), as on
   * the Mac. On for a reply, off for a note and for what the user wrote themselves.
   */
  sources?: boolean
}) {
  const blocks = parseBlocks(text)
  return (
    <SentContext.Provider value={sent}>
      <CitesSources.Provider value={sources}>
        <View style={styles.body}>
          {blocks.map((block, index) => <Block agents={agents} block={block} key={index} links={links} small={small} />)}
        </View>
      </CitesSources.Provider>
    </SentContext.Provider>
  )
})

/**
 * What changes when the text is his own. The destination handles he picked read as
 * pills, as they did before the bubble learned markdown, and every line answers the
 * long press that quotes the message. The ink comes from the bubble's tint, read
 * where each line is drawn.
 */
export interface SentMessage {
  onLongPress?: () => void
  accessibilityHint?: string
  /** The message's own pictures, which its `[Image #n]` references open by index. */
  imageCount?: number
  onOpenImage?: (index: number) => void
  /** What its `[Quote #n]` references stand for: each is drawn as a pill with the opening words. */
  quotes?: readonly InlineQuote[]
  onOpenQuote?: (index: number) => void
}

/** A reference in a sent message's text: a picture or a quote it carries, by number. */
interface SentRef {
  kind: 'image' | 'quote'
  start: number
  end: number
  number: number
}

/** The `[Image #n]` and `[Quote #n]` references in `text` that name something the message carries. */
function sentRefs(text: string, message: SentMessage | undefined): SentRef[] {
  if (message === undefined) return []
  return [
    ...imageRefSpans(text, message.imageCount ?? 0).map((span): SentRef => ({ ...span, kind: 'image' })),
    ...quoteRefSpans(text, message.quotes?.length ?? 0).map((span): SentRef => ({ ...span, kind: 'quote' })),
  ].sort((a, b) => a.start - b.start)
}

const SentContext = createContext<SentMessage | undefined>(undefined)

/**
 * Props every top-level line of a sent message carries: the bubble's ink and its long
 * press, and the wash a block surface (a code fence) sits on so the ink stays legible.
 */
function useLineProps(): {
  ink: TextStyle | undefined
  wash: ViewStyle | undefined
  press: { onLongPress?: () => void; accessibilityHint?: string }
} {
  const sent = useContext(SentContext)
  const tint = useBubbleTint()
  return {
    ink: tint === undefined ? undefined : { color: tint.ink },
    wash: tint === undefined ? undefined : { backgroundColor: tint.wash },
    press: sent === undefined ? {} : {
      ...(sent.onLongPress === undefined ? {} : { onLongPress: sent.onLongPress }),
      ...(sent.accessibilityHint === undefined ? {} : { accessibilityHint: sent.accessibilityHint }),
    },
  }
}

type MdBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: MdItem[] }
  | { kind: 'table'; header: string[]; align: MdAlign[]; rows: string[][] }
  | { kind: 'rule' }

/** `done` separates a task from a plain item: undefined is a bullet, a boolean is a box. */
interface MdItem {
  text: string
  depth: number
  done?: boolean
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const TASK = /^\[([ xX])\]\s+/

/**
 * Where a table begins: a row of cells with its divider under it. The divider is what
 * makes it a table rather than a line with pipes in it, so both lines are read before
 * the first is claimed, and a `---` divider carries pipes so it never reads as a rule.
 */
function tableStartsAt(lines: string[], index: number): boolean {
  const header = lines[index] ?? ''
  const divider = lines[index + 1] ?? ''
  if (!header.includes('|') || !divider.includes('|')) return false
  const cells = splitRow(divider)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

type MdAlign = 'left' | 'center' | 'right'

/** Which side a column hangs from, read off the colons in its divider cell. */
function alignOf(cell: string): MdAlign {
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
  if (cell.endsWith(':')) return 'right'
  return 'left'
}

/** The cells of one row, without the optional outer pipes. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function parseBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }
    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? '```'
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' })
      index += 1
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s{0,3}>/.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s{0,3}>\s?/, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }
    if (tableStartsAt(lines, index)) {
      const header = splitRow(line)
      const divider = splitRow(lines[index + 1] ?? '')
      const align = header.map((_, column) => alignOf(divider[column] ?? ''))
      index += 2
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        const cells = splitRow(lines[index] ?? '')
        // Squared off against the header: a short row gets empty cells, a long one is
        // cut, so every column has exactly as many cells as there are rows.
        rows.push(Array.from({ length: header.length }, (_, column) => cells[column] ?? ''))
        index += 1
      }
      blocks.push({ kind: 'table', header, align, rows })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      const ordered = /\d/.test(item[2] ?? '')
      const start = ordered ? Number.parseInt(item[2] ?? '1', 10) || 1 : 1
      const items: MdItem[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const match = LIST_ITEM.exec(current)
        if (match !== null && /\d/.test(match[2] ?? '') === ordered) {
          const text = match[3] ?? ''
          const task = TASK.exec(text)
          items.push({
            text: task === null ? text : text.slice(task[0].length),
            depth: Math.min(3, Math.floor((match[1] ?? '').length / 2)),
            ...(task === null ? {} : { done: task[1] !== ' ' }),
          })
          index += 1
          continue
        }
        // A wrapped continuation line belongs to the item above it.
        const last = items.at(-1)
        if (last !== undefined && current.trim() !== '' && /^\s+/.test(current) && match === null) {
          last.text += ` ${current.trim()}`
          index += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered, start, items })
      continue
    }
    const body: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '' || /^\s*(`{3,}|~{3,})/.test(current) || /^\s{0,3}#{1,6}\s/.test(current) || /^\s{0,3}>/.test(current) || LIST_ITEM.test(current) || tableStartsAt(lines, index)) break
      body.push(current.trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: body.join('\n') })
  }
  return blocks
}

function Block({
  block,
  agents,
  links,
  small,
}: {
  block: MdBlock
  agents: readonly AgentConfig[]
  links?: MarkdownLinks
  small: boolean
}) {
  const { ink, press, wash } = useLineProps()
  const cites = useContext(CitesSources)
  const size = small ? SMALL.body : undefined
  switch (block.kind) {
    case 'paragraph': {
      const parts = imageParts(block.text)
      if (parts === undefined) return <Text {...press} selectable style={[styles.paragraph, size, ink]}><Inline agents={agents} links={links} text={block.text} /></Text>
      // A picture cannot sit inside a line of text here, so the paragraph breaks around it.
      return (
        <View style={styles.imageParagraph}>
          {parts.map((part, index) => part.kind === 'text'
            ? <Text {...press} key={index} selectable style={[styles.paragraph, size, ink]}><Inline agents={agents} links={links} text={part.text} /></Text>
            : <MarkdownImage alt={part.alt} href={part.href} key={index} src={part.src} />)}
        </View>
      )
    }
    case 'heading':
      return (
        <Text {...press} selectable style={[styles.paragraph, styles.heading, headingRank(block.level, small), ink]}>
          <Inline agents={agents} links={links} text={block.text} />
        </Text>
      )
    case 'rule':
      return <View style={styles.rule} />
    case 'quote':
      return (
        <View style={styles.quote}>
          <Text {...press} selectable style={[styles.paragraph, size, styles.quoteText, ink]}><Inline agents={agents} links={links} text={block.text} /></Text>
        </View>
      )
    case 'code':
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.codeBlock, wash]} contentContainerStyle={styles.codeInner}>
          <Text {...press} selectable style={[styles.code, ink]}>{block.text}</Text>
        </ScrollView>
      )
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => {
            // A bullet item that is only a web link is a source: its site's icon takes
            // the bullet's place and the link stays a plain link, as on the Mac.
            const source = !cites || block.ordered || item.done !== undefined ? undefined : sourceItemHref(item.text)
            return (
              <View key={index} style={[styles.item, { paddingLeft: item.depth * 18 }]}>
                {source !== undefined ? (
                  <View style={styles.sourceMark}>
                    <Favicon href={source} key={source} size={16} />
                  </View>
                ) : item.done === undefined ? (
                  <Text style={[styles.marker, size, ink]}>{block.ordered ? `${block.start + index}.` : '•'}</Text>
                ) : (
                  // A box where the bullet would be, never both, and it is drawn rather
                  // than pressed: ticking one is a write, and the phone reads the note.
                  <View style={styles.box}>
                    <HugeiconsIcon
                      color={item.done ? colors.ok : colors.dim}
                      icon={item.done ? CheckmarkSquare02Icon : SquareIcon}
                      size={16}
                      strokeWidth={1.8}
                    />
                  </View>
                )}
                <PlainLinks.Provider value={source !== undefined}>
                  <Text {...press} selectable style={[styles.paragraph, size, styles.itemText, ink]}><Inline agents={agents} links={links} text={item.text} /></Text>
                </PlainLinks.Provider>
              </View>
            )
          })}
        </View>
      )
    // Columns rather than rows, so each one is as wide as its own widest cell without a
    // measuring pass, and every cell keeps to a single line so the rows stay level
    // across them. Narrower than the chat column it fills it, wider than it it scrolls
    // sideways, the way the Mac's `min-w-full` table does; the percentage only resolves
    // against the viewport from the content container, never from a child of it.
    case 'table':
      return (
        <ScrollView contentContainerStyle={styles.table} horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
          {block.header.map((title, column) => {
            const side = { textAlign: block.align[column] ?? 'left' } as const
            return (
              <View key={column} style={styles.column}>
                <Text {...press} numberOfLines={1} selectable style={[styles.cell, styles.headCell, side, ink]}>
                  <Inline agents={agents} links={links} text={title} />
                </Text>
                {block.rows.map((row, index) => (
                  <Text {...press} key={index} numberOfLines={1} selectable style={[styles.cell, side, ink]}>
                    <Inline agents={agents} links={links} text={row[column] ?? ''} />
                  </Text>
                ))}
              </View>
            )
          })}
        </ScrollView>
      )
  }
}

/**
 * How far a heading sits above the reading size. Rank 3 and 4 share a step, and the
 * last two fall below the body in the muted colour rather than climbing further: six
 * ranks cannot be told apart by a point of size each, and a chat rarely goes past two.
 */
function headingRank(level: number, small: boolean): TextStyle {
  const steps = small ? SMALL : styles
  if (level <= 1) return steps.h1
  if (level === 2) return steps.h2
  if (level <= 4) return steps.h3
  return styles.h5
}

/**
 * The last two alternatives are a picture inside a link and a picture. A plain link may
 * not start with `![`, or it would claim a linked picture's inner brackets as its label.
 * Where a paragraph shows its pictures as blocks (`imageParts`), these only meet a picture
 * in a list, quote or table, and draw it as a link with its alt text, never a bare `!`.
 */
const INLINE =
  /(\*\*(.+?)\*\*|__(.+?)__|`([^`\n]+)`|\[(?!!\[)([^\]\n]+)\]\(([^)\s]+)\)|~~(.+?)~~|(?<![\p{L}\p{N}*])\*(?!\s)(.+?)(?<!\s)\*(?![\p{L}\p{N}])|(?<![\p{L}\p{N}_])_(?!\s)(.+?)(?<!\s)_(?![\p{L}\p{N}])|(https?:\/\/[^\s<>)]+)|\[\[([^[\]\n]+?)\]\]|\[!\[([^\]\n]*)\]\(((?:[^\s()]|\([^\s()]*\))+)\)\]\(((?:[^\s()]|\([^\s()]*\))+)\)|!\[([^\]\n]*)\]\(((?:[^\s()]|\([^\s()]*\))+)\))/gu
/** The schemes a tap may hand to the system; anything else stays inert text. */
const EXTERNAL_LINK = /^(https?:\/\/|mailto:|tel:|sms:)/i
/** The tallest a picture in a message may stand, and the room it holds while it loads. */
const IMAGE_CAP = 280
const IMAGE_LOADING_WIDTH = 360
/** The page's side padding plus a sent bubble's own, both sides. */
const IMAGE_INSET = 2 * spacing.lg + 2 * (spacing.md + 2)

/**
 * A picture written into a message. A remote one comes through the Mac, which fetches it
 * for the phone. While it loads it holds the cap's height, so a photo lands without moving
 * the text under it; a press opens the viewer, or follows the link the picture sits in.
 * One that cannot be shown reads as a link with its alt text.
 */
function MarkdownImage({ alt, src, href: link }: { alt: string; src: string; href?: string }) {
  const href = link !== undefined && EXTERNAL_LINK.test(link) ? link : undefined
  const [failed, setFailed] = useState(false)
  const [natural, setNatural] = useState<{ width: number; height: number }>()
  const [open, setOpen] = useState(false)
  const screen = useWindowDimensions()
  const linkStyle = useLinkStyle()
  const { ink } = useLineProps()
  const source = markdownImageSource(src)
  const uri = source === undefined ? undefined : source.startsWith('data:') ? source : serverMediaUri(source)
  if (uri === undefined || failed) {
    const target = href ?? (/^https?:\/\//i.test(src) ? src : undefined)
    const label = alt === '' ? target ?? '' : alt
    if (label === '') return null
    return target === undefined
      ? <Text style={[styles.paragraph, ink]}>{label}</Text>
      : <Text accessibilityRole="link" onPress={() => void Linking.openURL(target)} style={[styles.paragraph, linkStyle]}>{label}</Text>
  }
  // Sized from the picture and the window rather than from the parent: a sent bubble is
  // only as wide as its content, so its width says nothing until the picture claims one.
  // The window budget is what fits inside the narrowest bubble, a sent one.
  const widest = screen.width * 0.86 - IMAGE_INSET
  const frame = natural === undefined
    ? { width: Math.min(IMAGE_LOADING_WIDTH, widest), height: IMAGE_CAP }
    : (() => {
        const scale = Math.min(1, IMAGE_CAP / natural.height, widest / natural.width)
        return { width: natural.width * scale, height: natural.height * scale }
      })()
  return (
    <View style={styles.imageRoom}>
      <Pressable
        accessibilityHint={href === undefined ? 'Opens the image' : 'Opens the link'}
        accessibilityLabel={alt === '' ? 'Image' : alt}
        accessibilityRole={href === undefined ? 'imagebutton' : 'link'}
        onPress={() => (href === undefined ? setOpen(true) : void Linking.openURL(href))}
        style={({ pressed }) => [styles.image, frame, pressed && styles.imagePressed]}
      >
        <Image
          accessibilityIgnoresInvertColors
          contentFit="contain"
          onError={() => setFailed(true)}
          onLoad={({ source: { width, height } }) => {
            if (width > 0 && height > 0) setNatural({ width, height })
          }}
          source={{ uri }}
          style={StyleSheet.absoluteFill}
        />
      </Pressable>
      {open ? <ImageViewer images={[{ name: alt === '' ? 'Image' : alt, src: uri }]} initialIndex={0} onClose={() => setOpen(false)} /> : null}
    </View>
  )
}

/** False for text that cites nothing: a note, or a message the user wrote. Its links stay links. */
const CitesSources = createContext(true)
/** True inside a Sources list item, whose link stays a plain link beside its site's icon. */
const PlainLinks = createContext(false)

/**
 * A site's icon, fetched by the Mac so no third party is asked. It holds its square while
 * loading, and a site without one shows a neutral globe instead of a broken picture.
 */
function Favicon({ href, size }: { href: string; size: number }) {
  const [failed, setFailed] = useState(false)
  const source = faviconSource(href)
  const uri = source === undefined ? undefined : serverMediaUri(source)
  const box = { width: size, height: size }
  if (uri === undefined || failed) return <HugeiconsIcon color={colors.dim} icon={Globe02Icon} size={size} strokeWidth={1.8} />
  return <Image accessibilityIgnoresInvertColors contentFit="contain" onError={() => setFailed(true)} source={{ uri }} style={[box, styles.favicon]} />
}

/**
 * A cited page inside a sentence: the site's icon, then the label, on a rounded wash.
 * It is an inline view rather than styled text: nested text paints its background as a
 * square block per line and breaks it mid-label. One line only; a long title ends in an
 * ellipsis and keeps its whole label for VoiceOver.
 */
function SourcePill({ href, label, onPress }: { href: string; label: string; onPress: () => void }) {
  const tint = useBubbleTint()
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.sourcePill, tint === undefined ? undefined : { backgroundColor: tint.wash }, pressed && styles.sourcePillPressed]}
    >
      <Favicon href={href} key={href} size={12} />
      <Text numberOfLines={1} style={[styles.sourcePillText, tint === undefined ? undefined : { color: tint.ink }]}>{label}</Text>
    </Pressable>
  )
}

/** A link's colour, taking a tinted bubble's ink the way every other link in it does. */
function useLinkStyle(): TextStyle[] {
  const tint = useBubbleTint()
  return tint === undefined ? [styles.link] : [styles.link, { color: tint.ink }]
}

/** Emphasis, code, links, wikilinks and mentions inside one run of text, nested one level. */
function Inline({
  text,
  agents,
  style,
  links,
}: {
  text: string
  agents: readonly AgentConfig[]
  style?: TextStyle
  links?: MarkdownLinks
}): ReactNode {
  // In a tinted bubble code and links take its ink and wash, as its chips do; their
  // page colours sat on the fill at whatever contrast they happened to get.
  const tint = useBubbleTint()
  const codeStyle = tint === undefined ? styles.inlineCode : [styles.inlineCode, { color: tint.ink, backgroundColor: tint.wash }]
  const linkStyle = tint === undefined ? styles.link : [styles.link, { color: tint.ink }]
  const message = useContext(SentContext)
  const cites = useContext(CitesSources)
  const plainLinks = useContext(PlainLinks) || !cites
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) out.push(<Mentions agents={agents} key={`t${last}`} text={text.slice(last, at)} />)
    const key = `m${at}`
    // His picture reference right before `(detail)` is still the reference, not a link
    // label; what follows it is read again as ordinary inline text.
    const reference = match[5] === undefined ? '' : `[${match[5]}]`
    if (reference !== '' && sentRefs(reference, message)[0]?.end === reference.length) {
      out.push(<Mentions agents={agents} key={key} text={reference} />)
      out.push(<Inline agents={agents} key={`r${at}`} links={links} {...(style === undefined ? {} : { style })} text={text.slice(at + reference.length)} />)
      last = text.length
      break
    }
    if (match[2] !== undefined || match[3] !== undefined) {
      out.push(<Text key={key} style={[styles.bold, style]}><Inline agents={agents} links={links} text={match[2] ?? match[3] ?? ''} /></Text>)
    } else if (match[4] !== undefined) {
      out.push(<Text key={key} style={codeStyle}>{match[4]}</Text>)
    } else if (match[5] !== undefined && match[6] !== undefined) {
      const href = match[6]
      const external = EXTERNAL_LINK.test(href)
      const relative = !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('?') && !/^[a-z][a-z\d+.-]*:/i.test(href)
      const follow = links?.relative
      const repo = links?.repo
      const repoPath = repo?.resolve(href) ?? null
      const open = repoPath !== null && repo !== undefined
        ? () => repo.open(repoPath)
        : external
        ? () => void Linking.openURL(href)
        : relative && follow !== undefined
          ? () => follow(href)
          : undefined
      // A local destination the current repo does not hold is still authored as a
      // labelled link. Show that compact label, never its machine-specific path.
      out.push(open === undefined
        ? <Fragment key={key}>{match[5]}</Fragment>
        : repoPath === null && !plainLinks && webLinkOrigin(href) !== undefined
          ? <SourcePill href={href} key={key} label={match[5]} onPress={open} />
          : <Text accessibilityRole="link" key={key} onPress={open} style={linkStyle}>{match[5]}</Text>)
    } else if (match[7] !== undefined) {
      out.push(<Text key={key} style={styles.strike}><Inline agents={agents} links={links} text={match[7]} /></Text>)
    } else if (match[8] !== undefined || match[9] !== undefined) {
      out.push(<Text key={key} style={styles.italic}><Inline agents={agents} links={links} text={match[8] ?? match[9] ?? ''} /></Text>)
    } else if (match[10] !== undefined) {
      // Punctuation right after a bare address closes the sentence, not the address, as on the Mac.
      const url = match[10].replace(/[.,:;!?*_~]+$/, '')
      out.push(!plainLinks && webLinkOrigin(url) !== undefined
        ? <SourcePill href={url} key={key} label={url} onPress={() => void Linking.openURL(url)} />
        : <Text accessibilityRole="link" key={key} onPress={() => void Linking.openURL(url)} style={linkStyle}>{url}</Text>)
      if (url.length < match[10].length) out.push(<Fragment key={`${key}p`}>{match[10].slice(url.length)}</Fragment>)
    } else if (match[12] !== undefined || match[15] !== undefined) {
      const linked = match[12] !== undefined
      const alt = (linked ? match[12] : match[15]) ?? ''
      const src = (linked ? match[13] : match[16]) ?? ''
      const target = linked ? (EXTERNAL_LINK.test(match[14] ?? '') ? match[14] : undefined) : /^https?:\/\//i.test(src) ? src : undefined
      const label = alt === '' ? target ?? '' : alt
      out.push(target === undefined
        ? <Fragment key={key}>{label}</Fragment>
        : <Text accessibilityRole="link" key={key} onPress={() => void Linking.openURL(target)} style={linkStyle}>{label}</Text>)
    } else if (match[11] !== undefined) {
      // A vault note's own link syntax. Outside a vault nothing can resolve it, so the
      // brackets stay the characters they are rather than becoming a label to nowhere.
      // `![[x]]` is Obsidian's embed, not a link, and the phone transcludes nothing.
      const notes = text[at - 1] === '!' ? undefined : links?.notes
      const link = readWikilink(match[11])
      const path = notes === undefined || link === null ? null : notes.resolve(link.target)
      out.push(
        notes === undefined || link === null ? (
          <Fragment key={key}>{match[0]}</Fragment>
        ) : path === null ? (
          // Obsidian's own answer to a link that points at nothing: the label, dimmed
          // and dead, so a rename reads as a broken link instead of as plain prose.
          <Text key={key} style={styles.deadLink}>{link.label}</Text>
        ) : (
          <Text accessibilityRole="link" key={key} onPress={() => notes.open(path)} style={linkStyle}>{link.label}</Text>
        ),
      )
    }
    last = at + match[0].length
  }
  if (last < text.length) out.push(<Mentions agents={agents} key={`t${last}`} text={text.slice(last)} />)
  return <Fragment>{out}</Fragment>
}

/**
 * Plain text with every resolved persona mention drawn as a chip. In a sent message
 * the destination handles he picked are pills too; in agent prose they stay words.
 */
function Mentions({ text, agents }: { text: string; agents: readonly AgentConfig[] }): ReactNode {
  const message = useContext(SentContext)
  const sent = message !== undefined
  const tint = useBubbleTint()
  // His `[Image #n]` and `[Quote #n]` references read as blue pills: an image opens the
  // picture it names, a quote opens the words it holds.
  const refs = sentRefs(text, message)
  if (refs.length > 0) {
    const parts: ReactNode[] = []
    let at = 0
    for (const ref of refs) {
      if (ref.start > at) parts.push(<Mentions agents={agents} key={`t${at}`} text={text.slice(at, ref.start)} />)
      const quote = ref.kind === 'quote' ? message?.quotes?.[ref.number - 1] : undefined
      const open = ref.kind === 'image' ? message?.onOpenImage : message?.onOpenQuote
      parts.push(
        <Text
          accessibilityRole={open === undefined ? undefined : 'button'}
          key={`${ref.kind}${ref.start}`}
          {...(open === undefined ? {} : { onPress: () => open(ref.number - 1) })}
          style={[styles.carriedRef, tint && styles.carriedRefOnTint]}
        >
          {quote === undefined ? `Image #${ref.number}` : quoteExcerpt(quote)}
        </Text>,
      )
      at = ref.end
    }
    if (at < text.length) parts.push(<Mentions agents={agents} key={`t${at}`} text={text.slice(at)} />)
    return <Fragment>{parts}</Fragment>
  }
  const byName = new Map(agents.map((agent) => [agent.name.toLowerCase(), agent]))
  const destination = (handle: string) => sent && (handle === 'browser' || handle === 'work')
  const spans = mentionSpans(text).filter((span) => byName.has(span.handle.toLowerCase()) || destination(span.handle.toLowerCase()))
  if (spans.length === 0) return text
  const out: ReactNode[] = []
  let last = 0
  for (const span of spans) {
    const handle = span.handle.toLowerCase()
    if (span.start > last) out.push(text.slice(last, span.start))
    const agent = byName.get(handle)
    if (agent !== undefined) {
      const persona = personaOf([...agents], agent.id)
      out.push(<Text key={span.start} style={[styles.mention, { color: tint?.ink ?? persona.color }]}>@{agent.name}</Text>)
    } else {
      out.push(<Text key={span.start} style={[styles.destinationMention, tint && { backgroundColor: tint.wash, color: tint.ink }]}>{handle === 'browser' ? 'Browser' : 'Sessions'}</Text>)
    }
    last = span.start + 1 + span.handle.length
  }
  if (last < text.length) out.push(text.slice(last))
  return <Fragment>{out}</Fragment>
}

/** The `small` reading size, two points down with the headings the same steps above it. */
const SMALL = StyleSheet.create({
  body: { fontSize: 15, lineHeight: 22 },
  h1: { fontSize: 19, lineHeight: 25 },
  h2: { fontSize: 17, lineHeight: 23 },
  h3: { fontSize: 16, lineHeight: 22 },
})

const styles = StyleSheet.create({
  body: { gap: spacing.sm },
  paragraph: { color: colors.text, fontFamily: fonts.sans, fontSize: 17, lineHeight: 25 },
  // A heading sat at the body's own 17px, so Medium was the only thing telling the two
  // apart, and with one weight above regular that is not enough. Size carries the rank
  // here as it does on the Mac, at the same steps above the reading size.
  heading: { fontWeight: '500', marginTop: spacing.xs },
  h1: { fontSize: 21, lineHeight: 27 },
  h2: { fontSize: 19, lineHeight: 25 },
  h3: { fontSize: 18, lineHeight: 24 },
  h5: { fontSize: 14, lineHeight: 19, color: colors.muted },
  bold: { fontWeight: '500' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through', color: colors.muted },
  inlineCode: { fontFamily: fonts.mono, fontSize: 14, color: colors.text, backgroundColor: colors.chip, borderRadius: 4, ...squircle },
  link: { color: colors.busy, textDecorationLine: 'underline' },
  deadLink: { color: colors.dim, textDecorationLine: 'underline' },
  mention: { fontWeight: '500' },
  // A picture or quote the message carries, blue as on desktop. Like the pills
  // around it, the radius only shows where the platform draws one on a nested run.
  carriedRef: { overflow: 'hidden', borderRadius: radius.round, backgroundColor: colors.busyWash, color: colors.busy, fontWeight: '500', paddingHorizontal: 5, paddingVertical: 1 },
  // Blue ink on a face's colour has no contrast promise, so on a tinted bubble the blue is the fill.
  carriedRefOnTint: { backgroundColor: colors.busy, color: colors.onPrimary },
  destinationMention: { overflow: 'hidden', borderRadius: radius.round, backgroundColor: colors.chip, color: colors.text, fontWeight: '500', paddingHorizontal: 5, paddingVertical: 1 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: spacing.xs },
  imageParagraph: { gap: spacing.sm },
  imageRoom: { alignItems: 'flex-start' },
  image: { backgroundColor: colors.surface2, borderRadius: radius.md, ...squircle, overflow: 'hidden' },
  imagePressed: { opacity: 0.82 },
  quote: { borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: spacing.md },
  quoteText: { color: colors.muted },
  codeBlock: { borderRadius: radius.md, ...squircle, backgroundColor: colors.surface },
  codeInner: { padding: spacing.md },
  code: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 19, color: colors.text },
  list: { gap: 4 },
  item: { flexDirection: 'row', gap: spacing.sm },
  marker: { width: 18, color: colors.muted, fontFamily: fonts.sans, fontSize: 17, lineHeight: 25, textAlign: 'right' },
  box: { width: 18, alignItems: 'flex-end', paddingTop: 4 },
  sourceMark: { width: 18, alignItems: 'flex-end', paddingTop: 5 },
  favicon: { borderRadius: radius.xs },
  // An inline view rests its bottom on the baseline; the nudge centres it on the type.
  // Shorter than the paragraph's fixed line height, so a pill never pushes lines apart.
  sourcePill: {
    flexDirection: 'row', alignItems: 'center', gap: 4, height: 19, maxWidth: 220, paddingHorizontal: 7,
    borderRadius: radius.round, backgroundColor: colors.chip, transform: [{ translateY: 2 }],
  },
  sourcePillPressed: { opacity: 0.6 },
  sourcePillText: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 17 },
  // Shrink, never `flex: 1`: a sent bubble sizes to its content, and a zero flex basis
  // left the item out of that size, so the bubble ended before its list did.
  itemText: { flexShrink: 1 },
  tableScroll: { flexGrow: 0 },
  table: { minWidth: '100%', flexDirection: 'row' },
  // Spare width is shared out rather than left over, so the rules run to the edge like a
  // table and not like a stack of labels. The cap sits on the column so a cell's own
  // border still spans it; one long cell may not make a column the width of the screen.
  column: { flexGrow: 1, flexShrink: 0, maxWidth: 220 },
  cell: {
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 6,
    paddingRight: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  // The header carries the only full-weight rule in the table, which is what separates a
  // table from a stack of rows; between the rows a hairline is enough.
  headCell: { color: colors.muted, fontWeight: '500', borderBottomWidth: 1, borderBottomColor: colors.line },
})
