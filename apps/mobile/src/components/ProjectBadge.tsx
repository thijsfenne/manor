import FolderOffIcon from '@hugeicons/core-free-icons/FolderOffIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { Project } from '@manor/contracts'
import { ProjectMark } from './ProjectMark'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { Text } from './Text'
import { colors, fonts, radius, spacing } from '@/theme'

/** The project identity shared by Session cards and chat headers. */
export function ProjectBadge({ name, icon, color, iconSrc, letters, noProject = false, style }: Pick<Project, 'name' | 'icon' | 'color'> & { iconSrc?: string | undefined; letters?: string | undefined; noProject?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.badge, { backgroundColor: noProject ? colors.surface2 : `${color}29` }, style]}>
      {noProject ? <HugeiconsIcon color={colors.muted} icon={FolderOffIcon} size={12} strokeWidth={1.8} /> : <ProjectMark color={color} icon={icon} letters={letters} size={12} src={iconSrc} />}
      <Text numberOfLines={1} style={styles.name}>{noProject ? 'No project' : name}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderRadius: radius.xs, paddingLeft: spacing.xs, paddingRight: 6, paddingVertical: 1 },
  name: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
})
