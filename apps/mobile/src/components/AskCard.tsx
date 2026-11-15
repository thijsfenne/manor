import { USER_INPUT_ANSWER_MAX, type UserInputAnswers } from '@manor/contracts'
import type { OpenAsk } from '@manor/client-runtime/state'
import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { FadingScrollView } from '@/components/FadingScrollView'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

interface Draft {
  selected: string[]
  custom: string
}

export function AskCard({
  ask,
  onAnswer,
  onStop,
  advice,
  onCancel,
}: {
  ask: OpenAsk
  onAnswer: (answers: UserInputAnswers) => boolean
  onStop?: () => void
  /** In a project thread: the thread's pick and why, under the first question. */
  advice?: { by: string; text: string }
  /**
   * Set when nothing waits on this card, such as replacing an answer already given: the
   * header closes it instead of stopping a turn, and a question left open stays as it was.
   */
  onCancel?: () => void
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  // A fresh ask clears the drafts; adjusted in render, so the card and the ask
  // never disagree for a frame.
  const [activeRequest, setActiveRequest] = useState(ask.requestId)
  // A replacement is sent once: the card stays until the thread records it, and a second
  // tap meanwhile would change it twice. Cancel still closes it after a refusal.
  const [sent, setSent] = useState(false)
  if (activeRequest !== ask.requestId) {
    setActiveRequest(ask.requestId)
    setDrafts({})
    setSent(false)
  }

  const answers = useMemo<UserInputAnswers | null>(() => {
    const result: UserInputAnswers = {}
    for (const question of ask.questions) {
      const draft = drafts[question.id] ?? { selected: [], custom: '' }
      const custom = draft.custom.trim()
      if (question.multi) {
        const picked = [...draft.selected, ...(custom === '' ? [] : [custom])]
        if (picked.length > 0) result[question.id] = picked
        else if (onCancel === undefined) return null
      } else {
        const answer = custom === '' ? draft.selected[0] : custom
        if (answer !== undefined && answer !== '') result[question.id] = answer
        else if (onCancel === undefined) return null
      }
    }
    return Object.keys(result).length === 0 ? null : result
  }, [ask.questions, drafts, onCancel])

  const pick = (questionId: string, label: string, multi: boolean) => {
    setDrafts((current) => {
      const draft = current[questionId] ?? { selected: [], custom: '' }
      const selected = multi
        ? draft.selected.includes(label)
          ? draft.selected.filter((value) => value !== label)
          : [...draft.selected, label]
        : [label]
      return { ...current, [questionId]: { ...draft, selected, custom: multi ? draft.custom : '' } }
    })
  }

  // A card whose approval acts on the Mac, such as filling a saved login into its
  // browser, is shown here but answered there.
  const macOnly = ask.questions.some((question) => question.desktopOnly === true)

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.title}>{onCancel === undefined ? 'Your choice' : 'Change answer'}</Text>
        {onCancel === undefined && onStop === undefined ? null : (
          <Pressable accessibilityRole="button" onPress={onCancel ?? onStop} style={({ pressed }) => [styles.stop, pressed && styles.pressed]}>
            <Text style={onCancel === undefined ? styles.stopText : styles.cancelText}>{onCancel === undefined ? 'Stop' : 'Cancel'}</Text>
          </Pressable>
        )}
      </View>
      <FadingScrollView containerStyle={styles.scroll} contentContainerStyle={styles.questions} keyboardShouldPersistTaps="handled">
        {ask.questions.map((question, index) => {
          const draft = drafts[question.id] ?? { selected: [], custom: '' }
          return (
            <View key={question.id} style={styles.question}>
              {question.header === undefined ? null : <Text style={styles.questionHeader}>{question.header}</Text>}
              <Text style={styles.questionText}>{question.question}</Text>
              {index === 0 && advice !== undefined ? (
                <Text style={styles.advice}><Text style={styles.adviceBy}>{advice.by} suggests </Text>{advice.text}</Text>
              ) : null}
              {macOnly ? null : <View style={styles.options}>
                {question.options.map((option) => {
                  const selected = draft.selected.includes(option.label)
                  return (
                    <Pressable
                      accessibilityRole="button"
                      key={option.label}
                      onPress={() => pick(question.id, option.label, question.multi === true)}
                      style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.pressed]}
                    >
                      <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{option.label}</Text>
                      {option.description === undefined ? null : <Text style={styles.optionDescription}>{option.description}</Text>}
                    </Pressable>
                  )
                })}
              </View>}
              {/* A permission card has no free line: allowing a call is a decision its
                  options already hold, and a typed answer only reads as a refusal. */}
              {question.optionsOnly === true || macOnly ? null : (
                <TextInput
                  // The wire's own limit. A longer answer is a frame the server drops without a word.
                  maxLength={USER_INPUT_ANSWER_MAX}
                  onChangeText={(custom) => setDrafts((current) => ({
                    ...current,
                    [question.id]: {
                      selected: question.multi ? (current[question.id]?.selected ?? []) : [],
                      custom,
                    },
                  }))}
                  placeholder="Type your own answer here"
                  placeholderTextColor={colors.dim}
                  style={styles.custom}
                  value={draft.custom}
                />
              )}
            </View>
          )
        })}
      </FadingScrollView>
      {macOnly ? <Text style={styles.macOnly}>This can only be approved on your Mac.</Text> : (
        <Pressable
          accessibilityRole="button"
          disabled={answers === null || sent}
          onPress={() => {
            if (answers !== null && !sent && onAnswer(answers) && onCancel !== undefined) setSent(true)
          }}
          style={({ pressed }) => [styles.submit, (answers === null || sent) && styles.disabled, pressed && styles.pressed]}
        >
          <Text style={styles.submitText}>Send</Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { maxHeight: 470, gap: spacing.md, borderRadius: radius.composer, ...squircle, backgroundColor: colors.raised, padding: spacing.lg },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  title: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 20, fontWeight: '500' },
  stop: { minHeight: 38, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.sm, ...squircle, backgroundColor: colors.fill },
  stopText: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  cancelText: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  // Shrinks between the header and the answer button when the questions run long.
  scroll: { flexShrink: 1 },
  questions: { gap: spacing.lg },
  question: { gap: spacing.sm },
  questionHeader: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  questionText: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, lineHeight: 22 },
  advice: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  adviceBy: { color: colors.text, fontWeight: '500' },
  options: { gap: spacing.sm },
  option: { gap: 2, borderRadius: radius.md, ...squircle, backgroundColor: colors.surface, padding: spacing.md },
  optionSelected: { backgroundColor: colors.text },
  optionLabel: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  optionLabelSelected: { color: colors.onPrimary },
  optionDescription: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  custom: { minHeight: 44, borderRadius: radius.md, ...squircle, backgroundColor: colors.surface, color: colors.text, fontFamily: fonts.sans, letterSpacing: tracking.small, paddingHorizontal: spacing.md },
  submit: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, ...squircle, backgroundColor: colors.text },
  submitText: { color: colors.onPrimary, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  macOnly: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
})
