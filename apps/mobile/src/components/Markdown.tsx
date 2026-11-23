import CheckmarkSquare02Icon from '@hugeicons/core-free-icons/CheckmarkSquare02Icon'
import BoxIcon from '@hugeicons/core-free-icons/BoxIcon'
import File01Icon from '@hugeicons/core-free-icons/File01Icon'
import Globe02Icon from '@hugeicons/core-free-icons/Globe02Icon'
import SquareIcon from '@hugeicons/core-free-icons/SquareIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { faviconSource, imageRefSpans, markdownImageSource, mentionSpans, quoteExcerpt, quoteRefSpans, VAULT_IMAGE_PATH, webLinkOrigin, type AgentConfig, type InlineQuote, type SkillConfig } from '@manor/contracts'
import { personaOf } from '@manor/client-runtime/state'
import { readWikilink } from '@manor/client-runtime/vault-notes'
import MaskedView from '@react-native-masked-view/masked-view'
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import { createContext, Fragment, memo, useContext, useRef, useState, type ReactNode } from 'react'
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler'
import { Linking, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type TextStyle, type ViewStyle } from 'react-native'

import { ImageViewer } from '@/components/Attachments'
import { useBubbleTint } from '@/components/bubbleTint'
import { imageParts } from '@/components/markdownImageParts'
import { sourceItemHref } from '@/components/sourceLinks'
import { Text } from '@/components/Text'
import { PagerSwipe } from '@/components/ThreadPager'
import { serverMediaUri } from '@/lib/connection'
import { noteImageWidth } from '@/lib/noteImages'
import { colors, fonts, radius, scrims, spacing, squircle } from '@/theme'

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
  bleed = false,
  vaultImages = false,
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
  /**
   * For text that sits straight on the chat page: a table wider than the column then
   * scrolls to the screen's own edges instead of stopping at the column's padding.
   */
  bleed?: boolean
  /**
   * For a Knowledge note whose picture embeds were rewritten to the vault's signed
   * links (`withVaultPictures`): a picture at `/media/vault/` then loads from the Mac
   * itself. Off for a message, which keeps refusing every relative path.
   */
  vaultImages?: boolean
}) {
  const blocks = parseBlocks(text)
  return (
    <SentContext.Provider value={sent}>
      <CitesSources.Provider value={sources}>
        <VaultImages.Provider value={vaultImages}>
          <View style={styles.body}>
            {blocks.map((block, index) => <Block agents={agents} bleed={bleed} block={block} key={index} links={links} small={small} />)}
          </View>
        </VaultImages.Provider>
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
  /** The skills a `$slug` in the text may name: a known one is drawn as a skill pill. */
  skills?: readonly SkillConfig[]
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

/**
 * True when the text holds a table or a fenced block, the blocks that scroll sideways.
 * A box that sizes to its content must not hold one: Yoga then gives that box and the
 * boxes around it heights far beyond their text, so a sent bubble's fill runs on below
 * its words and under the rows after it. Such a bubble takes its full width instead.
 */
export function scrollsSideways(text: string): boolean {
  return parseBlocks(text).some((block) => block.kind === 'table' || block.kind === 'code')
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
  bleed,
  links,
  small,
}: {
  block: MdBlock
  agents: readonly AgentConfig[]
  bleed: boolean
  links?: MarkdownLinks
  small: boolean
}) {
  const { ink, press } = useLineProps()
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
            : <MarkdownImage alt={part.alt} href={part.href} key={`${index}:${part.src}`} src={part.src} />)}
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
      return <CodeBlock text={block.text} />
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
    case 'table':
      return <Table agents={agents} bleed={bleed} block={block} links={links} />
  }
}

/** How far in from a table's edge its hidden columns fade out. */
const TABLE_FADE = 36

/**
 * The swipe-to-reply gesture of the message a block sits in. A table wider than its
 * column scrolls sideways, so it holds this gesture back: a sideways swipe on the table
 * moves the table, and one anywhere else on the message still replies. Without it the
 * message's pan wins every horizontal touch over a native scroll view.
 */
export const ReplySwipe = createContext<GestureType | undefined>(undefined)

/**
 * The native gesture of a sideways scroller in a message. While it overflows it holds the
 * thread's page swipe back, and with `reply` the message's swipe to reply too, so a
 * sideways swipe on it scrolls it and one anywhere else still acts.
 */
