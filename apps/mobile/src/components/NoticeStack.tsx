import Alert02Icon from '@hugeicons/core-free-icons/Alert02Icon'
import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon'
import DashboardSpeed01Icon from '@hugeicons/core-free-icons/DashboardSpeed01Icon'
import Rocket01Icon from '@hugeicons/core-free-icons/Rocket01Icon'
import TaskDone01Icon from '@hugeicons/core-free-icons/TaskDone01Icon'
import UserQuestion01Icon from '@hugeicons/core-free-icons/UserQuestion01Icon'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import { Fragment, useEffect, useSyncExternalStore } from 'react'
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { FullWindowOverlay } from 'react-native-screens'
import { isActionNotice, VISIBLE_NOTICES, type NoticeEntry, type NoticeKind, type NoticeTarget } from '@manor/client-runtime/notices'
import { glassRise, glassSink } from '@/lib/glassMotion'
import { noticeStore } from '@/lib/notices'
import { useWindowInsets } from '@/lib/windowInsets'
import { colors, fonts, radius, spacing } from '@/theme'
import { CardButton } from './CardButton'
import { GlassIconButton } from './GlassIconButton'
import { GlassSurface } from './GlassSurface'
import { Text } from './Text'

/** Chat news is read, not glanced at; an action's confirmation is shorter. */
const NEWS_VISIBLE_MS = 6_000
const ACTION_VISIBLE_MS = 3_500

/** A native sheet or modal draws above every React view; on iOS the stack gets a window of its own above them. Touches outside a card pass through. */
const AboveSheets = Platform.OS === 'ios' ? FullWindowOverlay : Fragment

const MARKS: Record<NoticeKind, { icon: IconSvgElement; color: typeof colors.ok }> = {
  done: { icon: CheckmarkCircle02Icon, color: colors.ok },
  ready: { icon: TaskDone01Icon, color: colors.ok },
  reply: { icon: BubbleChatIcon, color: colors.muted },
  waiting: { icon: UserQuestion01Icon, color: colors.warning },
  proposal: { icon: Rocket01Icon, color: colors.warning },
  failed: { icon: Alert02Icon, color: colors.danger },
  limit: { icon: DashboardSpeed01Icon, color: colors.warning },
  success: { icon: CheckmarkCircle02Icon, color: colors.ok },
  error: { icon: Alert02Icon, color: colors.danger },
}

/**
 * The phone's notice stack while the app is in front: the same news the Mac shows,
 * from the same shared gate, at the top of the screen under the status bar. Push
 * covers the background. Glass cards rise and sink rather than fade, because an
 * opacity ancestor turns the glass flat for good.
 */
export function NoticeStack({ onOpen }: { onOpen: (target: NoticeTarget) => void }) {
  const entries = useSyncExternalStore(noticeStore.subscribe, noticeStore.get, noticeStore.get)
  const insets = useWindowInsets()
  if (entries.length === 0) return null
  return (
    <AboveSheets>
      <View pointerEvents="box-none" style={[styles.stack, { top: insets.top + spacing.xs }]}>
        {entries.slice(0, VISIBLE_NOTICES).map((entry) => <NoticeCard key={entry.key} entry={entry} onOpen={onOpen} />)}
      </View>
    </AboveSheets>
  )
}

function NoticeCard({ entry, onOpen }: { entry: NoticeEntry; onOpen: (target: NoticeTarget) => void }) {
  const { key, kind, sticky, target } = entry
  useEffect(() => {
    if (sticky) return undefined
    const timer = setTimeout(() => noticeStore.dismiss(key), isActionNotice(kind) ? ACTION_VISIBLE_MS : NEWS_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [key, kind, sticky])
  const spoken = entry.body === '' ? entry.title : `${entry.title}. ${entry.body}`
  // Read out once as it lands, since a screen reader focused elsewhere would otherwise miss it before it goes.
  useEffect(() => AccessibilityInfo.announceForAccessibility(spoken), [key, spoken])
  const mark = MARKS[kind]
  // Usage is the header pill's own sheet rather than a place to go, so a limit has no Open.
  const opens = target !== null && ('chatId' in target || target.page === 'scheduled') ? target : null
  return (
    <Animated.View entering={glassRise} exiting={glassSink}>
      <GlassSurface radius={radius.panel} fallbackStyle={styles.fallback}>
        <View style={styles.row}>
          <HugeiconsIcon icon={mark.icon} size={20} color={mark.color} strokeWidth={1.8} />
          <View
            accessible
            accessibilityRole={kind === 'failed' || kind === 'error' || sticky ? 'alert' : 'summary'}
            accessibilityLabel={spoken}
            style={styles.text}
          >
            <Text numberOfLines={1} style={styles.title}>{entry.title}</Text>
            {entry.body === '' ? null : <Text numberOfLines={1} style={styles.body}>{entry.body}</Text>}
          </View>
          {opens === null ? null : (
            <CardButton label="Open" onPress={() => {
              noticeStore.dismiss(key)
              onOpen(opens)
            }} />
          )}
          <GlassIconButton accessibilityLabel="Dismiss" icon={Cancel01Icon} size={36} iconSize={16} onPress={() => noticeStore.dismiss(key)} />
        </View>
      </GlassSurface>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  stack: { position: 'absolute', left: spacing.md, right: spacing.md, gap: spacing.sm },
  // Where glass is missing: the solid raised card with a floating shadow, as the dock has.
  fallback: {
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: 6,
  },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingLeft: spacing.md, paddingRight: spacing.sm },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 15 },
  body: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
})
