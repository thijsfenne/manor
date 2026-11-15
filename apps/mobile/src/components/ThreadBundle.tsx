import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import BubbleChatDoneIcon from '@hugeicons/core-free-icons/BubbleChatDoneIcon'
import BubbleChatQuestionIcon from '@hugeicons/core-free-icons/BubbleChatQuestionIcon'
import CellsIcon from '@hugeicons/core-free-icons/CellsIcon'
import FileEditIcon from '@hugeicons/core-free-icons/FileEditIcon'
import Idea01Icon from '@hugeicons/core-free-icons/Idea01Icon'
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon'
import Note01Icon from '@hugeicons/core-free-icons/Note01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { threadBundleView, type Row, type ThreadBundleEntry, type ThreadBundleGlyph, type ThreadBundleRow, type ThreadBundleTone } from '@manor/client-runtime/state'
import { useContext, useMemo, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, View, type ColorValue } from 'react-native'
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated'

import { Text } from '@/components/Text'
import { AnswerChange, bundleTile, InBundle, OTHER_ANSWER } from './bundleTile'
import { colors, fonts, spacing, squircle } from '@/theme'

const ARRIVE = FadeIn.duration(200).reduceMotion(ReduceMotion.System)
const LEAVE = FadeOut.duration(150).reduceMotion(ReduceMotion.System)

const GLYPH: Record<ThreadBundleGlyph, typeof CellsIcon> = {
  session: CellsIcon,
  file: Note01Icon,
  learning: Idea01Icon,
  report: FileEditIcon,
  answer: BubbleChatDoneIcon,
  question: BubbleChatQuestionIcon,
  update: InformationCircleIcon,
}

const TONE: Record<ThreadBundleTone, ColorValue> = { ok: colors.ok, busy: colors.busy, warn: colors.warning, dim: colors.dim }

/**
 * The phone twin of the Mac's bundle line: what Sessions and the thread posted since
 * The user's last message, one row with a chip per kind of thing that happened. A tap opens
 * it to one filled tile per item, Sessions first, then notes, then learnings: a Session as
 * its one-line thread line, anything else as a note: its first line that a tap
 * opens in full. Every bundle starts closed; the chat screen holds which
 * bundles and notes stand open, so a jump to a quoted item can open both.
 */
export function ThreadBundle({ row, open, openItems, onOpenChange, renderItem }: {
  row: ThreadBundleRow
  open: boolean
  openItems: ReadonlySet<string>
  /** Opens or closes the bundle (its own key) or one of its notes (the item's key). */
  onOpenChange: (key: string, open: boolean) => void
  renderItem: (item: Row) => ReactNode
}) {
  const view = useMemo(() => threadBundleView(row.items, row.advice), [row.items, row.advice])
  // The chips fade only when an item joined; a thread that opens draws them at once.
  const [shown, setShown] = useState(row.summary)
  const [changed, setChanged] = useState(false)
  if (shown !== row.summary) {
    setShown(row.summary)
    setChanged(true)
  }
  return (
    <View style={styles.frame}>
      <Pressable
        accessibilityLabel={row.summary}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => onOpenChange(row.key, !open)}
        style={({ pressed }) => [styles.bar, pressed && styles.pressed]}
      >
        <Animated.View key={row.summary} {...(changed ? { entering: ARRIVE } : {})} style={styles.chips}>
          {view.chips.map((chip) => (
            <View key={chip.key} style={styles.chip}>
              <HugeiconsIcon color={TONE[chip.tone]} icon={GLYPH[chip.glyph]} size={14} strokeWidth={1.8} />
              <Text numberOfLines={1} style={styles.chipText}>
                <Text style={styles.chipCount}>{chip.count}</Text> <Text style={styles.chipLabel}>{chip.label}</Text>
              </Text>
            </View>
          ))}
        </Animated.View>
        <View style={open && styles.chevronOpen}>
          <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
        </View>
      </Pressable>
      {open ? (
        <Animated.View entering={ARRIVE} exiting={LEAVE} style={styles.list}>
          <InBundle.Provider value>
            {view.entries.map((entry) => (
              <Animated.View key={entry.key} entering={ARRIVE} exiting={LEAVE}>
                {entry.kind === 'note'
                  ? <NoteTile note={entry} open={openItems.has(entry.key)} onOpenChange={(value) => onOpenChange(entry.key, value)} />
                  : renderItem(entry.item)}
              </Animated.View>
            ))}
          </InBundle.Provider>
        </Animated.View>
      ) : null}
    </View>
  )
}