function useSidewaysScroll(overflowing: boolean, reply: boolean) {
  const replyPan = useContext(ReplySwipe)
  const pagerPan = useContext(PagerSwipe)
  const scroll = Gesture.Native()
  const held = [reply ? replyPan : undefined, pagerPan].filter((pan) => pan !== undefined)
  if (overflowing && held.length > 0) scroll.blocksExternalGesture(...held)
  return scroll
}

/** A fenced block, which scrolls sideways when a line is wider than the column; a swipe to reply still wins on it. */
function CodeBlock({ text }: { text: string }) {
  const { ink, press, wash } = useLineProps()
  const widths = useRef({ content: 0, view: 0 })
  const [overflowing, setOverflowing] = useState(false)
  const measure = () => setOverflowing(widths.current.content > widths.current.view + 1)
  const scroll = useSidewaysScroll(overflowing, false)
  return (
    <GestureDetector gesture={scroll}>
      <ScrollView
        alwaysBounceHorizontal={false}
        contentContainerStyle={styles.codeInner}
        horizontal
        onContentSizeChange={(width) => { widths.current.content = width; measure() }}
        onLayout={(event: LayoutChangeEvent) => { widths.current.view = event.nativeEvent.layout.width; measure() }}
        showsHorizontalScrollIndicator={false}
        style={[styles.codeBlock, wash]}
      >
        <Text {...press} selectable style={[styles.code, ink]}>{text}</Text>
      </ScrollView>
    </GestureDetector>
  )
}

/**
 * Columns rather than rows, so each one is as wide as its own widest cell without a
 * measuring pass, up to the cap, past which a cell wraps onto more lines rather than
 * being cut off; the rows stay level across the columns through `measure`. Narrower than the chat column it fills it, wider than it it scrolls sideways,
 * the way the Mac's `min-w-full` table does; the percentage only resolves against the
 * viewport from the content container, never from a child of it.
 *
 * With `bleed` the scroll area grows to the screen's edges and its content is padded
 * back to the text column, so a column slides out under the screen's side rather than
 * under an invisible line at the padding. A side with columns still hidden fades them
 * out, a mask over the scroll area rather than a colour laid on it, so the fade is the
 * page (or the bubble) whatever sits behind the table. A table that fits has no fade.
 */
