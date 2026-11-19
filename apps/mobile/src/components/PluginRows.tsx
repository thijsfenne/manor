import type { ReactNode } from 'react'
import type { McpServerConfig, SkillConfig } from '@manor/contracts'
import BoxIcon from '@hugeicons/core-free-icons/BoxIcon'
import PlugSocketIcon from '@hugeicons/core-free-icons/PlugSocketIcon'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import { StyleSheet, View } from 'react-native'

import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/** Sorts connectors, skills and apps the way every read-only list on the phone shows them. */
export const byName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })

/** One MCP server, read-only: Plugins lists the house's, an agent's overview the ones she holds. */
export function ConnectorRow({ server }: { server: McpServerConfig }) {
  return (
    <PluginRow
      icon={PlugSocketIcon}
      title={server.name}
      chip={server.unavailable === undefined ? undefined : 'Unavailable'}
      description={server.unavailable ?? (server.description || 'No description yet')}
    />
  )
}

export function SkillRow({ skill }: { skill: SkillConfig }) {
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
export function PluginRow({
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

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm },
  tile: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, ...squircle, backgroundColor: colors.surface },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500' },
  chip: { flexShrink: 0, color: colors.danger, fontFamily: fonts.sans, fontSize: 12 },
  description: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  meta: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, fontVariant: ['tabular-nums'] },
})
