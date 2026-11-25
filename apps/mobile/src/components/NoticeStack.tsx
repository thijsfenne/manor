import Alert02Icon from '@hugeicons/core-free-icons/Alert02Icon'
import Brain02Icon from '@hugeicons/core-free-icons/Brain02Icon'
import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon'
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon'
import DashboardSpeed01Icon from '@hugeicons/core-free-icons/DashboardSpeed01Icon'
import GitMergeIcon from '@hugeicons/core-free-icons/GitMergeIcon'
import RefreshIcon from '@hugeicons/core-free-icons/RefreshIcon'
import Rocket01Icon from '@hugeicons/core-free-icons/Rocket01Icon'
import TaskDone01Icon from '@hugeicons/core-free-icons/TaskDone01Icon'
import UserQuestion01Icon from '@hugeicons/core-free-icons/UserQuestion01Icon'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import { Fragment, useEffect, useState, useSyncExternalStore } from 'react'
import { AccessibilityInfo, type LayoutChangeEvent, Platform, Pressable, StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'
import { FullWindowOverlay } from 'react-native-screens'
import { actionNotice, isActionNotice, VISIBLE_NOTICES, type NoticeEntry, type NoticeKind, type NoticeTarget } from '@manor/client-runtime/notices'
import { glassRise, glassSink } from '@/lib/glassMotion'
import { rubberBand } from '@/lib/rubberBand'
import { noticeStore } from '@/lib/notices'
import { useWindowInsets } from '@/lib/windowInsets'
import { useWorkspaceActions, useWorkspaceData } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing } from '@/theme'
import { Blobatar } from './Blobatar'
import { CardButton } from './CardButton'
import { GlassSurface } from './GlassSurface'
import { Text } from './Text'

/** Chat news is read, not glanced at; an action's confirmation is shorter. */
const NEWS_VISIBLE_MS = 6_000
const ACTION_VISIBLE_MS = 3_500

/** A native sheet or modal draws above every React view; on iOS the stack gets a window of its own above them. Touches outside a card pass through. */
const AboveSheets = Platform.OS === 'ios' ? FullWindowOverlay : Fragment

/** Upward travel, in points, past which a released card goes; a slower swipe that stops short springs back. */
const DISMISS_DISTANCE = 32
/** Upward release speed, in points per second, that takes a card away however far it moved. */
const DISMISS_FLING = 500
const SPRING = { damping: 26, stiffness: 240, mass: 0.8 }
/** How far past the screen's top a swiped card ends, so the sink it leaves with stays out of view. */
const EXIT_CLEARANCE = 16

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
  const stackTop = useWindowInsets().top + spacing.xs
  if (entries.length === 0) return null
  return (
    <AboveSheets>
      <View pointerEvents="box-none" style={[styles.stack, { top: stackTop }]}>
        {entries.slice(0, VISIBLE_NOTICES).map((entry) => <NoticeCard key={entry.key} entry={entry} stackTop={stackTop} onOpen={onOpen} />)}
      </View>
    </AboveSheets>
  )
}