function Table({
  block,
  agents,
  bleed,
  links,
}: {
  block: Extract<MdBlock, { kind: 'table' }>
  agents: readonly AgentConfig[]
  bleed: boolean
  links?: MarkdownLinks
}) {
  const { ink, press } = useLineProps()
  const screen = useWindowDimensions()
  const host = useRef<View>(null)
  const [inset, setInset] = useState({ left: 0, right: 0 })
  const [hidden, setHidden] = useState({ start: false, end: false })
  const metrics = useRef({ offset: 0, content: 0, view: 0 })
  const [rowHeights, setRowHeights] = useState<number[]>([])
  const natural = useRef<number[][]>([])
  const scroll = useSidewaysScroll(hidden.start || hidden.end, true)

  // A cell wraps, so the cells of a row sit in different columns at different heights.
  // Each reports the height its own words need, and the tallest sets the row for all of them.
  const measure = (row: number, column: number, height: number) => {
    ;(natural.current[row] ??= [])[column] = height
    const next = Array.from({ length: block.rows.length + 1 }, (_, index) => (natural.current[index] ?? []).reduce((most, each) => Math.max(most, each), 0))
    setRowHeights((now) => (now.length === next.length && next.every((each, index) => Math.abs(each - (now[index] ?? 0)) < 0.5) ? now : next))
  }

  const settle = () => {
    const { offset, content, view } = metrics.current
    // The bounce past either end is not a column, and neither is the gutter that
    // aligns the first and last one with the text, so only a column cut off by the
    // screen's side counts as hidden.
    const reach = Math.max(content - view, 0)
    const at = Math.min(Math.max(offset, 0), reach)
    const start = at > inset.left + 1
    const end = reach - at > inset.right + 1
    setHidden((now) => (now.start === start && now.end === end ? now : { start, end }))
  }
  // How far the text column sits in from each side of the screen, measured where it is
  // drawn rather than assumed, so the table follows whatever padding the screen has.
  const onHostLayout = () => {
    if (!bleed) return
    host.current?.measureInWindow((x, _y, width) => {
      const left = Math.max(0, Math.round(x))
      const right = Math.max(0, Math.round(screen.width - x - width))
      setInset((now) => (now.left === left && now.right === right ? now : { left, right }))
    })
  }

  return (
    <View onLayout={onHostLayout} ref={host}>
      <MaskedView
        maskElement={
          <View style={styles.tableMask}>
            <LinearGradient
              colors={[hidden.start ? scrims.dark.maskClear : scrims.dark.mask, scrims.dark.mask]}
              end={{ x: 1, y: 0 }}
              start={{ x: 0, y: 0 }}
              style={styles.tableFade}
            />
            <View style={styles.tableMaskBody} />
            <LinearGradient
              colors={[scrims.dark.mask, hidden.end ? scrims.dark.maskClear : scrims.dark.mask]}
              end={{ x: 1, y: 0 }}
              start={{ x: 0, y: 0 }}
              style={styles.tableFade}
            />
          </View>
        }
        style={[styles.tableScroll, { marginLeft: -inset.left, marginRight: -inset.right }]}
      >
        <GestureDetector gesture={scroll}>
        <ScrollView
          alwaysBounceHorizontal={false}
          contentContainerStyle={[styles.table, { paddingLeft: inset.left, paddingRight: inset.right }]}
          horizontal
          onContentSizeChange={(width) => { metrics.current.content = width; settle() }}
          onLayout={(event: LayoutChangeEvent) => { metrics.current.view = event.nativeEvent.layout.width; settle() }}
          onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => { metrics.current.offset = event.nativeEvent.contentOffset.x; settle() }}
          scrollEventThrottle={16}
          showsHorizontalScrollIndicator={false}
        >
          {block.header.map((title, column) => {
            const side = { textAlign: block.align[column] ?? 'left' } as const
            const cell = (row: number, text: string) => (
              <View key={row} style={[row === 0 ? styles.headBox : styles.cellBox, { minHeight: rowHeights[row] === undefined ? undefined : rowHeights[row] + (row === 0 ? 1 : StyleSheet.hairlineWidth) }]}>
                <Text {...press} onLayout={(event: LayoutChangeEvent) => measure(row, column, event.nativeEvent.layout.height)} selectable style={[styles.cell, row === 0 && styles.headCell, side, ink]}>
                  <Inline agents={agents} links={links} text={text} />
                </Text>
              </View>
            )
            return (
              <View key={column} style={styles.column}>
                {cell(0, title)}
                {block.rows.map((row, index) => cell(index + 1, row[column] ?? ''))}
              </View>
            )
          })}
        </ScrollView>
        </GestureDetector>
      </MaskedView>
    </View>
  )
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
/** A note's picture while it loads and its own size is unknown: the height it holds. */
const VAULT_LOADING_HEIGHT = 200

