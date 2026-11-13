import { ArrowDown01Icon, FileEmpty02Icon, FileMinusIcon, FilePlusIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { FileEdit } from '@manor/contracts'
import { changedTotals, type ChangedFile } from '@manor/client-runtime/changed-files'
import { collapseContext, editLines, editStat, numberedDiff, type DiffLine } from '@manor/client-runtime/diff'
import { useMemo, useState, type ReactElement } from 'react'
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'

import { DisclosureChevron } from '@/components/DisclosureChevron'
import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { colors, fonts, spacing } from '@/theme'

/**
 * How many rows one hunk renders. A generated file rewritten whole is one hunk of
 * thousands of lines, and a sheet that tries to lay all of them out stalls opening.
 * What falls off is said out loud, so a clipped diff is never read as the change.
 */
const MAX_HUNK_ROWS = 400

/**
 * How much of one line a row draws. Lines do not wrap, they scroll sideways, and a
 * minified file's single line would otherwise lay out tens of thousands of glyphs.
 */
const MAX_LINE_CHARS = 400

/**
 * One diff row at the default text size, in points. Gutter and code sit in separate
 * columns, so both size their rows from this times the text scale, and the scale is
 * capped so a row never outgrows the height they agree on.
 */
const ROW_HEIGHT = 18
const MAX_TEXT_SCALE = 2

/**
 * Everything a turn or a chat changed, as a list of files first. Each row opens to
 * its diff in place, and an open file's row sticks to the top while its lines scroll
 * under it, so the reader always knows which file they are in. Read-only on purpose:
 * editing a file is the Mac's job, and the phone is here to check the work.
 */
export function DiffSheet({ files, open, onClose }: { files: ChangedFile[]; open: boolean; onClose: () => void }) {
  const totals = useMemo(() => changedTotals(files), [files])
  // A tap pins a file open or closed; an untouched file follows the default, so a lone
  // file starts open and a list starts as an index.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const startOpen = files.length === 1
  const subtitle = [
    totals.added === 0 ? null : `+${totals.added}`,
    totals.removed === 0 ? null : `−${totals.removed}`,
  ].filter((part) => part !== null).join('  ')

  const toggle = (key: string, wasOpen: boolean) =>
    setChosen((current) => new Map(current).set(key, !wasOpen))

  const children: ReactElement[] = []
  const sticky: number[] = []
  const seen = new Map<string, number>()
  files.forEach((file, index) => {
    // What the driver reported, which does not change when the repo listing arrives and
    // gives a file its panel path, so a choice stays with its file. A listing can split a
    // file's tool report from its measured row, both with this path, so a repeat gets its
    // count after a NUL, the one character no path can hold.
    const repeat = (seen.get(file.raw) ?? 0) + 1
    seen.set(file.raw, repeat)
    const key = repeat === 1 ? file.raw : `${file.raw}\u0000${repeat}`
    const isOpen = chosen.get(key) ?? startOpen
    sticky.push(children.length)
    children.push(<FileRow file={file} key={key} last={index === files.length - 1 && !isOpen} onPress={() => toggle(key, isOpen)} open={isOpen} />)
    if (isOpen) children.push(<FileDiff file={file} key={`${key}\u0000diff`} />)
  })

  return (
    <Sheet
      onClose={onClose}
      open={open}
      {...(subtitle === '' ? {} : { subtitle })}
      title={`${files.length} changed ${files.length === 1 ? 'file' : 'files'}`}
    >
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false} stickyHeaderIndices={sticky}>
        {children}
      </ScrollView>
    </Sheet>
  )
}

/** One file as an index entry: what happened to it, its name, where it lives, how much changed. */
function FileRow({ file, open, last, onPress }: { file: ChangedFile; open: boolean; last: boolean; onPress: () => void }) {
  const cut = file.path.lastIndexOf('/')
  const folder = cut <= 0 ? null : homeRelative(file.path.slice(0, cut))
  const kind = file.status === 'created' ? 'New file' : file.status === 'deleted' ? 'Deleted file' : 'Edited file'

  return (
    <Pressable
      accessibilityHint={open ? 'Hides the diff' : 'Shows the diff'}
      accessibilityLabel={`${kind} ${file.raw}, ${file.added} added, ${file.removed} removed`}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, last && styles.rowLast, pressed && styles.pressed]}
    >
      <DisclosureChevron open={open}>
        <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
      </DisclosureChevron>
      <HugeiconsIcon
        color={file.status === 'created' ? colors.ok : file.status === 'deleted' ? colors.danger : colors.muted}
        icon={file.status === 'created' ? FilePlusIcon : file.status === 'deleted' ? FileMinusIcon : FileEmpty02Icon}
        size={18}
        strokeWidth={1.6}
      />
      <View style={styles.names}>
        <Text ellipsizeMode="middle" numberOfLines={1} style={styles.name}>{file.path.slice(cut + 1)}</Text>
        {folder === null ? null : (
          <Text ellipsizeMode="head" numberOfLines={1} style={styles.folder}>{folder}</Text>
        )}
      </View>
      <Stat added={file.added} removed={file.removed} />
    </Pressable>
  )
}

