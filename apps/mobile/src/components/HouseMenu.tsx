import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon'
import Archive02Icon from '@hugeicons/core-free-icons/Archive02Icon'
import BookOpen01Icon from '@hugeicons/core-free-icons/BookOpen01Icon'
import CellsIcon from '@hugeicons/core-free-icons/CellsIcon'
import DashboardSpeed02Icon from '@hugeicons/core-free-icons/DashboardSpeed02Icon'
import Logout01Icon from '@hugeicons/core-free-icons/Logout01Icon'
import PuzzleIcon from '@hugeicons/core-free-icons/PuzzleIcon'
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import {
  Clock01Icon as Clock01SolidIcon,
  Archive02Icon as Archive02SolidIcon,
  BookOpen01Icon as BookOpen01SolidIcon,
  CellsIcon as CellsSolidIcon,
  DashboardSpeed02Icon as DashboardSpeed02SolidIcon,
  PuzzleIcon as PuzzleSolidIcon,
  Search01Icon as Search01SolidIcon,
} from '@manor/client-runtime/solid-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import { CRITICAL_AT, WARN_AT, displayPercent, peakUsed } from '@manor/client-runtime/usage'
import { router, useNavigationContainerRef, type Href } from 'expo-router'
import { Alert, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { hostName } from '@/lib/config'
import { openTabActions, resetTab } from '@/lib/tabNavigation'
import { useAuth } from '@/providers/AuthProvider'
import { useWorkspaceActions, useWorkspaceData, useWorkspaceStatus } from '@/providers/WorkspaceProvider'
import { AiBotHeadLookingIcon, AiBotHeadLookingSolidIcon } from '@/components/customIcons'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

export type HouseSection = 'inbox' | 'direct' | 'knowledge' | 'search' | 'routines' | 'plugins' | 'artifacts' | 'usage'

/** `tab` names the tab bar route a tab item switches to; a room opens by `href`. */
type Item = { key: HouseSection; label: string; icon: IconSvgElement; activeIcon: IconSvgElement; href: Href; tab?: string }

/**
 * A solid glyph takes no strokeWidth: the icon component would stroke every shape
 * in it, and that stroke closes the cut-outs (the Agents head lost its eyes).
 *
 * The four tabs first, in the tab bar's order, then the rooms that have no tab; the
 * solid glyph is worn only by the current one. Browser and Reminders are desktop
 * hosts, so the phone has no door for them.
 */
const ITEMS: Item[] = [
  { key: 'direct', label: 'Agents', icon: AiBotHeadLookingIcon, activeIcon: AiBotHeadLookingSolidIcon, href: '/agents', tab: '(agents)' },
  { key: 'inbox', label: 'Sessions', icon: CellsIcon, activeIcon: CellsSolidIcon, href: '/', tab: '(sessions)' },
  { key: 'knowledge', label: 'Knowledge', icon: BookOpen01Icon, activeIcon: BookOpen01SolidIcon, href: '/knowledge', tab: '(knowledge)' },
  { key: 'search', label: 'Search', icon: Search01Icon, activeIcon: Search01SolidIcon, href: '/search', tab: '(search)' },
  { key: 'artifacts', label: 'Artifacts', icon: Archive02Icon, activeIcon: Archive02SolidIcon, href: '/artifacts' },
  { key: 'routines', label: 'Scheduled tasks', icon: Clock01Icon, activeIcon: Clock01SolidIcon, href: '/routines' },
  { key: 'plugins', label: 'Plugins', icon: PuzzleIcon, activeIcon: PuzzleSolidIcon, href: '/plugins' },
]

/**
 * What sits behind a room when the page slides aside: the house's rooms, the Mac
 * this phone is the remote for, and the way out of the account.
 */
export function HouseMenu({ active, onClose }: { active: HouseSection; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  const auth = useAuth()
  const { signOut } = useWorkspaceActions()
  const { workspace } = useWorkspaceData()
  // As on the Mac's rail, Artifacts exists only where its host does. Still unknown keeps
  // the row, so it does not blink away while the Mac answers. Knowledge is a tab and
  // always stays; without a vault it says so.
  const items = ITEMS.filter((item) => item.key !== 'artifacts' || workspace.artifacts.status !== 'none')
  const status = useWorkspaceStatus()
  const navigation = useNavigationContainerRef()

  const pick = (item: Item) => {
    onClose()
    // A tab picked again still returns to its list, the way a second tap on the bar does.
    if (item.tab === undefined) {
      if (item.key !== active) openRoom(item.href, active)
    } else if (navigation.isReady()) {
      resetTab(item.tab)
      for (const action of openTabActions(navigation.getRootState(), item.tab)) navigation.dispatch(action)
    }
  }

  return (
    <View style={[styles.host, { paddingTop: insets.top + spacing.md, paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
      <View style={styles.head}>
        <Text style={styles.title}>Manor</Text>
        <View style={styles.hostRow}>
          <View style={[styles.dot, status === 'live' ? styles.dotLive : status === 'connecting' ? styles.dotConnecting : styles.dotOffline]} />
          <Text numberOfLines={1} style={styles.hostName}>{status === 'live' ? hostName : status === 'connecting' ? 'Connecting…' : 'Offline'}</Text>
        </View>
      </View>

      <View style={styles.items}>
        {items.map((item) => {
          const selected = item.key === active
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={item.key}
              onPress={() => pick(item)}
              style={({ pressed }) => [styles.item, selected && styles.itemActive, pressed && styles.pressed]}
            >
              <HugeiconsIcon color={selected ? colors.text : colors.muted} icon={selected ? item.activeIcon : item.icon} size={21} strokeWidth={selected ? undefined : 1.7} />
              <Text style={[styles.label, selected && styles.labelActive]}>{item.label}</Text>
            </Pressable>
          )
        })}
      </View>

      <View style={styles.spacer} />

      <UsageItem current={active} onClose={onClose} />

      {auth.enabled ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void signOut()
            .then(() => router.replace('/'))
            .catch(() => Alert.alert(
              'Sign-out failed',
              'Manor could not sign out safely. Check the connection to your Mac and try again.',
            ))}
          style={({ pressed }) => [styles.item, pressed && styles.pressed]}
        >
          <HugeiconsIcon color={colors.muted} icon={Logout01Icon} size={21} strokeWidth={1.7} />
          <Text style={styles.label}>Sign out</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** Rooms without a tab, which open inside the current tab's stack. */
const ROOMS = new Set<HouseSection>(['artifacts', 'routines', 'plugins', 'usage'])

/**
 * A room opens on top of the current tab, so the tab bar stays under it; picked from
 * another room it takes that room's place, because the way out of a room is this menu
 * or the tab bar, not a trail of rooms.
 */
function openRoom(href: Href, current: HouseSection) {
  if (ROOMS.has(current)) router.replace(href)
  else router.push(href)
}

/**
 * Not a room in the list but the house's subscription headroom, sitting with the
 * account acts at the bottom — the same footer position the row has on the Mac,
 * above the profile there and above sign-out here. It carries the fullest window
 * that is not yet full as its one ambient number, and no number before the first
 * reading. House 100% only when every returned window is full.
 */
function UsageItem({ current, onClose }: { current: HouseSection; onClose: () => void }) {
  const active = current === 'usage'
  const { workspace } = useWorkspaceData()
  const peak = peakUsed(workspace.providerUsage)
  const heat = peak === undefined ? 'normal' : peak >= CRITICAL_AT ? 'critical' : peak >= WARN_AT ? 'warn' : 'normal'

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => {
        onClose()
        if (!active) openRoom('/usage', current)
      }}
      style={({ pressed }) => [styles.item, active && styles.itemActive, pressed && styles.pressed]}
    >
      <HugeiconsIcon color={active ? colors.text : colors.muted} icon={active ? DashboardSpeed02SolidIcon : DashboardSpeed02Icon} size={21} strokeWidth={active ? undefined : 1.7} />
      <Text style={[styles.label, active && styles.labelActive]}>Usage</Text>
      {peak === undefined ? null : (
        <Text style={[styles.peak, { color: heat === 'critical' ? colors.danger : heat === 'warn' ? colors.warning : colors.muted }]}>
          {Math.max(0, 100 - displayPercent(peak))}% left
        </Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  host: { flex: 1, paddingHorizontal: spacing.md },
  head: { gap: 4, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: 28, letterSpacing: -0.6 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotLive: { backgroundColor: colors.ok },
  dotConnecting: { backgroundColor: colors.busy },
  dotOffline: { backgroundColor: colors.danger },
  hostName: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  items: { gap: 2 },
  item: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderRadius: radius.lg, ...squircle, paddingHorizontal: spacing.md },
  itemActive: { backgroundColor: colors.fill },
  label: { color: colors.muted, fontFamily: fonts.sans, fontSize: 17, fontWeight: '500' },
  labelActive: { color: colors.text },
  spacer: { flex: 1 },
  peak: { marginLeft: 'auto', fontFamily: fonts.sans, fontSize: 15, fontWeight: '500', fontVariant: ['tabular-nums'] },
  pressed: { opacity: 0.6 },
})
