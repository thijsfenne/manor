import type { MemoryChange, MemoryChangeLine } from '@manor/contracts'
import { ScrollView, StyleSheet, View } from 'react-native'

import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

interface MemoryChangesSheetProps {
  open: boolean
  onClose: () => void
  changes: MemoryChange[]
}

/**
 * What one turn wrote into memory, file by file. Only the changed lines: a daily log is
 * a list of independent facts, so the neighbours a code diff shows would only be noise.
 */
export function MemoryChangesSheet({ open, onClose, changes }: MemoryChangesSheetProps) {
  const shown = changes.filter((change) => change.lines.length > 0)
  return (
    <Sheet onClose={onClose} open={open} subtitle={memoryChangesLabel(changes)} title="Memory updated">
      <ScrollView contentContainerStyle={styles.list}>
        {shown.map((change) => (
          <View key={change.path} style={styles.file}>
            <Text numberOfLines={1} style={styles.fileName}>{baseName(change.path)}</Text>
            <View style={styles.rows}>
              {change.lines.flatMap(changeRows).map((row, index) => (
                <View
                  accessibilityLabel={`${row.kind === 'added' ? 'Added' : 'Removed'}: ${row.text}`}
                  key={index}
                  style={[styles.line, row.kind === 'added' ? styles.addedLine : styles.removedLine]}
                >
                  <Text style={[styles.sign, row.kind === 'added' ? styles.added : styles.removed]}>
                    {row.kind === 'added' ? '+' : '−'}
                  </Text>
                  <Text style={[styles.text, row.kind === 'added' ? styles.added : styles.removed]}>{row.text}</Text>
                </View>
              ))}
            </View>
            {change.truncated ? <Text style={styles.cut}>Shortened, only the first lines are shown.</Text> : null}
          </View>
        ))}
      </ScrollView>
    </Sheet>
  )
}

export const hasMemoryChanges = (changes: MemoryChange[] | undefined): changes is MemoryChange[] =>
  changes !== undefined && changes.some((change) => change.lines.length > 0)

export function memoryChangesLabel(changes: MemoryChange[]): string {
  const count = changes.reduce((total, change) => total + change.lines.length, 0)
  return count === 1 ? '1 change' : `${count} changes`
}

/** A replacement reads as the old line going and the new one arriving, like any diff. */
function changeRows(line: MemoryChangeLine): { kind: 'added' | 'removed'; text: string }[] {
  if (line.kind === 'replaced') {
    return [
      { kind: 'removed', text: line.before },
      { kind: 'added', text: line.after },
    ]
  }
  return [{ kind: line.kind, text: line.text }]
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

const styles = StyleSheet.create({
  list: { gap: spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  file: { overflow: 'hidden', borderRadius: radius.lg, ...squircle, backgroundColor: colors.sheetSurface },
  fileName: { color: colors.text, fontFamily: fonts.mono, fontSize: 13, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.background, paddingVertical: spacing.xs },
  line: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: spacing.md },
  addedLine: { backgroundColor: colors.diffAdded },
  removedLine: { backgroundColor: colors.diffRemoved },
  sign: { width: 14, fontFamily: fonts.mono, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  text: { flex: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: 11, lineHeight: 17 },
  added: { color: colors.ok },
  removed: { color: colors.danger },
  cut: { color: colors.dim, fontSize: 12, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
})
