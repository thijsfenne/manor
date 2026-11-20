import { USER_INPUT_ANSWER_MAX, type UserInputAnswers } from '@manor/contracts'
import type { OpenAsk } from '@manor/client-runtime/state'
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { TextInput } from '@/components/TextInput'
import Animated, { Easing, FadeInLeft, FadeInRight, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

import { CardButton } from '@/components/CardButton'
import { FadingScrollView } from '@/components/FadingScrollView'
import { GlassSurface } from '@/components/GlassSurface'
import { Text } from '@/components/Text'
import { answerOf, draftOf, FIRST_STEP, pickAdvances, reduceAsk, type AskAction } from '@/lib/askSteps'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

/**
 * Long enough that the row you tapped shows as picked before the card moves on, short
 * enough that three questions still feel like three taps.
 */
const ADVANCE_MS = 160
const STEP_MS = 200
const STEP_EASING = Easing.out(Easing.exp)

/**
 * The question an agent is blocked on, one step at a time. Tapping an option answers
 * and moves on; the free line and the last step need Next or Send. Skip passes one
 * question. Every step's answer goes out together when the last step is left.
 */
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
   * header closes it instead of stopping a turn, and Skip reads Keep, leaving that
   * question as it was.
   */
  onCancel?: () => void
}) {
  const [steps, setSteps] = useState(FIRST_STEP)
  // A fresh ask starts over; adjusted in render, so the card and the ask never
  // disagree for a frame.
  const [activeRequest, setActiveRequest] = useState(ask.requestId)
  // Stop and Cancel stay usable after a send, so a refused answer never strands the turn.
  const [sent, setSent] = useState(false)
  if (activeRequest !== ask.requestId) {
    setActiveRequest(ask.requestId)
    setSteps(FIRST_STEP)
    setSent(false)
  }

  const advanceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearAdvance = () => {
    if (advanceRef.current === null) return
    clearTimeout(advanceRef.current)
    advanceRef.current = null
  }
  useEffect(() => clearAdvance, [ask.requestId])

  const questions = ask.questions
  const keep = onCancel !== undefined
  const total = questions.length
  const question = questions[Math.min(steps.step, total - 1)]
  const last = steps.step >= total - 1

  // The card's height follows the step's content, so a question with two options and one
  // with four swap in place instead of jumping. Unset until the first layout.
  const bodyHeight = useSharedValue(-1)
  const bodyStyle = useAnimatedStyle(() => (bodyHeight.get() < 0 ? {} : { height: bodyHeight.get() }))

  if (question === undefined) return null

  const draft = draftOf(steps, question.id)
  const ready = answerOf(question, draft) !== null && !sent

  const act = (action: AskAction) => {
    clearAdvance()
    const result = reduceAsk(questions, keep, steps, action)
    setSteps(result.steps)
    if (result.send === null) {
      // Every question kept on a card that only replaces answers: nothing changes.
      if (keep && last && action.kind === 'skip') onCancel()
      return
    }
    // Locked once the socket takes it: the card stays until the thread records the answer,
    // and a second tap meanwhile would answer twice.
    if (!sent && onAnswer(result.send)) setSent(true)
  }

  const pick = (label: string) => {
    act({ kind: 'pick', label })
    if (!pickAdvances(question, last, keep)) return
    const from = steps.step
    advanceRef.current = setTimeout(() => {
      advanceRef.current = null
      // Only if the card still shows the question that was answered.
      setSteps((current) => (current.step === from ? reduceAsk(questions, keep, current, { kind: 'next' }).steps : current))
    }, ADVANCE_MS)
  }

  // A card whose approval acts on the Mac, such as filling a saved login into its
  // browser, is shown here but answered there.
  const macOnly = questions.some((item) => item.desktopOnly === true)
  const stepped = total > 1
  const entering = (steps.forward ? FadeInRight : FadeInLeft).duration(STEP_MS).easing(STEP_EASING).reduceMotion(ReduceMotion.System)

  return (
    // Glass outermost, never inside a Pressable or a fading parent, or it renders flat.
    <GlassSurface radius={radius.composer} style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.titleLine}>
          <Text style={styles.title}>{onCancel === undefined ? 'Your choice' : 'Change answer'}</Text>
          {stepped ? <Text style={styles.stepCount}>{`${steps.step + 1}/${total}`}</Text> : null}
        </View>
        {onCancel === undefined && onStop === undefined ? null : (
          <CardButton label={onCancel === undefined ? 'Stop' : 'Cancel'} onPress={() => (onCancel ?? onStop)?.()} variant="secondary" />
        )}
      </View>
      {/* Keyed by step, so each question opens scrolled to its top with fresh edge fades. */}
      <FadingScrollView key={question.id} containerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Animated.View style={[styles.clip, bodyStyle]}>
          <View
            onLayout={(event) => {
              const height = event.nativeEvent.layout.height
              bodyHeight.set(bodyHeight.get() < 0
                ? height
                : withTiming(height, { duration: STEP_MS, easing: STEP_EASING, reduceMotion: ReduceMotion.System }))
            }}
          >
            <Animated.View entering={stepped ? entering : undefined} style={styles.question}>
              {question.header === undefined ? null : <Text style={styles.questionHeader}>{question.header}</Text>}
              <Text style={styles.questionText}>{question.question}</Text>
              {steps.step === 0 && advice !== undefined ? (
                <Text style={styles.advice}><Text style={styles.adviceBy}>{advice.by} suggests </Text>{advice.text}</Text>
              ) : null}
              {macOnly ? null : <View style={styles.options}>
                {question.options.map((option) => {
                  const selected = draft.selected.includes(option.label)
                  const description = option.description?.trim() || undefined
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={option.label}
                      onPress={() => pick(option.label)}
                      style={({ pressed }) => [styles.option, description !== undefined && styles.optionWithDescription, selected && styles.optionSelected, pressed && styles.pressed]}
                    >
                      <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{option.label}</Text>
                      {description === undefined ? null : <Text style={[styles.optionDescription, selected && styles.optionLabelSelected]}>{description}</Text>}
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
                  onChangeText={(text) => act({ kind: 'type', text })}
                  placeholder="Type your own answer here"
                  placeholderTextColor={colors.dim}
                  // A single question keeps Return as it was: it only closes the keyboard.
                  {...(stepped ? {
                    onSubmitEditing: () => { if (ready) act({ kind: 'next' }) },
                    returnKeyType: last ? 'send' : 'next',
                  } as const : {})}
                  style={styles.custom}
                  value={draft.custom}
                />
              )}
            </Animated.View>
          </View>
        </Animated.View>
      </FadingScrollView>
      {macOnly ? <Text style={styles.macOnly}>This can only be approved on your Mac.</Text> : (
        <View style={styles.actions}>
          <View style={styles.actionRow}>
            {stepped && steps.step > 0 ? <CardButton label="Back" disabled={sent} onPress={() => act({ kind: 'back' })} style={styles.grow} variant="secondary" /> : null}
            <CardButton
              disabled={!ready}
              label={last ? 'Send' : 'Next'}
              onPress={() => act({ kind: 'next' })}
              style={styles.grow}
              variant="primary"
            />
          </View>
          {stepped ? <CardButton label={keep ? 'Keep' : 'Skip'} disabled={sent} onPress={() => act({ kind: 'skip' })} style={styles.skip} variant="quiet" /> : null}
        </View>
      )}
    </GlassSurface>
  )
}

const styles = StyleSheet.create({
  card: { maxHeight: 470, gap: spacing.md, padding: spacing.lg },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  titleLine: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 20, fontWeight: '500' },
  stepCount: { color: colors.dim, fontFamily: fonts.sans, fontSize: 15, fontVariant: ['tabular-nums'] },
  // Shrinks between the header and the answer button when a question runs long.
  scroll: { flexShrink: 1 },
  clip: { overflow: 'hidden' },
  question: { gap: spacing.sm },
  questionHeader: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  questionText: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, lineHeight: 22 },
  advice: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  adviceBy: { color: colors.text, fontWeight: '500' },
  options: { gap: spacing.sm },
  option: { gap: 2, borderRadius: radius.md, ...squircle, backgroundColor: colors.chip, padding: spacing.md },
  // Two lines already give the row its height, so it takes less air above and below.
  optionWithDescription: { paddingVertical: spacing.sm },
  optionSelected: { backgroundColor: colors.text },
  optionLabel: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  optionLabelSelected: { color: colors.onPrimary },
  // The label's own colour, softened, so it reads on the plain and the picked fill alike.
  optionDescription: { color: colors.text, opacity: 0.7, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  // A fixed height, so iOS centres the line and its placeholder. The line sits low in it;
  // the bottom padding lifts the letters to the optical middle.
  custom: { height: 44, borderRadius: radius.md, ...squircle, backgroundColor: colors.chip, color: colors.text, fontFamily: fonts.sans, fontSize: 15, letterSpacing: tracking.small, paddingHorizontal: spacing.md, paddingTop: 0, paddingBottom: 7 },
  macOnly: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  actions: { gap: spacing.xs },
  actionRow: { flexDirection: 'row', gap: spacing.sm },
  skip: { alignSelf: 'center' },
  grow: { flex: 1 },
  pressed: { opacity: 0.7 },
})
