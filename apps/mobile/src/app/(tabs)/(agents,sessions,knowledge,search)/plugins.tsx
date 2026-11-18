import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { composioLogoUrl, type WorkflowSuggestion, type McpServerConfig, type SkillConfig } from '@manor/contracts'
import {
  ACTIVE,
  OCCURRENCE_BAR,
  WATCHING,
  byWeight,
  occurrenceCount,
  statusStamp,
} from '@manor/client-runtime/suggestions'
import BoxIcon from '@hugeicons/core-free-icons/BoxIcon'
import CancelCircleIcon from '@hugeicons/core-free-icons/CancelCircleIcon'
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon'
import Flag02Icon from '@hugeicons/core-free-icons/Flag02Icon'
import PlugSocketIcon from '@hugeicons/core-free-icons/PlugSocketIcon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import { Image } from 'expo-image'
import { ScrollView, StyleSheet, View } from 'react-native'

import { ConnectGate } from '@/components/ConnectGate'
import { appLabel } from '@/components/ConnectCards'
import { EmptyCard } from '@/components/EmptyCard'
import { SectionScaffold } from '@/components/SectionScaffold'
import { SegmentedControl } from '@/components/SegmentedControl'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

export default function PluginsScreen() {
  return <ConnectGate><SectionScaffold title="Plugins"><PluginsRoom /></SectionScaffold></ConnectGate>
}

type PluginSection = 'connectors' | 'skills' | 'suggestions'

/** The Mac's three Plugins tabs, in its order and with its labels. */
const SECTIONS = [
  { value: 'connectors', label: 'Connectors' },
  { value: 'skills', label: 'Skills' },
  { value: 'suggestions', label: 'Suggestions' },
] as const satisfies readonly { value: PluginSection; label: string }[]

const INTRO: Record<PluginSection, string> = {
  connectors: 'The external tools available to Manor and its agents.',
  skills: 'Reusable instructions your agents can call on.',
  suggestions: 'Repeated workflows that could become skills.',
}

/**
 * What the Mac offers its personas, read-only: connectors, skills and the skill
 * suggestions, one tab at a time as on the Mac. Adding, importing and deciding stay
 * on the desktop, so every row here only states what is there.
 */
function PluginsRoom() {
  const [section, setSection] = useState<PluginSection>('connectors')
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.head}>
        <SegmentedControl fill label="Plugin section" options={SECTIONS} value={section} onChange={setSection} />
        <Text style={styles.intro}>{INTRO[section]}</Text>
      </View>
      {section === 'connectors' ? <Connectors /> : section === 'skills' ? <Skills /> : <Suggestions />}
    </ScrollView>
  )
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })

/**
 * The Mac's own connectors, then the Composio apps connected on it, read from the
 * composio row the phone already has. Browsing and connecting stay on the Mac.
 */
function Connectors() {
  const { workspace } = useWorkspace()
  const servers = useMemo(() => [...workspace.mcpServers].sort(byName), [workspace.mcpServers])
  const apps = workspace.mcpServers.find((server) => server.name === 'composio')?.connectedApps ?? []
  if (servers.length === 0) {
    return <EmptyCard title="No connectors yet" body="Add a server in Plugins on your Mac." />
  }
  return (
    <View style={styles.rows}>
      {servers.map((server) => <ConnectorRow key={server.id} server={server} />)}
      {apps.map((app) => (
        <PluginRow
          key={`composio-${app.toolkit}`}
          mark={<Image source={composioLogoUrl(app.toolkit)} style={styles.logo} contentFit="contain" />}
          title={appLabel(app.toolkit)}
          description={app.aliases.length === 0 ? 'Composio' : `Composio, ${app.aliases.join(', ')}`}
        />
      ))}
    </View>
  )
}

function ConnectorRow({ server }: { server: McpServerConfig }) {
  return (
    <PluginRow
      icon={PlugSocketIcon}
      title={server.name}
      chip={server.unavailable === undefined ? undefined : 'Unavailable'}
      description={server.unavailable ?? (server.description || 'No description yet')}
    />
  )
}

