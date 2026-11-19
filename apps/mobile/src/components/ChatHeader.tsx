import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import ArrowLeftRightIcon from '@hugeicons/core-free-icons/ArrowLeftRightIcon'
import AtomicPowerIcon from '@hugeicons/core-free-icons/AtomicPowerIcon'
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon'
import CheckListIcon from '@hugeicons/core-free-icons/CheckListIcon'
import Files01Icon from '@hugeicons/core-free-icons/Files01Icon'
import { projectIcon } from '@manor/client-runtime/project-icons'
import { isHomeRoom, knownAgentIds, type SessionsDot } from '@manor/client-runtime/state'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { AgentConfig, DriverName, Project } from '@manor/contracts'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AgentStack } from '@/components/AgentStack'
import { AiBotHeadLookingIcon } from '@/components/customIcons'
import { Blobatar } from '@/components/Blobatar'
import { EdgeScrim } from '@/components/EdgeScrim'
import { GlassIconButton } from '@/components/GlassIconButton'
import { GlassPressable } from '@/components/GlassPressable'
import { GlassGroup } from '@/components/GlassSurface'
import { ProviderMark } from '@/components/ProviderMark'
import { ProjectBadge } from '@/components/ProjectBadge'
import { SessionsDotMark } from '@/components/SessionsDotMark'
import { Text } from '@/components/Text'
import { colors, fonts, spacing } from '@/theme'

/** The control row's height under the status bar, which the transcript pads for. */
export const CHAT_HEADER_HEIGHT = 60

interface ChatHeaderProps {
  title: string
  subtitle: string
  project?: Project
  /**
   * A project's curated thread (2026-10-10): the room's own icon and name are the
   * title, with no badge, since the badge would only repeat the name beside it.
   */
  projectThread?: boolean
  /** The provider behind the line under the title, as its mark: a DM's or a Single Session's, or nothing. */
  driver?: DriverName
  /** Who has a seat in the chat, most recent first. Empty until someone has spoken. */
  agentIds: readonly string[]
  agents: AgentConfig[]
  /** A view-only pair thread's two speakers, each face beside its own name in the title. */
  pair?: readonly AgentConfig[]
  onBack: () => void
  /** Absent in a view-only pair thread, where the faces identify speakers but expose no controls. */
  onAgents?: () => void
  /** A Session's subagents; absent until there is one, which drops the button with it. DMs and project threads never pass it. */
  onSubagents?: () => void
  /** How many of them are working, as the dot on that button. */
  subagentsRunning?: number
  /** A project thread's Sessions, on their own screen: the Mac shows them beside the thread. */
  onSessions?: () => void
  /** What the project's Sessions are up to, as the dot on that button; null for nothing. */
  sessionsDot?: SessionsDot | null
  /** A project thread's settings, from its pill: the Mac's Edit project. */
  onProject?: () => void
  /** Settles an open Session, as the Mac's Settle; absent for a settled chat and anything that is not a Session. */
  onSettle?: () => void
  /**
   * A DM's one persona. Her face, name and role sit in the middle and open her overview;
   * her files sit on the right. Title, subtitle, role and driver are not drawn then.
   */
  dm?: { agent: AgentConfig; onOverview: () => void; onFiles: () => void }
}

/**
 * The chat's own header, drawn over the transcript rather than above it: back on the
 * left, the title with where the chat lives under it, and on the right the faces of
 * everyone in the room and, for a chat with a folder, the folder itself. The scrim
 * behind it is what lets the transcript slide under without going unread.
 */
/** The dot is a picture, so the button says the same in words; the base name stays the handle. */
function sessionsLabel(dot: SessionsDot | null): string {
  const base = 'Sessions of this project'
  if (dot === 'waiting') return `${base}, needs you`
  if (dot === 'finished') return `${base}, new result`
  if (dot === 'working') return `${base}, working`
  return base
}