/** True inside a Knowledge note, where `/media/vault/` links are the Mac's own pictures. */
const VaultImages = createContext(false)

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
  const inNote = useContext(VaultImages)
  const [column, setColumn] = useState<number>()
  // A note's picture is read off its signed link: shown straight from the Mac, at the
  // width its embed stored, and never wider than the column.
  const vault = inNote && src.startsWith(VAULT_IMAGE_PATH) ? noteImageWidth(src) : undefined
  const source = vault === undefined ? markdownImageSource(src) : vault.src
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
  const frame = vault !== undefined
    ? noteFrame(natural, vault.width, column ?? screen.width - 2 * spacing.lg)
    : natural === undefined
    ? { width: Math.min(IMAGE_LOADING_WIDTH, widest), height: IMAGE_CAP }
    : (() => {
        const scale = Math.min(1, IMAGE_CAP / natural.height, widest / natural.width)
        return { width: natural.width * scale, height: natural.height * scale }
      })()
  return (
    <View onLayout={vault === undefined ? undefined : (event: LayoutChangeEvent) => setColumn(event.nativeEvent.layout.width)} style={styles.imageRoom}>
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

/**
 * A note picture's box: the stored width, else its own width, held to the column, with the
 * picture's ratio. Before it loads the box is as wide as it will be and holds a fixed height.
 */
function noteFrame(natural: { width: number; height: number } | undefined, stored: number | undefined, column: number) {
  if (natural === undefined) return { width: Math.min(stored ?? column, column), height: VAULT_LOADING_HEIGHT }
  const width = Math.min(stored ?? natural.width, column)
  return { width, height: (width * natural.height) / natural.width }
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
  const message = useContext(SentContext)
  // Code too long for a pill follows the pills' colours: the tint, blue in his grey bubble.
  const codeStyle = tint !== undefined
    ? [styles.inlineCode, { color: tint.ink, backgroundColor: tint.wash }]
    : message === undefined ? styles.inlineCode : [styles.inlineCode, styles.inlineCodeBlue]
  const linkStyle = tint === undefined ? styles.link : [styles.link, { color: tint.ink }]
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
      // A file path is a pill with only its name, as on the Mac, and opens the file when this
      // chat's repo holds it. Other short code is a pill too; longer code stays text so it can wrap.
      const file = filePathName(match[4])
      const repo = links?.repo
      const repoPath = file === null ? null : repo?.resolve(match[4].replace(LINE_SUFFIX, '')) ?? null
      out.push(file !== null
        ? <InlinePill key={key} label={file} title={match[4]} tone="file" {...(repoPath === null || repo === undefined ? {} : { onPress: () => repo.open(repoPath) })} />
        : match[4].length <= CODE_PILL_CHARS
          ? <InlinePill key={key} label={match[4]} tone="code" />
          : <Text key={key} style={codeStyle}>{match[4]}</Text>)
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
  // His `[Image #n]` and `[Quote #n]` references read as pills: an image opens the
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
        <InlinePill
          key={`${ref.kind}${ref.start}`}
          label={quote === undefined ? `Image #${ref.number}` : quoteExcerpt(quote)}
          tone="carried"
          {...(open === undefined ? {} : { onPress: () => open(ref.number - 1) })}
        />,
      )
      at = ref.end
    }
    if (at < text.length) parts.push(<Mentions agents={agents} key={`t${at}`} text={text.slice(at)} />)
    return <Fragment>{parts}</Fragment>
  }
  const byName = new Map(agents.map((agent) => [agent.name.toLowerCase(), agent]))
  const destination = (handle: string) => sent && (handle === 'browser' || handle === 'work')
  const spans: { start: number; handle: string; skill?: SkillConfig }[] = [
    ...mentionSpans(text).filter((span) => byName.has(span.handle.toLowerCase()) || destination(span.handle.toLowerCase())),
    ...skillSpans(text, message?.skills ?? []),
  ].sort((a, b) => a.start - b.start)
  if (spans.length === 0) return text
  const out: ReactNode[] = []
  let last = 0
  for (const span of spans) {
    if (span.start < last) continue
    const handle = span.handle.toLowerCase()
    if (span.start > last) out.push(text.slice(last, span.start))
    const agent = byName.get(handle)
    if (span.skill !== undefined) {
      out.push(<InlinePill key={span.start} label={span.skill.name} title={span.skill.description} tone="skill" />)
    } else if (agent !== undefined) {
      const persona = personaOf([...agents], agent.id)
      out.push(<Text key={span.start} style={[styles.mention, { color: tint?.ink ?? persona.color }]}>@{agent.name}</Text>)
    } else {
      out.push(<InlinePill key={span.start} label={handle === 'browser' ? 'Browser' : 'Sessions'} tone="chip" />)
    }
    last = span.start + 1 + span.handle.length
  }
  if (last < text.length) out.push(text.slice(last))
  return <Fragment>{out}</Fragment>
}

/** A `$slug` at a word start, as the Mac's composer and sent bubble read it. */
const SKILL_TOKEN = /(?<![\p{L}\p{N}_-])\$(\S+)/gu
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/

/** The `$slug` tokens in `text` that name one of `skills`; any other `$word` stays text. */
function skillSpans(text: string, skills: readonly SkillConfig[]) {
  if (skills.length === 0 || !text.includes('$')) return []
  const byId = new Map(skills.map((skill) => [skill.id, skill]))
  return [...text.matchAll(SKILL_TOKEN)].flatMap((match) => {
    const handle = (match[1] ?? '').replace(TRAILING_PUNCTUATION, '')
    const skill = byId.get(handle.toLowerCase())
    return skill === undefined ? [] : [{ start: match.index, handle, skill }]
  })
}

/** Inline code up to this length fits one pill line; longer code stays wrapping text. */
const CODE_PILL_CHARS = 24
/**
 * A path with at least one folder and a file name with an extension, optionally `:line` or
 * `:from-to`. Every named segment holds a letter and no glob or `=` is allowed, so `1/2.5`,
 * a `--flag=a/b.json` and a glob stay code instead of losing everything before the last slash.
 */
