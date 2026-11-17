import { CheckmarkCircle02Icon as CheckmarkCircleSolidIcon } from '@manor/client-runtime/solid-icons'
import AlertCircleIcon from '@hugeicons/core-free-icons/AlertCircleIcon'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import DashedLineCircleIcon from '@hugeicons/core-free-icons/DashedLineCircleIcon'
import LoaderCircleIcon from '@hugeicons/core-free-icons/LoaderCircleIcon'
import MinusSignCircleIcon from '@hugeicons/core-free-icons/MinusSignCircleIcon'
import PauseCircleIcon from '@hugeicons/core-free-icons/PauseCircleIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { foldsWhenDone, isTaskFolded, planRowKeys, planStanding, planTitle, subscribeTaskFolds, toggleTaskFolded, type TaskLine } from '@manor/client-runtime/state'
import { useEffect, useId, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition, ReduceMotion, cancelAnimation, useAnimatedProps, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'

import { DisclosureChevron } from '@/components/DisclosureChevron'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

const SAID = { completed: 'Done', in_progress: 'In progress', paused: 'Paused', pending: 'To do', blocked: 'Blocked', skipped: 'Skipped' } as const

const SAID_PLAN = { working: 'In progress', paused: 'Paused', blocked: 'Blocked', stopped: 'Stopped', done: 'Done' } as const

/**
 * The card's motion: its steps fold in and out as a list, a revised plan's new step
 * fades in where it lands and a dropped one fades out, and the rest, card included,
 * settle to their new size and place on one curve.
 */
const FADE_IN = FadeIn.duration(180).reduceMotion(ReduceMotion.System)
const FADE_OUT = FadeOut.duration(120).reduceMotion(ReduceMotion.System)
const SETTLE = LinearTransition.duration(220).easing(Easing.out(Easing.exp)).reduceMotion(ReduceMotion.System)

/**
 * A tasks card, the Mac's TodoList: the latest plan a turn published, or the steps
 * Confirm asked for. The header names the whole task (`title` when the caller knows it,
 * as Confirm does, else read off the plan's own steps), wears one mark for the list and counts the finished lines;
 * pressing it folds the steps away. A finished card starts folded and folds when its last step is ticked; a choice the user made stays. One line per task; only a finished one wears a solid glyph.
 */
export function TaskCard({ tasks, label = 'Tasks', title, foldKey }: { tasks: readonly TaskLine[]; label?: string; title?: string; foldKey?: string }) {
  const instance = useId()
  const key = foldKey ?? instance
  const byDefault = foldsWhenDone(tasks)
  const collapsed = useSyncExternalStore(subscribeTaskFolds, () => isTaskFolded(key, byDefault))
  if (tasks.length === 0) return null
  const standing = planStanding(tasks)
  const keys = planRowKeys(tasks)
  const heading = title ?? planTitle(tasks)
  return (
    <Animated.View
      accessibilityLabel={label}
      layout={SETTLE}
      style={styles.card}
    >
      <Pressable
        accessibilityLabel={`${SAID_PLAN[standing.mark]}. ${heading}. ${standing.done} of ${standing.total} done`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
        onPress={() => toggleTaskFolded(key, byDefault)}
        style={styles.header}
      >
        <View style={styles.mark}><HeaderMark standing={standing} /></View>
        <Text numberOfLines={1} style={styles.heading}>{heading}</Text>
        <Text style={styles.count}>{standing.done}/{standing.total}</Text>
        <DisclosureChevron open={!collapsed}>
          <HugeiconsIcon color={colors.muted} icon={ArrowDown01Icon} size={16} strokeWidth={1.8} />
        </DisclosureChevron>
      </Pressable>
      {collapsed ? null : (
        <Animated.View
          entering={FADE_IN}
          exiting={FADE_OUT}
          style={styles.list}
        >
          {/* Rows already there when the steps unfold arrive with the list; only a revised plan
              adds one alone. No skipExiting: it wraps each row and would mute a single removal. */}
          <LayoutAnimationConfig skipEntering>
            {tasks.map((task, index) => (
              <Animated.View
                accessibilityLabel={`${SAID[task.status]}. ${task.text}`}
                accessible
                entering={FADE_IN}
                exiting={FADE_OUT}
                key={keys[index]}
                layout={SETTLE}
                style={styles.row}
              >
                <View style={styles.mark}><Mark status={task.status} /></View>
                <Text style={[styles.text, (task.status === 'completed' || task.status === 'skipped') && styles.done]}>{task.text}</Text>
              </Animated.View>
            ))}
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </Animated.View>
  )
}

const RING_RADIUS = 9.5
const RING_LENGTH = 2 * Math.PI * RING_RADIUS
const AnimatedCircle = Animated.createAnimatedComponent(Circle)

/**
 * The header's mark: a ring that fills as steps finish (1/4, 2/4, ...). It never spins;
 * the current step already does. A finished plan swaps it for the same round check its
 * steps wear, and blocked keeps its alert, since a fraction cannot say a step is stuck.
 */
function HeaderMark({ standing }: { standing: ReturnType<typeof planStanding> }) {
  const fraction = standing.total === 0 ? 0 : standing.done / standing.total
  const progress = useSharedValue(fraction)
  useEffect(() => {
    progress.set(withTiming(fraction, { duration: 400, easing: Easing.out(Easing.exp), reduceMotion: ReduceMotion.System }))
  }, [fraction, progress])
  const arc = useAnimatedProps(() => ({
    strokeDashoffset: RING_LENGTH * (1 - progress.get()),
    strokeOpacity: progress.get() > 0 ? 1 : 0,
  }))
  if (standing.mark === 'blocked') return <HugeiconsIcon color={colors.danger} icon={AlertCircleIcon} size={15} strokeWidth={1.8} />
  if (standing.mark === 'done') return <HugeiconsIcon color={colors.text} icon={CheckmarkCircleSolidIcon} size={15} strokeWidth={0} />
  return (
    <Svg height={15} style={styles.ring} viewBox="0 0 24 24" width={15}>
      <Circle cx={12} cy={12} fill="none" r={RING_RADIUS} stroke={colors.dim} strokeOpacity={0.4} strokeWidth={3} />
      <AnimatedCircle
        animatedProps={arc}
        cx={12}
        cy={12}
        fill="none"
        r={RING_RADIUS}
        stroke={standing.mark === 'stopped' ? colors.muted : colors.text}
        strokeDasharray={`${RING_LENGTH} ${RING_LENGTH}`}
        strokeLinecap="round"
        strokeWidth={3}
      />
    </Svg>
  )
}

function Mark({ status }: { status: TaskLine['status'] }) {
  if (status === 'in_progress') return <Spinner />
  // The step in progress while its turn compacts: still the current step, but still.
  if (status === 'paused') return <HugeiconsIcon color={colors.muted} icon={PauseCircleIcon} size={15} strokeWidth={1.8} />
  if (status === 'completed') return <HugeiconsIcon color={colors.muted} icon={CheckmarkCircleSolidIcon} size={15} strokeWidth={0} />
  if (status === 'blocked') return <HugeiconsIcon color={colors.danger} icon={AlertCircleIcon} size={15} strokeWidth={1.8} />
  // A plan step its turn ended without ticking: over, so muted, but never a check.
  if (status === 'skipped') return <HugeiconsIcon color={colors.muted} icon={MinusSignCircleIcon} size={15} strokeWidth={1.8} />
  return <HugeiconsIcon color={colors.muted} icon={DashedLineCircleIcon} size={15} strokeWidth={1.8} />
}

/** The in-progress mark every phone card shares: one turn of the loader every 1.5s. */
export function Spinner({ size = 15 }: { size?: number }) {
  const turn = useSharedValue(0)
  useEffect(() => {
    turn.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.linear, reduceMotion: ReduceMotion.System }), -1)
    return () => cancelAnimation(turn)
  }, [turn])
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }))
  return (
    <Animated.View style={spin}>
      <HugeiconsIcon color={colors.text} icon={LoaderCircleIcon} size={size} strokeWidth={1.8} />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  card: {
    gap: 6,
    borderRadius: radius.md,
    ...squircle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  ring: { transform: [{ rotate: '-90deg' }] },
  heading: { flex: 1, color: colors.text, fontFamily: fonts.sansMedium, fontSize: 14, lineHeight: 20 },
  count: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 20, fontVariant: ['tabular-nums'] },
  list: { gap: 6, paddingTop: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  mark: { height: 20, justifyContent: 'center' },
  text: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18 },
  done: { color: colors.muted },
})
