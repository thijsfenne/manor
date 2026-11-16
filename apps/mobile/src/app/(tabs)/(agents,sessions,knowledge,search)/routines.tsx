import { useEffect, useState } from 'react'
import { SINGLE_CHAT_VOICE, driverForModel, type AgentConfig, type Routine } from '@manor/contracts'
import { calendarDaysUntil, DEFAULT_KIND, scheduledSections, type ScheduleKind } from '@manor/client-runtime/scheduled'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { Pressable, SectionList, StyleSheet, View } from 'react-native'
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated'

import { AuthGate } from '@/components/AuthGate'
import { Blobatar } from '@/components/Blobatar'
import { EmptyCard } from '@/components/EmptyCard'
import { ProviderMark } from '@/components/ProviderMark'
import { DisclosureChevron } from '@/components/DisclosureChevron'
import { SectionScaffold } from '@/components/SectionScaffold'
import { SegmentedControl } from '@/components/SegmentedControl'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { AnimatedText, Text } from '@/components/Text'
import { colors, fonts, radius, spacing } from '@/theme'

const now = () => Date.now()

export default function RoutinesScreen() {
  return <AuthGate><SectionScaffold title="Scheduled tasks"><RoutinesList /></SectionScaffold></AuthGate>
}

const KINDS = [{ value: 'recurring', label: 'Recurring' }, { value: 'once', label: 'Once' }] as const

/**
 * The scheduled work one kind at a time, as on the Mac: one-time tasks still to come
 * with the finished ones folded under Earlier, or the recurring routines. Each row that can
 * still run has a button to run it now. The
 * server confirms a start by flipping `runningSince` or by posting a notice; the
 * button waits on either and gives up after a while rather than spinning forever.
 */
