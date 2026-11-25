import Alert02Icon from '@hugeicons/core-free-icons/Alert02Icon'
import Brain02Icon from '@hugeicons/core-free-icons/Brain02Icon'
import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon'
import DashboardSpeed01Icon from '@hugeicons/core-free-icons/DashboardSpeed01Icon'
import GitMergeIcon from '@hugeicons/core-free-icons/GitMergeIcon'
import RefreshIcon from '@hugeicons/core-free-icons/RefreshIcon'
import Rocket01Icon from '@hugeicons/core-free-icons/Rocket01Icon'
import TaskDone01Icon from '@hugeicons/core-free-icons/TaskDone01Icon'
import UserQuestion01Icon from '@hugeicons/core-free-icons/UserQuestion01Icon'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import { Fragment, useEffect, useSyncExternalStore } from 'react'
import { AccessibilityInfo, Platform, Pressable, StyleSheet, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { FullWindowOverlay } from 'react-native-screens'
import { actionNotice, isActionNotice, VISIBLE_NOTICES, type NoticeEntry, type NoticeKind, type NoticeTarget } from '@manor/client-runtime/notices'
import { glassRise, glassSink } from '@/lib/glassMotion'
import { noticeStore } from '@/lib/notices'
import { useWindowInsets } from '@/lib/windowInsets'
import { useWorkspaceActions, useWorkspaceData } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing } from '@/theme'
import { Blobatar } from './Blobatar'
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
  memory: { icon: Brain02Icon, color: colors.muted },
  merged: { icon: GitMergeIcon, color: colors.ok },
  reopened: { icon: RefreshIcon, color: colors.muted },
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
  const { key, kind, sticky, target, undo } = entry
  const { undoMemoryWrite } = useWorkspaceActions()
  const face = useWorkspaceData().workspace.agents.find((agent) => agent.id === entry.face)
  useEffect(() => {
    if (sticky) return undefined
    const timer = setTimeout(() => noticeStore.dismiss(key), isActionNotice(kind) ? ACTION_VISIBLE_MS : NEWS_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [key, kind, sticky])
  // A reply wears the persona's face instead of her name, so the voice still says who.
  const said = [face?.name, entry.title, entry.body].filter((part) => part !== undefined && part !== '')
  const spoken = said.join('. ')
  // Read out once as it lands, since a screen reader focused elsewhere would otherwise miss it before it goes.
  useEffect(() => AccessibilityInfo.announceForAccessibility(spoken), [key, spoken])
  const mark = MARKS[kind]
  // Usage is the header pill's own sheet rather than a place to go, so a limit opens nothing.
  const opens = target !== null && ('chatId' in target || target.page === 'scheduled') ? target : null
  return (
    <Animated.View entering={glassRise} exiting={glassSink}>
      <GlassSurface radius={radius.panel} fallbackStyle={styles.fallback}>
        <View style={styles.row}>
          {/* The whole card opens what it is about; Undo and close are its only other buttons. */}
          <Pressable
            disabled={opens === null}
            accessibilityRole={opens === null ? (kind === 'failed' || kind === 'error' || sticky ? 'alert' : 'summary') : 'button'}
            accessibilityLabel={spoken}
            {...(opens === null ? {} : { accessibilityHint: 'Opens the chat' })}
            onPress={() => {
              if (opens === null) return
              noticeStore.dismiss(key)
              onOpen(opens)
            }}
            style={({ pressed }) => [styles.open, pressed && opens !== null && styles.pressed]}
          >
            {face === undefined ? <HugeiconsIcon icon={mark.icon} size={20} color={mark.color} strokeWidth={1.8} /> : (
              <Blobatar name={face.name} color={face.color} src={face.avatar} shape={face.avatarShape} tone={face.avatarTone} size={24} />
            )}
            <View style={styles.text}>
              <Text numberOfLines={1} style={styles.title}>{entry.title}</Text>
              {entry.body === '' ? null : <Text numberOfLines={1} style={styles.body}>{entry.body}</Text>}
            </View>
          </Pressable>
          {undo === undefined ? null : (
            <CardButton label="Undo" onPress={() => {
              noticeStore.dismiss(key)
              undoMemoryWrite(undo.chatId, undo.writeId).then(
                () => noticeStore.push(actionNotice('success', 'Undone')),
                (error: unknown) => noticeStore.push(actionNotice('error', error instanceof Error ? error.message : 'Could not undo')),
              )
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
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingRight: spacing.sm },
  // The card's left and vertical padding sit inside the press area, so a tap on the edge opens too.
  open: { flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingLeft: spacing.md },
  pressed: { opacity: 0.6 },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 14, lineHeight: 18 },
  body: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
})