function Skills() {
  const { workspace } = useWorkspace()
  const skills = useMemo(() => [...workspace.skills].sort(byName), [workspace.skills])
  if (skills.length === 0) {
    return <EmptyCard title="No skills yet" body="Import skills in Plugins on your Mac." />
  }
  return <View style={styles.rows}>{skills.map((skill) => <SkillRow key={skill.id} skill={skill} />)}</View>
}

function SkillRow({ skill }: { skill: SkillConfig }) {
  return (
    <PluginRow
      icon={BoxIcon}
      iconColor={colors.skill}
      title={skill.name}
      description={skill.description || 'No description yet'}
      trailing={skill.usageCount === undefined ? undefined : (
        <Text style={styles.meta}>{skill.usageCount} {skill.usageCount === 1 ? 'use' : 'uses'}</Text>
      )}
    />
  )
}

/** One connector or skill at list depth: its glyph on a tile, the name, one fact under it. */
function PluginRow({
  icon,
  mark,
  iconColor = colors.muted,
  title,
  chip,
  description,
  trailing,
}: {
  icon?: IconSvgElement
  /** A brand mark drawn on the tile instead of a glyph, such as a Composio app's logo. */
  mark?: ReactNode
  iconColor?: typeof colors.muted
  title: string
  /** A problem worth flagging beside the name, in the danger colour. */
  chip?: string
  description: string
  trailing?: ReactNode
}) {
  return (
    <View accessible style={styles.row}>
      <View style={styles.tile}>
        {mark ?? (icon === undefined ? null : <HugeiconsIcon color={iconColor} icon={icon} size={20} strokeWidth={1.7} />)}
      </View>
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={styles.title}>{title}</Text>
          {chip === undefined ? null : (
            <Text style={styles.chip}>{chip}</Text>
          )}
        </View>
        <Text numberOfLines={2} style={styles.description}>{description}</Text>
      </View>
      {trailing}
    </View>
  )
}

const GROUPS: readonly { key: string; label: string; icon: IconSvgElement; holds: (status: WorkflowSuggestion['status']) => boolean }[] = [
  { key: 'decide', label: 'Needs a decision', icon: Flag02Icon, holds: (status) => ACTIVE.has(status) },
  { key: 'watching', label: 'Watching', icon: ViewIcon, holds: (status) => WATCHING.has(status) },
  { key: 'history', label: 'History', icon: Clock01Icon, holds: (status) => !ACTIVE.has(status) && !WATCHING.has(status) },
]

const statusLabel = (status: WorkflowSuggestion['status']): string =>
  status === 'existing-skill' ? 'Existing skill' : status.charAt(0).toUpperCase() + status.slice(1)

/** Row copy has two lines to work with, so markdown marks would spend them on syntax. */
const squash = (text: string): string => text.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim()

/**
 * The candidate ledger in the Mac's three groups, loudest first. The ledger is
 * asked for when the tab opens, as the Mac does; a phone that connects later asks
 * again once the socket is live.
 */
function Suggestions() {
  const { workspace, status, listWorkflowSuggestions } = useWorkspace()
  const ledger = workspace.workflowSuggestions
  useEffect(() => {
    if (status === 'live') listWorkflowSuggestions()
  }, [status, listWorkflowSuggestions])

  const groups = useMemo(
    () => GROUPS
      .map((group) => ({ ...group, candidates: (ledger?.suggestions ?? []).filter((entry) => group.holds(entry.status)).sort(byWeight) }))
      .filter((group) => group.candidates.length > 0),
    [ledger],
  )

  if (ledger === null) {
    return <EmptyCard title={status === 'live' ? 'Loading suggestions…' : 'No suggestions yet'} body={status === 'live' ? 'Reading the candidate ledger on your Mac.' : 'They show up once the connection to your Mac is back.'} />
  }
  if (!ledger.available) {
    return <EmptyCard title="No memory folder on this host" body="Suggestions are read from the memory folder on the Mac." />
  }
  if (groups.length === 0) {
    return <EmptyCard idea title="No suggestions yet" body="No recurring workflow is on record." />
  }
  return (
    <View style={styles.groups}>
      {groups.map((group) => (
        <View accessibilityLabel={group.label} key={group.key} style={styles.group}>
          <View style={styles.groupHead}>
            <HugeiconsIcon color={colors.dim} icon={group.icon} size={13} strokeWidth={1.7} />
            <Text style={styles.groupLabel}>{group.label}</Text>
            <Text style={styles.groupCount}>{group.candidates.length}</Text>
          </View>
          {group.candidates.map((candidate) => <SuggestionRow key={candidate.id} suggestion={candidate} />)}
        </View>
      ))}
    </View>
  )
}