/** An open file: its hunks one under the other, or why there is nothing to show. */
function FileDiff({ file }: { file: ChangedFile }) {
  const hunks = useMemo(
    () => file.edits.filter((edit) => { const stat = editStat(edit); return stat.added + stat.removed > 0 }),
    [file.edits],
  )
  const truncatedNote = 'Part of this diff was too large to show.'

  return (
    <Animated.View entering={FadeIn.duration(160)} style={styles.diff}>
      {hunks.length === 0 ? (
        <Text style={styles.empty}>
          {file.diffTruncated ? truncatedNote : file.status === 'deleted' ? 'This file was deleted.' : 'The runtime sent no content, so there is no diff to show.'}
        </Text>
      ) : (
        hunks.map((edit, index) => <Hunk edit={edit} key={`${file.raw}:hunk:${index}`} labelled={hunks.length > 1} />)
      )}
      {file.diffTruncated && hunks.length > 0 ? <Text style={styles.truncated}>{truncatedNote}</Text> : null}
    </Animated.View>
  )
}

/**
 * One hunk. The gutter (change bar, line number, sign) stands still while the code
 * beside it scrolls sideways, so a long line never pushes the numbers off screen and
 * never wraps a single change into a paragraph. A file with several hunks names each
 * by its lines, so a reader can tell where one stops and the next starts.
 */
function Hunk({ edit, labelled }: { edit: FileEdit; labelled: boolean }) {
  const rows = useMemo(() => numberedDiff(collapseContext(editLines(edit)), edit.offset), [edit])
  const shown = rows.slice(0, MAX_HUNK_ROWS)
  const dropped = rows.length - shown.length
  const scale = Math.min(useWindowDimensions().fontScale, MAX_TEXT_SCALE)
  const row = { height: ROW_HEIGHT * scale }

  return (
    <View>
      {labelled ? <Text style={styles.hunkLabel}>{rangeLabel(shown)}</Text> : null}
      <View style={styles.hunkBody}>
        {/* The code rows below say what each line is; the gutter is for the eye only. */}
        {/* Bar, number and sign are columns of their own, so the number column takes the
            width of its widest number and every number right-aligns in it, whatever the font. */}
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.gutter}>
          <View>
            {shown.map((line, index) => (
              <View key={index} style={[styles.bar, row, line.kind === 'added' && styles.barAdded, line.kind === 'removed' && styles.barRemoved]} />
            ))}
          </View>
          <View>
            {shown.map((line, index) => (
              <Text key={index} maxFontSizeMultiplier={MAX_TEXT_SCALE} numberOfLines={1} style={[styles.number, row, line.kind !== 'gap' && tone(line.kind)]}>
                {line.kind === 'gap' ? '' : line.number}
              </Text>
            ))}
          </View>
          <View>
            {shown.map((line, index) => (
              <Text key={index} maxFontSizeMultiplier={MAX_TEXT_SCALE} style={[styles.sign, row, line.kind !== 'gap' && tone(line.kind), line.kind === 'added' ? styles.added : styles.removed]}>
                {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
              </Text>
            ))}
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.codeContent} horizontal showsHorizontalScrollIndicator={false} style={styles.code}>
          <View style={styles.codeColumn}>
            {shown.map((line, index) =>
              line.kind === 'gap' ? (
                <Text key={index} maxFontSizeMultiplier={MAX_TEXT_SCALE} numberOfLines={1} style={[styles.gap, row]}>
                  ⋯ {line.count} unchanged {line.count === 1 ? 'line' : 'lines'}
                </Text>
              ) : (
                <View accessibilityLabel={lineLabel(line)} accessible key={index} style={[styles.codeRow, row, tone(line.kind)]}>
                  <Text maxFontSizeMultiplier={MAX_TEXT_SCALE} numberOfLines={1} style={[styles.text, line.kind === 'same' && styles.context]}>
                    {displayLine(line.text)}
                  </Text>
                </View>
              ),
            )}
          </View>
        </ScrollView>
      </View>
      {dropped > 0 ? <Text style={styles.note}>{dropped} more {dropped === 1 ? 'line' : 'lines'}, too long to show here.</Text> : null}
      {edit.truncated ? <Text style={styles.truncated}>The change was too long to store in full; the rest is not shown.</Text> : null}
    </View>
  )
}