const FILE_PATH = /^(?:~|\.{1,2}|[\w@.-]*[A-Za-z_][\w@.-]*)?(?:\/[\w@.-]*[A-Za-z_][\w@.-]*)*\/([\w@.-]*[A-Za-z_][\w@.-]*\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?)$/
const LINE_SUFFIX = /:\d+(?:-\d+)?$/

/** The name a file path pill shows, or null when the code is not a file path. */
function filePathName(code: string): string | null {
  return FILE_PATH.exec(code)?.[1] ?? null
}

/**
 * A rounded chip inside a sentence: short code (`code`), a file path by its name (`file`), a
 * destination handle (`chip`), a picture or quote the message carries (`carried`, blue as on
 * desktop), or a skill it runs (`skill`, purple as in the Mac's composer and sent bubble). An inline view like `SourcePill`, because nested text draws no rounded corners on
 * iOS. On a tinted bubble every tone takes the bubble's wash and ink, so it keeps contrast on
 * any face or project colour.
 */
function InlinePill({ label, title = label, tone, onPress }: {
  label: string
  /** The whole thing the pill stands for, for VoiceOver, when the label is cut down. */
  title?: string
  tone: 'code' | 'chip' | 'carried' | 'file' | 'skill'
  onPress?: () => void
}) {
  const tint = useBubbleTint()
  const sent = useContext(SentContext) !== undefined
  // In his own grey bubble every pill but a skill's is blue like a quote; in agent prose they
  // stay grey. A skill keeps its own purple, the way a persona keeps its face colour.
  const blue = tint === undefined && sent && tone !== 'skill'
  const box = [styles.pill, PILL_FILL[tone], blue && PILL_FILL.carried, tint && { backgroundColor: tint.wash }]
  const text = (
    <>
      {tone === 'file' ? <HugeiconsIcon color={tint?.ink ?? (blue ? colors.busy : colors.muted)} icon={File01Icon} size={12} strokeWidth={1.8} /> : null}
      {tone === 'skill' ? <HugeiconsIcon color={tint?.ink ?? colors.skill} icon={BoxIcon} size={12} strokeWidth={1.8} /> : null}
      <Text numberOfLines={1} style={[styles.pillText, PILL_TEXT[tone], blue && styles.pillTextBlue, tint && { color: tint.ink }]}>{label}</Text>
    </>
  )
  if (onPress === undefined) return <View accessibilityLabel={title} style={box}>{text}</View>
  return (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [...box, pressed && styles.sourcePillPressed]}
    >
      {text}
    </Pressable>
  )
}

const PILL_FILL = StyleSheet.create({
  code: { backgroundColor: colors.chip },
  file: { backgroundColor: colors.chip, gap: 4 },
  chip: { backgroundColor: colors.chip },
  carried: { backgroundColor: colors.busyWash },
  skill: { backgroundColor: colors.skillWash, gap: 4 },
})

const PILL_TEXT = StyleSheet.create({
  code: { fontFamily: fonts.mono, fontSize: 13 },
  file: {},
  chip: { fontWeight: '500' },
  carried: { color: colors.busy, fontWeight: '500' },
  skill: { color: colors.skill, fontWeight: '500' },
})

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
  inlineCodeBlue: { color: colors.busy, backgroundColor: colors.busyWash },
  link: { color: colors.busy, textDecorationLine: 'underline' },
  deadLink: { color: colors.dim, textDecorationLine: 'underline' },
  mention: { fontWeight: '500' },
  // Sized and nudged like `sourcePill`, so it sits on the type without pushing lines apart.
  pill: {
    flexDirection: 'row', alignItems: 'center', height: 19, maxWidth: 220, paddingHorizontal: 7,
    borderRadius: radius.round, ...squircle, transform: [{ translateY: 2 }],
  },
  pillText: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 14, lineHeight: 17 },
  pillTextBlue: { color: colors.busy },
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
  tableMask: { flex: 1, flexDirection: 'row' },
  tableMaskBody: { flex: 1, backgroundColor: scrims.dark.mask },
  tableFade: { width: TABLE_FADE },
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
  },
  cellBox: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  // The header carries the only full-weight rule in the table, which is what separates a
  // table from a stack of rows; between the rows a hairline is enough.
  headBox: { borderBottomWidth: 1, borderBottomColor: colors.line },
  headCell: { color: colors.muted, fontWeight: '500' },
})