/**
 * A note in an open bundle, a tile like a Session's: its mark, its first line, a small tag. A tap shows all of it.
 * An answer the thread gave from a preference also offers Other answer at its end.
 */
function NoteTile({ note, open, onOpenChange }: {
  note: Extract<ThreadBundleEntry, { kind: 'note' }>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const change = useContext(AnswerChange)
  const noteId = note.item.kind === 'event' ? note.item.event.id : undefined
  const changeable = change !== null && noteId !== undefined && change.ids.has(noteId)
  const words = open ? note.text : note.title
  const spoken = open && note.advice !== undefined ? `${words} Suggested: ${note.advice}` : words
  return (
    <View style={[bundleTile.tile, styles.noteRow, open && styles.noteOpen]}>
      <Pressable
        accessibilityLabel={note.tag === '' ? spoken : `${spoken}, ${note.tag}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => onOpenChange(!open)}
        style={({ pressed }) => [styles.notePress, open && styles.noteOpen, pressed && styles.pressed]}
      >
        <View style={[styles.noteMark, open && styles.lead]}>
          <HugeiconsIcon color={TONE[note.tone]} icon={GLYPH[note.glyph]} size={15} strokeWidth={1.8} />
        </View>
        {open && note.advice !== undefined ? (
          <View style={styles.noteBody}>
            <Text style={styles.bodyText}>{words}</Text>
            <Text style={[styles.bodyText, styles.advice]}><Text style={styles.adviceLabel}>Suggested: </Text>{note.advice}</Text>
          </View>
        ) : <Text numberOfLines={open ? undefined : 1} style={[styles.noteText, open && styles.noteTextOpen]}>{words}</Text>}
        {note.tag === '' ? null : <Text numberOfLines={1} style={[styles.tag, open && styles.lead]}>{note.tag}</Text>}
      </Pressable>
      {changeable ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => change.onChange(noteId)}
          style={({ pressed }) => [open && styles.lead, pressed && styles.pressed]}
        >
          <Text style={styles.action}>{OTHER_ANSWER}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  // One rounded box on the sidebar's step; the chips sit on it without a rule under them.
  frame: {
    borderRadius: 10,
    ...squircle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.sidebar,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: spacing.sm,
    paddingRight: 10,
    paddingVertical: 6,
  },
  pressed: { opacity: 0.7 },
  chips: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    borderRadius: 999,
    backgroundColor: colors.sidebarFill,
    paddingLeft: 7,
    paddingRight: 9,
    paddingVertical: 3,
  },
  chipText: { color: colors.text, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 16 },
  chipCount: { fontWeight: '500' },
  chipLabel: { color: colors.muted },
  chevronOpen: { transform: [{ rotate: '180deg' }] },
  // Tiles sit 2px in from the box's edge and 2px apart.
  list: { gap: 2, paddingHorizontal: 2, paddingBottom: 2 },
  noteOpen: { alignItems: 'flex-start' },
  // The tile holds the note's own press and, for an answer from preferences, its action.
  noteRow: { paddingVertical: 0 },
  notePress: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  action: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
  noteMark: { width: 16, flexShrink: 0 },
  lead: { paddingTop: 2 },
  noteText: { flex: 1, minWidth: 0, color: colors.text, fontFamily: fonts.sans, fontSize: 13, lineHeight: 16 },
  noteTextOpen: { lineHeight: 19 },
  noteBody: { flex: 1, minWidth: 0, gap: 6 },
  bodyText: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
  advice: { color: colors.muted },
  adviceLabel: { color: colors.dim },
  tag: { flexShrink: 0, maxWidth: '40%', color: colors.dim, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
})
