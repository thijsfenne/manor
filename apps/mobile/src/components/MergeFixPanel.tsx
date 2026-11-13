import { useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { mergeFixLines, workMergeFix, type WorkResult } from '@manor/client-runtime/state'
import { useWorkspaceActions, useWorkspaceStatus } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle } from '@/theme'
import { Text } from './Text'

const LINE_COLOR = { add: colors.ok, remove: colors.danger, meta: colors.dim, context: colors.muted } as const

/**
 * The phone's copy of the Mac's conflict fix: the lead rewrote a conflicted change
 * instead of keeping both sides, so the user reads the fix and approves it before Manor
 * merges. Nothing shows for a clean rebase or a fix that kept both sides.
 */
export function MergeFixPanel({ result, onOpenSession }: { result: WorkResult; onOpenSession?: () => void }) {
  const { approveMergeFix } = useWorkspaceActions()
  const connected = useWorkspaceStatus() === 'live'
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const fix = workMergeFix(result)
  if (fix === undefined) return null

  const approve = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await approveMergeFix(result.handoffId, fix.tip)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not go through. Try again.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const into = result.completion?.mergeInto ?? 'its branch'
  const files = fix.files.length === 1 ? fix.files[0] : `${fix.files.length} files`

  return (
    <View style={styles.panel}>
      <Text style={styles.lead}>{`The lead resolved a conflict in ${files} while rebasing onto ${into}. Read the fix; approving it merges the Session.`}</Text>
      <ScrollView accessibilityLabel="Conflict fix" nestedScrollEnabled style={styles.diff}>
        <ScrollView horizontal nestedScrollEnabled>
          <View>
            {mergeFixLines(fix.diff).map((line, index) => (
              <Text key={index} selectable style={[styles.line, { color: LINE_COLOR[line.kind] }]}>{line.text === '' ? ' ' : line.text}</Text>
            ))}
            {fix.truncated === true ? <Text style={[styles.line, { color: colors.dim }]}>… the rest is in the Session’s diff</Text> : null}
          </View>
        </ScrollView>
      </ScrollView>
      <View style={styles.actions}>
        {onOpenSession === undefined ? null : (
          <Pressable accessibilityRole="button" onPress={onOpenSession} style={({ pressed }) => [styles.action, styles.ghost, styles.leading, pressed && styles.pressed]}>
            <Text style={styles.actionLabel}>Open Session</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || !connected }}
          disabled={busy || !connected}
          onPress={() => void approve()}
          style={({ pressed }) => [styles.action, styles.primary, (busy || !connected) && styles.disabled, pressed && styles.pressed]}
        >
          <Text style={[styles.actionLabel, { color: colors.onPrimary }]}>{busy ? 'Approving…' : 'Approve fix and merge'}</Text>
        </Pressable>
      </View>
      {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  panel: { gap: spacing.sm },
  lead: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  diff: { maxHeight: 240, borderRadius: radius.md, ...squircle, backgroundColor: colors.fill, padding: spacing.sm },
  line: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'flex-end' },
  leading: { marginRight: 'auto' },
  action: { minHeight: 34, justifyContent: 'center', borderRadius: radius.sm, ...squircle, backgroundColor: colors.fill, paddingHorizontal: spacing.md },
  ghost: { backgroundColor: 'transparent', paddingHorizontal: spacing.sm },
  primary: { backgroundColor: colors.text },
  actionLabel: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.6 },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13 },
})
