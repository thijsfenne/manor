import { useSegments } from 'expo-router'
import { NativeTabs } from 'expo-router/unstable-native-tabs'
import { useMemo, useState } from 'react'
import type { ImageSourcePropType } from 'react-native'

import { ConnectGate } from '@/components/ConnectGate'
import { Drawer } from '@/components/Drawer'
import { HouseMenu, type HouseSection } from '@/components/HouseMenu'
import { HouseDrawerContext } from '@/lib/houseDrawer'
import { colors } from '@/theme'

/**
 * The HugeIcons glyphs as template images, rendered by `scripts/generate-tab-icons.mjs`:
 * the native bar takes images, not React components. The line glyph at rest, the
 * solid one on the current tab, both tinted by the bar.
 */
const ICONS = {
  agents: { default: require('../../../assets/images/tab-icons/agents.png'), selected: require('../../../assets/images/tab-icons/agents-selected.png') },
  sessions: { default: require('../../../assets/images/tab-icons/sessions.png'), selected: require('../../../assets/images/tab-icons/sessions-selected.png') },
  knowledge: { default: require('../../../assets/images/tab-icons/knowledge.png'), selected: require('../../../assets/images/tab-icons/knowledge-selected.png') },
  search: { default: require('../../../assets/images/tab-icons/search.png'), selected: require('../../../assets/images/tab-icons/search-selected.png') },
} satisfies Record<string, { default: ImageSourcePropType; selected: ImageSourcePropType }>

const ROOMS = new Set<string>(['artifacts', 'routines', 'plugins'] satisfies HouseSection[])
/** The screens that wear the menu button: each tab's root and the rooms. */
const MENU_SCREENS = new Set<string>([...ROOMS, '(agents)', 'sessions', 'knowledge', 'search'])
const TAB_SECTIONS: Record<string, HouseSection> = {
  '(agents)': 'direct',
  '(sessions)': 'inbox',
  '(knowledge)': 'knowledge',
  '(search)': 'search',
}

/**
 * The house: the system tab bar (Liquid Glass from iOS 26, the classic bar before it,
 * Material on Android) with its four tabs, and the house menu behind all of it. The
 * menu wraps the tab bar rather than living in each room, so opening it slides the
 * whole page, bar included, and every room reaches the same menu.
 */
export default function TabsLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const segments: string[] = useSegments()
  // A room from the menu is the current section while it is on top; otherwise the tab is.
  const leaf = segments.at(-1) ?? ''
  const active: HouseSection = ROOMS.has(leaf) ? (leaf as HouseSection) : (TAB_SECTIONS[segments[1] ?? ''] ?? 'direct')
  // Everywhere else the left edge is the native back swipe, so the menu stays put.
  const swipeOpens = MENU_SCREENS.has(leaf)
  const drawer = useMemo(() => ({ open: menuOpen, setOpen: setMenuOpen }), [menuOpen])

  return (
    <ConnectGate>
      <HouseDrawerContext.Provider value={drawer}>
        <Drawer
          menu={<HouseMenu active={active} onClose={() => setMenuOpen(false)} />}
          onOpenChange={setMenuOpen}
          open={menuOpen}
          swipeEnabled={swipeOpens}
        >
          {/* A room is no tab, so the bar leaves while one is on top; its menu button is the way out. */}
          <NativeTabs
            hidden={ROOMS.has(leaf)}
            iconColor={{ default: colors.muted, selected: colors.text }}
            labelStyle={{ default: { color: colors.muted }, selected: { color: colors.text } }}
          >
            <NativeTabs.Trigger disableAutomaticContentInsets name="(agents)">
              <NativeTabs.Trigger.Icon renderingMode="template" src={ICONS.agents} />
              <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>
            <NativeTabs.Trigger disableAutomaticContentInsets name="(sessions)">
              <NativeTabs.Trigger.Icon renderingMode="template" src={ICONS.sessions} />
              <NativeTabs.Trigger.Label>Sessions</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>
            <NativeTabs.Trigger disableAutomaticContentInsets name="(knowledge)">
              <NativeTabs.Trigger.Icon renderingMode="template" src={ICONS.knowledge} />
              <NativeTabs.Trigger.Label>Knowledge</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>
            <NativeTabs.Trigger disableAutomaticContentInsets name="(search)">
              <NativeTabs.Trigger.Icon renderingMode="template" src={ICONS.search} />
              <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>
          </NativeTabs>
        </Drawer>
      </HouseDrawerContext.Provider>
    </ConnectGate>
  )
}