/** What VoiceOver reads for one code row, since the gutter beside it is hidden. */
function lineLabel(line: DiffLine & { number?: number }): string {
  const kind = line.kind === 'added' ? 'Added' : line.kind === 'removed' ? 'Removed' : 'Unchanged'
  const at = line.number === undefined ? '' : ` line ${line.number}`
  return `${kind}${at}: ${line.text.trim() === '' ? 'blank' : line.text}`
}

const tone = (kind: DiffLine['kind']) =>
  kind === 'added' ? styles.addedRow : kind === 'removed' ? styles.removedRow : null

/**
 * A line as the row draws it: tabs as four spaces so indentation keeps its width, an
 * empty line as one space so the row keeps its height, and anything past the cap cut
 * with an ellipsis rather than laid out.
 */
function displayLine(text: string): string {
  const expanded = text.replace(/\t/g, '    ')
  if (expanded === '') return ' '
  return expanded.length > MAX_LINE_CHARS ? `${expanded.slice(0, MAX_LINE_CHARS)}…` : expanded
}

/**
 * The folder line under a file name. A home folder reads as `~`, the way the Mac's
 * own path labels do; the server sends no home, so it is recognised by shape.
 */
function homeRelative(folder: string): string {
  return folder.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** The span of the file a hunk covers, as the numbers a reader would scroll to. */
function rangeLabel(rows: ReturnType<typeof numberedDiff>): string {
  const numbers = rows.flatMap((row) => (row.kind === 'gap' || row.number === undefined ? [] : [row.number]))
  const first = numbers[0]
  const last = numbers[numbers.length - 1]
  if (first === undefined || last === undefined) return 'Change'
  return first === last ? `Line ${first}` : `Lines ${first}–${last}`
}

function Stat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null
  return (
    <View style={styles.stat}>
      {added === 0 ? null : <Text style={styles.added}>+{added}</Text>}
      {removed === 0 ? null : <Text style={styles.removed}>−{removed}</Text>}
    </View>
  )
}

const mono = { fontFamily: fonts.mono, fontSize: 11, lineHeight: ROW_HEIGHT } as const

const styles = StyleSheet.create({
  list: { paddingBottom: spacing.xxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.sheet,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowLast: { borderBottomWidth: 0 },
  pressed: { opacity: 0.7 },
  names: { flex: 1, minWidth: 0, gap: 1, marginLeft: spacing.xs },
  name: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  folder: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  diff: {
    backgroundColor: colors.surface,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  empty: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  hunkLabel: { ...mono, color: colors.muted, backgroundColor: colors.surface2, paddingHorizontal: spacing.lg, marginTop: spacing.xs },
  hunkBody: { flexDirection: 'row' },
  gutter: { flexDirection: 'row' },
  bar: { width: 3 },
  barAdded: { backgroundColor: colors.ok },
  barRemoved: { backgroundColor: colors.danger },
  number: { ...mono, color: colors.dim, textAlign: 'right', fontVariant: ['tabular-nums'], paddingLeft: spacing.sm, minWidth: 28 },
  sign: { ...mono, paddingHorizontal: spacing.xs, textAlign: 'center' },
  code: { flex: 1 },
  codeContent: { flexGrow: 1 },
  codeColumn: { flexGrow: 1 },
  codeRow: { paddingRight: spacing.lg },
  text: { ...mono, color: colors.text },
  context: { color: colors.muted },
  addedRow: { backgroundColor: colors.diffAdded },
  removedRow: { backgroundColor: colors.diffRemoved },
  added: { ...mono, color: colors.ok },
  removed: { ...mono, color: colors.danger },
  gap: { ...mono, color: colors.dim },
  note: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  truncated: { color: colors.warning, fontFamily: fonts.sans, fontSize: 12, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
})
