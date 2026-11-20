import { Pressable, StyleSheet, View } from 'react-native'
import { TextInput } from '@/components/TextInput'

import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/**
 * The task a session proposal will start from, read in full and edited before Accept.
 * The card owns the draft; close discards it and Save hands it back to the card.
 * Nothing reaches the server until Accept.
 */
export function WorkPromptSheet({ open, title, draft, onChange, onSave, onClose }: {
  open: boolean
  title: string
  draft: string
  onChange: (draft: string) => void
  onSave: () => void
  onClose: () => void
}) {
  const empty = draft.trim().length === 0
  return (
    <Sheet open={open} title="Prompt" subtitle={title} onClose={onClose}>
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
