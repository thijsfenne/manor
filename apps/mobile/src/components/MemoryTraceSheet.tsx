import type { MemoryRead, MemoryTrace } from '@manor/contracts'
import { Fragment, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'

import { ScrimScrollView } from '@/components/EdgeScrim'
import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

interface MemoryTraceSheetProps {
  open: boolean
  onClose: () => void
  trace: MemoryTrace
}

/** The memory evidence behind one answer, in the phone's existing page-sheet frame. */
export function MemoryTraceSheet({ open, onClose, trace }: MemoryTraceSheetProps) {
  const summary = trace.summary
  return (
    <Sheet onClose={onClose} open={open} subtitle={summaryLabel(trace)} title="Memory">
      <ScrimScrollView contentContainerStyle={styles.content}>
        {summary.status === 'not_read' ? (
          <Text style={styles.empty}>No memory was read this turn.</Text>
        ) : summary.status === 'used' ? (
          <View style={styles.list}>
            {summary.items.map((item, index) => (
              <View key={`${item.sourcePath}:${index}`} style={styles.item}>
                <Text style={styles.claim}>{item.text}</Text>
                <Text numberOfLines={1} style={styles.source}>{baseName(item.sourcePath)}</Text>
              </View>
            ))}
            <Derivation>Inferred after the turn, {readsLabel(trace.reads)}</Derivation>
          </View>
        ) : (
          <View style={styles.list}>
            <View style={styles.statusRow}>
              {summary.status === 'none' ? <View style={styles.failure} /> : null}
              <Text style={styles.statusText}>
                {summary.status === 'none'
                  ? 'Nothing from memory in the answer'
                  : 'Could not establish what the answer used'}
              </Text>
            </View>
            <Text style={styles.paths}>
              {distinctReadPaths(trace.reads).map((path, index) => (
                <Fragment key={path}>
                  {index === 0 ? null : <Text style={styles.separator}>, </Text>}
                  <Text style={styles.path}>{baseName(path)}</Text>
                </Fragment>
              ))}
            </Text>
            <Derivation>
              {summary.status === 'none' ? 'Inferred after the turn, ' : ''}
              {readsLabel(trace.reads)}
            </Derivation>
          </View>
        )}
      </ScrimScrollView>
    </Sheet>
  )
}

function summaryLabel(trace: MemoryTrace): string {
  switch (trace.summary.status) {
    case 'used':
      return `Memory used, ${trace.summary.items.length === 1 ? '1 note' : `${trace.summary.items.length} notes`}`
    case 'none':
      return 'Memory read, none of it used'
    case 'not_read':
      return 'No memory read this turn'
    case 'unavailable':
      return 'Memory use could not be established'
  }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

function readsLabel(reads: readonly MemoryRead[]): string {
  const injected = reads.filter((read) => read.source === 'injected').length
  const onDemand = reads.length - injected
  const parts = [
    ...(onDemand === 0 ? [] : [`${plural(onDemand, 'file')} read on request`]),
    ...(injected === 0 ? [] : [`${plural(injected, 'file')} injected at start`]),
  ]
  return parts.length === 0 ? 'nothing read' : parts.join(', ')
}

const distinctReadPaths = (reads: readonly MemoryRead[]) => [...new Set(reads.map((read) => read.path))]
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

function Derivation({ children }: { children: ReactNode }) {
  return (
    <View style={styles.derivation}>
      <Text style={styles.derivationText}>{children}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  list: { gap: spacing.md },
  item: { gap: 6, borderRadius: radius.md, ...squircle, backgroundColor: colors.sheetSurface, padding: spacing.md },
  claim: { color: colors.text, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  source: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12 },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  statusRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  failure: { width: 6, height: 6, marginTop: 7, borderRadius: radius.round, backgroundColor: colors.danger },
  statusText: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  paths: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 20 },
  separator: { color: colors.dim },
  path: { color: colors.muted, fontFamily: fonts.mono },
  derivation: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: spacing.sm },
  derivationText: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18 },
})