function RoutinesList() {
  const { workspace, status, runRoutine } = useWorkspace()
  const [pending, setPending] = useState<{
    id: string
    lastRunAt: number | null
    requestId: string
    startedAt: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [earlierOpen, setEarlierOpen] = useState(false)
  const [pickedKind, setPickedKind] = useState<ScheduleKind | null>(null)
  const kind = pickedKind ?? DEFAULT_KIND
  // Once a minute, so a failure leaves Upcoming after its day and Today rolls over
  // without waiting for some other update.
  const [clock, setClock] = useState(now)
  useEffect(() => {
    const timer = setInterval(() => setClock(now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const split = scheduledSections(workspace.routines, clock)
  // Only Earlier has a header; it keeps it while folded, so its rows are one tap away.
  const sections = (kind === 'recurring'
    ? [{ key: 'recurring', data: split.recurring, count: split.recurring.length }]
    : [
      { key: 'upcoming', data: split.upcoming, count: split.upcoming.length },
      { key: 'earlier', data: earlierOpen ? split.earlier : [], count: split.earlier.length },
    ]).filter((section) => section.count > 0)

  // The server confirms a start by flipping the routine and refuses it with a
  // notice; both settle in the render that sees them. The effect below is only
  // the give-up timer.
  const pendingRoutine = pending === null ? undefined : workspace.routines.find((entry) => entry.id === pending.id)
  if (pending !== null && (pendingRoutine === undefined || pendingRoutine.runningSince !== null || pendingRoutine.lastRunAt !== pending.lastRunAt)) {
    setPending(null)
  } else if (pending !== null && workspace.notice?.requestId === pending.requestId) {
    setError(workspace.notice.text)
    setPending(null)
  }
  if (pending !== null && status !== 'live') {
    setError('The connection dropped before Manor confirmed the task.')
    setPending(null)
  }

  useEffect(() => {
    if (pending === null) return
    const remaining = Math.max(0, 8_000 - (now() - pending.startedAt))
    const timeout = setTimeout(() => {
      setError('Manor did not confirm this task started.')
      setPending(null)
    }, remaining)
    return () => clearTimeout(timeout)
  }, [pending])

  const run = (routineId: string) => {
    const routine = workspace.routines.find((entry) => entry.id === routineId)
    if (routine === undefined) return
    setError(null)
    const requestId = runRoutine(routineId)
    if (requestId !== null) {
      setPending({ id: routineId, lastRunAt: routine.lastRunAt, requestId, startedAt: now() })
    } else {
      setError('Manor could not send the request. Try again.')
    }
  }

  return (
    <SectionList
      contentContainerStyle={styles.list}
      sections={sections}
      stickySectionHeadersEnabled={false}
      ItemSeparatorComponent={() => <View style={styles.gap} />}
      keyExtractor={(routine) => routine.id}
      renderSectionHeader={({ section }) => section.key === 'earlier' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: earlierOpen }}
          onPress={() => setEarlierOpen((open) => !open)}
          style={({ pressed }) => [styles.sectionHeader, pressed && styles.pressed]}
        >
          <DisclosureChevron open={earlierOpen}>
            <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={16} strokeWidth={1.7} />
          </DisclosureChevron>
          <Text style={styles.sectionTitle}>Earlier</Text>
          <Text style={styles.sectionCount}>{section.count}</Text>
        </Pressable>
      ) : null}
      ListEmptyComponent={
        !workspace.hasRoutines ? <Text style={styles.loading}>Loading scheduled work…</Text>
          : kind === 'once' ? <EmptyCard title="Nothing coming up" body="Ask an agent in a direct message to remind you or check something later." />
          : <EmptyCard title="Nothing recurring yet" body="Set up a prompt an agent answers on a repeating schedule." />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          {workspace.hasRoutines ? (
            <SegmentedControl label="Task type" options={KINDS} value={kind} onChange={setPickedKind} />
          ) : null}
          <Text style={styles.intro}>Run tasks on a schedule or whenever you need them.</Text>
          {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        </View>
      }
      renderItem={({ item }) => {
        const busy = pending?.id === item.id
        const running = item.runningSince !== null
        const actionLabel = busy ? 'Starting…' : running ? 'Running' : 'Run now'
        return (
          <View style={[styles.row, !item.enabled && item.endState === null && styles.off]}>
            <RoutineFace agent={workspace.agents.find((agent) => agent.id === item.agentId)} routine={item} />
            <View style={styles.copy}>
              <Text numberOfLines={1} style={styles.title}>{item.name}</Text>
              <Text
                numberOfLines={2}
                style={[styles.description, (item.endState === 'failed' || item.endState === 'expired') && styles.failed]}
              >
                {routineLine(item, clock)}
              </Text>
            </View>
            {item.enabled && item.endState === null ? (
              <Pressable
                accessibilityRole="button"
                disabled={status !== 'live' || busy || running}
                onPress={() => run(item.id)}
                style={({ pressed }) => [styles.action, (status !== 'live' || busy || running) && styles.disabled, pressed && styles.pressed]}
              >
                <AnimatedText
                  entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)}
                  exiting={FadeOut.duration(80).reduceMotion(ReduceMotion.System)}
                  key={actionLabel}
                  style={styles.actionText}
                >
                  {actionLabel}
                </AnimatedText>
              </Pressable>
            ) : null}
          </View>
        )
      }}
    />
  )
}

/**
 * Who answers, as on the Mac's row: the persona's face, or for a Single run the mark
 * of the provider its model belongs to.
 */
function RoutineFace({ routine, agent }: { routine: Routine; agent: AgentConfig | undefined }) {
  if (routine.agentId === SINGLE_CHAT_VOICE.id) {
    const driver = driverForModel(routine.model ?? '')
    return <View style={styles.face}>{driver === undefined ? null : <ProviderMark driver={driver} size={20} />}</View>
  }
  return (
    <View style={styles.face}>
      <Blobatar
        color={agent?.color ?? ''}
        name={agent?.name ?? routine.agentId}
        shape={agent?.avatarShape}
        size={28}
        src={agent?.avatar}
        tone={agent?.avatarTone}
      />
    </View>
  )
}

const MOMENT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const ENDED = { done: 'Done', failed: 'Failed', expired: 'Expired, did not run', cancelled: 'Cancelled' } as const

/** `Today 10:00`, `Tomorrow 10:00`, otherwise the full moment, all in the phone's zone. */
function when(ts: number, at: number): string {
  const days = calendarDaysUntil(ts, at)
  if (days === 0) return `Today ${CLOCK.format(new Date(ts))}`
  if (days === 1) return `Tomorrow ${CLOCK.format(new Date(ts))}`
  return MOMENT.format(new Date(ts))
}

/** What a row says under its name: a one-time task's kind and moment or how it ended, else as before. */
function routineLine(routine: Routine, at: number): string {
  if (routine.runAt === null) return routine.enabled ? routine.description || routine.cron : 'Off'
  const kind = routine.action === 'remind' ? 'Reminder' : 'Check'
  if (routine.endState !== null) return `${kind}, ${ENDED[routine.endState]}, ${when(routine.endedAt ?? routine.runAt, at)}`
  return routine.enabled ? `${kind}, ${when(routine.runAt, at)}` : `${kind}, Off, ${when(routine.runAt, at)}`
}

const styles = StyleSheet.create({
  list: { padding: spacing.lg, paddingBottom: 48 },
  header: { gap: spacing.md, paddingBottom: spacing.lg },
  intro: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  off: { opacity: 0.6 },
  face: { width: 28, alignItems: 'center' },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  description: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  action: { minWidth: 96, minHeight: 34, alignItems: 'center', justifyContent: 'center', borderRadius: radius.round, backgroundColor: colors.surface2, paddingHorizontal: spacing.md },
  actionText: { color: colors.text, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  gap: { height: spacing.xs },
  sectionHeader: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.md, paddingBottom: spacing.xs, paddingHorizontal: spacing.xs },
  sectionTitle: { flex: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  sectionCount: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, fontVariant: ['tabular-nums'] },
  failed: { color: colors.danger },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  loading: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
})
