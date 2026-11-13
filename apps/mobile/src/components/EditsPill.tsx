import { compactCount, changedTotals, type ChangedFile } from '@manor/client-runtime/changed-files'
import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'

import { GlassPressable } from '@/components/GlassPressable'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing } from '@/theme'

/**
 * Everything this chat has written so far, as one glass pill above the composer. The
 * card in a turn answers "what did that reply change"; this answers "what has this
 * conversation done to the repo", which is the question that follows you down a long
 * thread and has nowhere else to live once the turn that made a change has scrolled
 * away. Tapping it opens the same sheet a card does, over every file rather than one
 * turn's.
 *
 * Counts are abbreviated past a thousand: a pill that grows with the number would
 * push the jump button around, and by then the magnitude is the answer.
 *
 * Material and touch route through the same shared glass control as the header,
 * so native interaction and the non-glass fallback cannot drift apart here.
 */
export function EditsPill({ files, onPress }: { files: ChangedFile[]; onPress: () => void }) {
  const totals = useMemo(() => changedTotals(files), [files])

  return (
    <GlassPressable
      accessibilityLabel={`View everything this chat changed: ${files.length} ${files.length === 1 ? 'file' : 'files'}, ${totals.added} added, ${totals.removed} removed`}
      onPress={onPress}
      radius={radius.round}
      style={styles.glass}
    >
      <View style={styles.press}>
        <Text style={styles.count}>{files.length} {files.length === 1 ? 'file' : 'files'}</Text>
        {totals.added === 0 ? null : <Text style={styles.added}>+{compactCount(totals.added)}</Text>}
        {totals.removed === 0 ? null : <Text style={styles.removed}>−{compactCount(totals.removed)}</Text>}
      </View>
    </GlassPressable>
  )
}

const styles = StyleSheet.create({
  glass: { alignSelf: 'center' },
  press: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md + 2, paddingVertical: 7 },
  count: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  added: { color: colors.ok, fontFamily: fonts.mono, fontSize: 13, fontVariant: ['tabular-nums'] },
  removed: { color: colors.danger, fontFamily: fonts.mono, fontSize: 13, fontVariant: ['tabular-nums'] },
})