function NoticeCard({ entry, stackTop, onOpen }: { entry: NoticeEntry; stackTop: number; onOpen: (target: NoticeTarget) => void }) {
  const { key, kind, sticky, target, undo } = entry
  const { undoMemoryWrite } = useWorkspaceActions()
  const face = useWorkspaceData().workspace.agents.find((agent) => agent.id === entry.face)
  // A card under the finger keeps its place; a card let go of gets its full time again.
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (sticky || held) return undefined
    const timer = setTimeout(() => noticeStore.dismiss(key), isActionNotice(kind) ? ACTION_VISIBLE_MS : NEWS_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [key, kind, sticky, held])
  // A reply wears the persona's face instead of her name, so the voice still says who.
  const said = [face?.name, entry.title, entry.body].filter((part) => part !== undefined && part !== '')
  const spoken = said.join('. ')
  // Read out once as it lands, since a screen reader focused elsewhere would otherwise miss it before it goes.
  useEffect(() => AccessibilityInfo.announceForAccessibility(spoken), [key, spoken])
  const mark = MARKS[kind]
  // Usage is the header pill's own sheet rather than a place to go, so a limit opens nothing.
  const opens = target !== null && ('chatId' in target || target.page === 'scheduled') ? target : null
  const swipe = useSwipeAway(() => noticeStore.dismiss(key), setHeld, stackTop)
  return (
    <Animated.View entering={glassRise} exiting={glassSink} onLayout={swipe.onLayout}>
      <GestureDetector gesture={swipe.gesture}>
        <Animated.View style={swipe.style}>
          <GlassSurface radius={radius.panel} fallbackStyle={styles.fallback}>
            <View style={styles.row}>
              {/* The whole card opens what it is about; Undo is its only other button, and a swipe up dismisses it. */}
              <Pressable
                disabled={opens === null}
                accessibilityRole={opens === null ? (kind === 'failed' || kind === 'error' || sticky ? 'alert' : 'summary') : 'button'}
                accessibilityLabel={spoken}
                {...(opens === null ? {} : { accessibilityHint: 'Opens the chat' })}
                // A swipe has no screen reader equivalent, so Dismiss is an action and the escape gesture.
                accessibilityActions={[{ name: 'dismiss', label: 'Dismiss' }]}
                onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'dismiss') noticeStore.dismiss(key) }}
                onAccessibilityEscape={() => noticeStore.dismiss(key)}
                onPress={() => {
                  if (opens === null) return
                  noticeStore.dismiss(key)
                  onOpen(opens)
                }}
                style={({ pressed }) => [styles.open, pressed && opens !== null && styles.pressed]}
              >
                <View style={styles.mark}>
                  {face === undefined ? <HugeiconsIcon icon={mark.icon} size={24} color={mark.color} strokeWidth={1.8} /> : (
                    <Blobatar name={face.name} color={face.color} src={face.avatar} shape={face.avatarShape} tone={face.avatarTone} size={32} />
                  )}
                </View>
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
            </View>
          </GlassSurface>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  )
}

/**
 * Swiping a card up takes it away, as a system banner goes. It follows the finger 1:1
 * from the first touch upward and gives a fifth of the distance downward; on release a
 * fling or enough travel sends it past the top of the screen with the fling's speed,
 * anything else springs back. A swipe the system cancelled always springs back.
 * Movement only, never opacity, so the glass stays glass. `stackTop` is where the stack
 * starts on screen, so the way out is measured from the card's own bottom edge.
 */
function useSwipeAway(onGone: () => void, onHold: (held: boolean) => void, stackTop: number) {
  const still = useReducedMotion()
  const offset = useSharedValue(0)
  const startY = useSharedValue(0)
  const bottom = useSharedValue(0)
  const gesture = Gesture.Pan()
    .activeOffsetY(-10)
    .failOffsetX([-20, 20])
    .maxPointers(1)
    // The pan's own translation restarts once it activates, so the travel counts from the touch.
    .onBegin((event) => {
      startY.set(event.absoluteY)
      runOnJS(onHold)(true)
    })
    .onFinalize(() => { runOnJS(onHold)(false) })
    .onUpdate((event) => {
      offset.set(rubberBand(event.absoluteY - startY.get(), Number.NEGATIVE_INFINITY, 0, 0.2))
    })
    .onEnd((event, success) => {
      const goes = success && (offset.get() < -DISMISS_DISTANCE || event.velocityY < -DISMISS_FLING)
      if (!goes) {
        offset.set(still ? 0 : withSpring(0, { ...SPRING, velocity: event.velocityY }))
        return
      }
      if (still) {
        runOnJS(onGone)()
        return
      }
      const away = Math.min(offset.get(), -(stackTop + bottom.get() + EXIT_CLEARANCE))
      offset.set(withSpring(away, { ...SPRING, velocity: event.velocityY, overshootClamping: true }, (finished) => {
        if (finished === true) runOnJS(onGone)()
      }))
    })
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: offset.get() }] }))
  const onLayout = (event: LayoutChangeEvent) => { bottom.set(event.nativeEvent.layout.y + event.nativeEvent.layout.height) }
  return { gesture, style, onLayout }
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
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingRight: spacing.md },
  // The card's left and vertical padding sit inside the press area, so a tap on the edge opens too.
  open: { flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingLeft: spacing.md },
  pressed: { opacity: 0.6 },
  mark: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 14, lineHeight: 18 },
  body: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
})
