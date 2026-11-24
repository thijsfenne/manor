import { Alert, Pressable, StyleSheet, View } from 'react-native'
import { TextInput } from '@/components/TextInput'

import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { leavePrompt } from '@/lib/promptDiscard'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/**
 * The task a session proposal will start from, read in full and edited before Accept.
 * The card owns the draft and Save hands it back to the card. Close and the back gesture
 * ask before they drop a draft that differs from `opened`; nothing reaches the server
 * until Accept.
 */
export function WorkPromptSheet({ open, title, opened, draft, onChange, onSave, onClose }: {
  open: boolean
  title: string
  /** The text the sheet opened with, to tell an edit from an untouched draft. */
  opened: string
  draft: string
  onChange: (draft: string) => void
  onSave: () => void
  onClose: () => void
}) {
  const empty = draft.trim().length === 0
  const leave = () => leavePrompt({
    draft,
    opened,
    close: onClose,
    ask: (discard) => Alert.alert('Discard unsaved changes?', undefined, [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: discard },
    ]),
  })
  return (
    <Sheet open={open} title="Prompt" subtitle={title} onClose={leave}>
      <View style={styles.body}>
        {/* Save sits above the field, where the keyboard cannot cover it. */}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: empty }}
            disabled={empty}
            onPress={onSave}
            style={({ pressed }) => [styles.save, empty && styles.disabled, pressed && styles.pressed]}
          >
            <Text style={styles.saveLabel}>Save</Text>
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel="Prompt"
          maxLength={40_000}
          multiline
          onChangeText={onChange}
          selectionColor={colors.busy}
          style={styles.input}
          textAlignVertical="top"
          value={draft}
        />
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: spacing.sm, paddingHorizontal: spacing.lg },
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
  save: { minHeight: 34, justifyContent: 'center', borderRadius: radius.sm, ...squircle, backgroundColor: colors.text, paddingHorizontal: spacing.md },
  saveLabel: { color: colors.onPrimary, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  input: { flex: 1, borderRadius: radius.md, ...squircle, backgroundColor: colors.surface, padding: spacing.md, color: colors.text, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
})
