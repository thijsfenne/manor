import { secretCardNote, type UserInputQuestion } from '@manor/contracts'
import { useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { KeyboardController } from 'react-native-keyboard-controller'

import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

/**
 * The private card behind `request_secret`. The value stays in this field's state and is
 * emptied when it is sent. Autofill and the keyboard's suggestions stay off on purpose:
 * the system must not offer saved logins here or learn what was typed. `oneTimeCode` is
 * what removes iOS's Passwords bar from a secure field; `none` leaves it up.
 */
export function SecretCard({
  question,
  who,
  onAnswer,
  onStop,
}: {
  question: UserInputQuestion
  who: string
  /** No value declines. False when the socket did not take it. */
  onAnswer: (value?: string) => boolean
  onStop?: () => void
}) {
  const destination = question.secret
  const [value, setValue] = useState('')
  const [sent, setSent] = useState(false)
  const [failed, setFailed] = useState(false)
  const answered = useRef(false)
  if (destination === undefined) return null

  const answer = async (given?: string) => {
    if (answered.current) return
    answered.current = true
    setFailed(false)
    // The keyboard goes first: this card can close the moment the answer lands, and the
    // transcript loses its place when a tall footer and the keyboard leave together.
    await KeyboardController.dismiss()
    const taken = onAnswer(given)
    setValue('')
    if (taken) setSent(true)
    else {
      answered.current = false
      setFailed(true)
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.heading}>
          <Text style={styles.who}>{who} asks for a secret</Text>
          <Text style={styles.label}>{question.header}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onStop} style={({ pressed }) => [styles.stop, pressed && styles.pressed]}>
          <Text style={styles.stopText}>Stop</Text>
        </Pressable>
      </View>
      <Text style={styles.reason}>{question.question}</Text>
      {destination.target === 'command' ? (
        <ScrollView style={styles.command} keyboardShouldPersistTaps="handled">
          <Text style={styles.commandText}>{destination.command}</Text>
        </ScrollView>
      ) : null}
      <Text style={styles.note}>{secretCardNote(destination)}</Text>
      <TextInput
        accessibilityLabel={question.header ?? 'Secret value'}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        editable={!sent}
        importantForAutofill="no"
        onChangeText={setValue}
        placeholder="Enter the value"
        placeholderTextColor={colors.dim}
        secureTextEntry
        spellCheck={false}
        style={styles.field}
        textContentType="oneTimeCode"
        value={value}
      />
      {failed ? <Text style={styles.failed}>Could not send. Try again.</Text> : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={sent}
          onPress={() => void answer()}
          style={({ pressed }) => [styles.decline, sent && styles.disabled, pressed && styles.pressed]}
        >
          <Text style={styles.declineText}>Decline</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={sent || value === ''}
          onPress={() => void answer(value)}
          style={({ pressed }) => [styles.submit, (sent || value === '') && styles.disabled, pressed && styles.pressed]}
        >
          <Text style={styles.submitText}>{sent ? 'Using it once' : 'Use once'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { maxHeight: 470, gap: spacing.md, borderRadius: radius.composer, ...squircle, backgroundColor: colors.raised, padding: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  heading: { flex: 1, gap: 2 },
  who: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  label: { color: colors.text, fontFamily: fonts.sans, fontSize: 20, fontWeight: '500' },
  stop: { minHeight: 38, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.sm, ...squircle, backgroundColor: colors.fill },
  stopText: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  reason: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, lineHeight: 22 },
  command: { maxHeight: 96, borderRadius: radius.md, ...squircle, backgroundColor: colors.fill, padding: spacing.md },
  commandText: { color: colors.text, fontFamily: fonts.mono, fontSize: 12, lineHeight: 17 },
  note: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  field: { minHeight: 44, borderRadius: radius.md, ...squircle, backgroundColor: colors.fill, color: colors.text, fontFamily: fonts.sans, letterSpacing: tracking.small, paddingHorizontal: spacing.md },
  failed: { color: colors.danger, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  decline: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, ...squircle, backgroundColor: colors.fill },
  declineText: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  submit: { flex: 2, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, ...squircle, backgroundColor: colors.text },
  submitText: { color: colors.onPrimary, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
})