function SuggestionRow({ suggestion }: { suggestion: WorkflowSuggestion }) {
  const decidable = ACTIVE.has(suggestion.status) || WATCHING.has(suggestion.status)
  return (
    <View style={styles.suggestion}>
      <View style={styles.copy}>
        <Text numberOfLines={1} style={styles.title}>{suggestion.name}</Text>
        <Text numberOfLines={2} style={styles.description}>{squash(suggestion.description)}</Text>
      </View>
      {decidable ? <Tally count={occurrenceCount(suggestion.occurrences)} /> : <Outcome suggestion={suggestion} />}
    </View>
  )
}

/**
 * Progress toward the three-times bar, the Mac's tally. Filled dots are sightings;
 * the skill violet is the bar being cleared, and past three the count is spelled out.
 */
function Tally({ count }: { count: number | undefined }) {
  if (count === undefined) return <Text style={styles.meta}>Not counted</Text>
  const cleared = count >= OCCURRENCE_BAR
  const filled = Math.min(count, OCCURRENCE_BAR)
  return (
    <View accessible accessibilityLabel={`${count} of ${OCCURRENCE_BAR} occurrences`} style={styles.tally}>
      {Array.from({ length: OCCURRENCE_BAR }, (_, index) => (
        <View
          key={index}
          style={[styles.tallyDot, index < filled ? { backgroundColor: cleared ? colors.skill : colors.muted } : styles.tallyEmpty]}
        />
      ))}
      {count > OCCURRENCE_BAR ? <Text style={styles.meta}>{count}</Text> : null}
    </View>
  )
}

/** History has no progress left to show, so the slot carries the outcome instead. */
function Outcome({ suggestion }: { suggestion: WorkflowSuggestion }) {
  const date = statusStamp(suggestion.statusDetail)?.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return (
    <View style={styles.outcome}>
      {suggestion.status === 'shipped' ? <HugeiconsIcon color={colors.ok} icon={Tick02Icon} size={13} strokeWidth={1.8} /> : null}
      {suggestion.status === 'dismissed' ? <HugeiconsIcon color={colors.dim} icon={CancelCircleIcon} size={13} strokeWidth={1.8} /> : null}
      <Text style={styles.meta}>{date ?? statusLabel(suggestion.status)}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, paddingBottom: 48 },
  head: { gap: spacing.md, paddingBottom: spacing.lg },
  intro: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  rows: { gap: spacing.xs, marginHorizontal: -spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm },
  logo: { width: 22, height: 22 },
  tile: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, ...squircle, backgroundColor: colors.surface },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500' },
  chip: { flexShrink: 0, color: colors.danger, fontFamily: fonts.sans, fontSize: 12 },
  description: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  meta: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, fontVariant: ['tabular-nums'] },
  groups: { gap: spacing.lg },
  group: { gap: 2 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: spacing.xs },
  groupLabel: { flex: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  groupCount: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, fontVariant: ['tabular-nums'] },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  tally: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tallyDot: { width: 6, height: 6, borderRadius: radius.round },
  tallyEmpty: { backgroundColor: colors.chip },
  outcome: { flexDirection: 'row', alignItems: 'center', gap: 5 },
})