export function ChatHeader({ title, subtitle, project, projectThread = false, driver, agentIds: participants, agents, pair, onBack, onAgents, onSubagents, subagentsRunning = 0, onSessions, sessionsDot = null, onProject, onSettle, dm }: ChatHeaderProps) {
  // Only personas who still exist get a face; a room of deleted ones shows the bot mark.
  const agentIds = knownAgentIds(agents, participants)
  const threadMark = projectThread && project !== undefined ? project : undefined
  const insets = useSafeAreaInsets()
  const subagents = onSubagents === undefined ? null : (
    <View>
      <GlassIconButton accessibilityLabel={subagentsRunning === 0 ? 'Subagents' : `Subagents, ${subagentsRunning} running`} icon={AtomicPowerIcon} onPress={onSubagents} />
      {subagentsRunning === 0 ? null : <SessionsDotMark dot="working" />}
    </View>
  )

  // A project thread speaks as the room (2026-10-12): back to Sessions, the room's own
  // pill in the middle, which opens its settings, and its Sessions on the right. No
  // faces, as on the Mac, since the thread is persona-less.
  if (threadMark !== undefined) {
    return (
      <View pointerEvents="box-none" style={styles.host}>
        <EdgeScrim edge="top" height={insets.top + CHAT_HEADER_HEIGHT + 28} />
        <View pointerEvents="box-none" style={[styles.row, { paddingTop: insets.top + 6 }]}>
          <GlassIconButton accessibilityLabel="Back to Sessions" icon={ArrowLeft01Icon} onPress={onBack} />
          <View pointerEvents="box-none" style={styles.centre}>
            <GlassPressable
              accessibilityLabel={`${threadMark.name}, project settings`}
              disabled={onProject === undefined}
              fallbackStyle={styles.floatingFallback}
              hitSlop={6}
              onPress={() => onProject?.()}
              radius={22}
              style={styles.pill}
            >
              <View style={styles.projectPill}>
                <HugeiconsIcon color={threadMark.color} icon={projectIcon(threadMark.icon)} size={18} strokeWidth={1.8} />
                <Text numberOfLines={1} style={styles.pillName}>{threadMark.name}</Text>
              </View>
            </GlassPressable>
          </View>
          <GlassGroup spacing={8} style={styles.cluster}>
            {subagents}
            {onSessions === undefined ? <View style={styles.round} /> : (
              <View>
                <GlassIconButton accessibilityLabel={sessionsLabel(sessionsDot)} icon={CheckListIcon} onPress={onSessions} />
                {sessionsDot === null ? null : <SessionsDotMark dot={sessionsDot} />}
              </View>
            )}
          </GlassGroup>
        </View>
      </View>
    )
  }

  // A DM is one persona (2026-11-19): her face, name and role in the middle open her
  // overview, and her files sit on the right. The model stays on the composer's chip.
  if (dm !== undefined) {
    const { agent } = dm
    return (
      <View pointerEvents="box-none" style={styles.host}>
        <EdgeScrim edge="top" height={insets.top + CHAT_HEADER_HEIGHT + 28} />
        <View pointerEvents="box-none" style={[styles.row, { paddingTop: insets.top + 6 }]}>
          <GlassIconButton accessibilityLabel="Back" icon={ArrowLeft01Icon} onPress={onBack} />
          <View pointerEvents="box-none" style={styles.centre}>
            <GlassPressable
              accessibilityLabel={agent.role === '' ? `${agent.name}, overview` : `${agent.name}, ${agent.role}, overview`}
              fallbackStyle={styles.floatingFallback}
              hitSlop={6}
              onPress={dm.onOverview}
              radius={22}
              style={styles.pill}
            >
              <View style={styles.agentPill}>
                <Blobatar color={agent.color} name={agent.name} shape={agent.avatarShape} tone={agent.avatarTone} size={28} src={agent.avatar} />
                <Text numberOfLines={1} style={styles.pillName}>{agent.name}</Text>
                {agent.role === '' ? null : <Text numberOfLines={1} style={styles.pillRole}>{agent.role}</Text>}
              </View>
            </GlassPressable>
          </View>
          <GlassIconButton accessibilityLabel="Files" icon={Files01Icon} onPress={dm.onFiles} />
        </View>
      </View>
    )
  }

  return (
    <View pointerEvents="box-none" style={styles.host}>
      <EdgeScrim edge="top" height={insets.top + CHAT_HEADER_HEIGHT + 28} />
      <View pointerEvents="box-none" style={[styles.row, { paddingTop: insets.top + 6 }]}>
        <GlassIconButton accessibilityLabel="Back" icon={ArrowLeft01Icon} onPress={onBack} />

        <View pointerEvents="none" style={styles.titles}>
          <View style={styles.identity}>
            {pair === undefined ? <Text numberOfLines={1} style={styles.title}>{title}</Text> : pair.map((member, index) => (
              <View key={member.id} style={styles.pairMember}>
                {index === 0 ? null : <HugeiconsIcon color={colors.dim} icon={ArrowLeftRightIcon} size={16} strokeWidth={1.8} />}
                <Blobatar color={member.color} name={member.name} shape={member.avatarShape} tone={member.avatarTone} size={22} src={member.avatar} />
                <Text numberOfLines={1} style={styles.title}>{member.name}</Text>
              </View>
            ))}
            {project === undefined ? null : <ProjectBadge name={project.name} icon={project.icon} color={project.color} noProject={isHomeRoom(project.id)} style={styles.projectBadge} />}
          </View>
          <View style={styles.under}>
            {driver === undefined ? null : <ProviderMark driver={driver} size={12} />}
            <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text>
          </View>
        </View>

        <GlassGroup spacing={8} style={styles.cluster}>
          {pair !== undefined || (onAgents === undefined && agentIds.length === 0) ? null : onAgents === undefined ? (
            <View style={styles.pairFaces}>
              <AgentStack agentIds={agentIds} agents={agents} size={30} />
            </View>
          ) : (
            <GlassPressable
              accessibilityLabel="Agents in this chat"
              fallbackStyle={styles.floatingFallback}
              fill={agentIds.length === 0}
              hitSlop={6}
              onPress={onAgents}
              radius={22}
              style={agentIds.length === 0 ? styles.round : styles.pill}
            >
              <View style={styles.pillInner}>
                {agentIds.length === 0 ? (
                  <HugeiconsIcon color={colors.text} icon={AiBotHeadLookingIcon} size={21} strokeWidth={1.7} />
                ) : (
                  <AgentStack agentIds={agentIds} agents={agents} size={30} />
                )}
              </View>
            </GlassPressable>
          )}
          {subagents}
          {onSettle === undefined ? null : <GlassIconButton accessibilityLabel={`Settle ${title}`} icon={CheckmarkCircle02Icon} onPress={onSettle} />}
        </GlassGroup>
      </View>

    </View>
  )
}

const styles = StyleSheet.create({
  host: { position: 'absolute', top: 0, right: 0, left: 0, zIndex: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg },
  round: { width: 44, height: 44 },
  pill: { height: 44 },
  pillInner: { height: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  pairFaces: { height: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  floatingFallback: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 6,
  },
  titles: { flex: 1, minWidth: 0, gap: 3 },
  identity: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pairMember: { flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  // Under half the row, as on the desktop: a long project name leaves the title readable.
  projectBadge: { maxWidth: '45%' },
  title: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 17, fontWeight: '500', letterSpacing: -0.2 },
  under: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
  subtitle: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  cluster: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  centre: { flex: 1, minWidth: 0, alignItems: 'center' },
  projectPill: { height: 44, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg },
  pillName: { flexShrink: 1, color: colors.text, fontFamily: fonts.sansMedium, fontSize: 16, letterSpacing: -0.2 },
  // Name and role as two elements, the role muted: the design system joins no labels with a dot.
  agentPill: { height: 44, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: spacing.sm, paddingRight: spacing.lg },
  pillRole: { flexShrink: 2, color: colors.muted, fontFamily: fonts.sans, fontSize: 15, letterSpacing: -0.2 },
})
