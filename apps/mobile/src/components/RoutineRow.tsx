import type { ReactNode } from 'react'
import { SINGLE_CHAT_VOICE, driverForModel, type AgentConfig, type Routine } from '@manor/contracts'
import { calendarDaysUntil } from '@manor/client-runtime/scheduled'
import { StyleSheet, View } from 'react-native'

import { Blobatar } from '@/components/Blobatar'
import { ProviderMark } from '@/components/ProviderMark'
import { Text } from '@/components/Text'
import { colors, fonts, spacing } from '@/theme'

/**
 * One scheduled task: who answers, its name and what it does next or how it ended. The
 * Scheduled tasks room passes its Run now button as `children`; an agent's overview
 * lists her tasks without one.
 */
export function RoutineRow({ routine, agent, at, children }: {
  routine: Routine
  agent: AgentConfig | undefined
  /** The clock the row's moments are read against. */
  at: number
  children?: ReactNode
}) {
  return (
    <View style={[styles.row, !routine.enabled && routine.endState === null && styles.off]}>
      <RoutineFace agent={agent} routine={routine} />
      <View style={styles.copy}>
        <Text numberOfLines={1} style={styles.title}>{routine.name}</Text>
        <Text
          numberOfLines={2}
          style={[styles.description, (routine.endState === 'failed' || routine.endState === 'expired') && styles.failed]}
        >
          {routineLine(routine, at)}
        </Text>
      </View>
      {children}
    </View>
  )
}

/** Whether a task will still run by itself: on, and not yet ended. */
export const routineOn = (routine: Routine): boolean => routine.enabled && routine.endState === null

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
        finish={agent?.avatarFinish}
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
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  off: { opacity: 0.6 },
  face: { width: 28, alignItems: 'center' },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  description: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  failed: { color: colors.danger },
})
