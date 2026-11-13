import { useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useAuth } from '@/providers/AuthProvider'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!auth.ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    )
  }

  if (!auth.enabled || auth.session !== null) return children

  const submit = async () => {
    if (email.trim() === '' || password === '') return
    setSubmitting(true)
    setError(null)
    const nextError = await auth.signIn(email.trim(), password)
    setError(nextError)
    setSubmitting(false)
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <SafeAreaView style={styles.signIn}>
        <View style={styles.heading}>
          <Text style={styles.title}>Welcome home</Text>
          <Text style={styles.subtitle}>Sign in with the same account as on your Mac.</Text>
        </View>
        <View style={styles.form}>
          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor={colors.dim}
            style={styles.input}
            value={email}
          />
          <TextInput
            autoCapitalize="none"
            autoComplete="current-password"
            onChangeText={setPassword}
            onSubmitEditing={() => void submit()}
            placeholder="Password"
            placeholderTextColor={colors.dim}
            secureTextEntry
            style={styles.input}
            value={password}
          />
          {error === null ? null : <Text style={styles.error}>{error}</Text>}
          <Pressable
            accessibilityRole="button"
            disabled={submitting || email.trim() === '' || password === ''}
            onPress={() => void submit()}
            style={({ pressed }) => [styles.button, pressed && styles.pressed, submitting && styles.disabled]}
          >
            {submitting ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.buttonText}>Sign in</Text>}
          </Pressable>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  signIn: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: 40, backgroundColor: colors.background },
  heading: { gap: spacing.sm },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: 30, letterSpacing: -0.7 },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 16, lineHeight: 23 },
  form: { gap: spacing.md },
  input: {
    minHeight: 52,
    borderRadius: radius.md,
    ...squircle,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 16,
    letterSpacing: tracking.body,
    paddingHorizontal: spacing.lg,
  },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  button: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    ...squircle,
    backgroundColor: colors.text,
  },
  buttonText: { color: colors.onPrimary, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
})
