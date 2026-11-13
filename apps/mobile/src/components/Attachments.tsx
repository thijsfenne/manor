import { Cancel01Icon, CancelCircleIcon, File01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { eventImageSource, type EventDocument, type EventImage, type FileAttachment } from '@manor/contracts'
import type { PendingDocument } from '@manor/client-runtime/state'
import { describeBytes, utf8Size } from '@manor/client-runtime/attachments'
import { Image } from 'expo-image'
import * as WebBrowser from 'expo-web-browser'
import { useState } from 'react'
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { Easing, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { GlassIconButton } from '@/components/GlassIconButton'
import { useBubbleTint } from '@/components/bubbleTint'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/**
 * The pictures on a message, in the transcript: the user's on their bubble, a persona's
 * under her reply. Same strip either way, so a picture reads the same whoever sent it.
 */
export function Attachments({ images, files = [], documents = [], size = 120, numbered = false, alignEnd = false }: {
  images: readonly EventImage[]
  files?: readonly FileAttachment[]
  documents?: readonly (EventDocument | PendingDocument)[]
  size?: number
  /** The message refers to its pictures by number, so each wears its own. */
  numbered?: boolean
  /** The user's pictures sit against the right edge, above their bubble. */
  alignEnd?: boolean
}) {
  const [openImage, setOpenImage] = useState<number | null>(null)
  const tint = useBubbleTint()
  if (images.length === 0 && files.length === 0 && documents.length === 0) return null
  return (
    <>
      <View style={styles.stack}>
        {images.length === 0 ? null : (
          <View style={[styles.strip, alignEnd && styles.stripEnd]}>
            {images.map((image, index) => (
              <AttachmentThumbnail
                image={image}
                key={`${image.name}:${index}`}
                onOpen={() => setOpenImage(index)}
                size={size}
                {...(numbered ? { number: index + 1 } : {})}
              />
            ))}
          </View>
        )}
        {/* Named and sized, never quoted back: the text went to the persona, and a
            message that repeats a whole file at the user buries what they wrote with it. */}
        {files.map((file, index) => (
          <View key={`${file.name}:${index}`} style={[styles.file, tint && { backgroundColor: tint.chip }]}>
            <HugeiconsIcon color={tint?.ink ?? colors.muted} icon={File01Icon} size={13} strokeWidth={1.7} />
            <Text numberOfLines={1} style={[styles.fileName, tint && { color: tint.ink }]}>{file.name}</Text>
            <Text style={[styles.fileSize, tint && { color: tint.ink }]}>{describeBytes(utf8Size(file.content))}</Text>
          </View>
        ))}
        {documents.map((document, index) => <DocumentChip document={document} key={`${document.name}:${index}`} />)}
      </View>
      {openImage === null ? null : (
        <ImageViewer images={images} initialIndex={openImage} onClose={() => setOpenImage(null)} />
      )}
    </>
  )
}

/**
 * How much text the Mac got out of a document, which is all a persona reads. Never
 * "read" on its own: text extraction is not looking at the pages.
 */
function documentLabel(document: EventDocument | PendingDocument): string {
  if (!('extraction' in document)) return 'Reading…'
  const { status, pageCount, unreadablePages = [] } = document.extraction
  const pages = pageCount === undefined ? '' : `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`
  if (status === 'complete') return pages || 'Text read'
  if (status === 'partial') return unreadablePages.length > 0 ? `${pages} · ${unreadablePages.length} unreadable` : 'Partly read'
  return status === 'unknown' ? 'Coverage unknown' : 'No readable text'
}

/** A sent PDF or Word file; once stored, a press opens the original. */
function DocumentChip({ document }: { document: EventDocument | PendingDocument }) {
  const src = 'src' in document ? document.src : undefined
  const incomplete = 'extraction' in document && document.extraction.status !== 'complete'
  // On a tinted bubble the warning colour has no contrast promise, so the label alone
  // says the text came out partly.
  const tint = useBubbleTint()
  const content = (
    <>
      <HugeiconsIcon color={tint?.ink ?? colors.muted} icon={File01Icon} size={13} strokeWidth={1.7} />
      <Text numberOfLines={1} style={[styles.fileName, tint && { color: tint.ink }]}>{document.name}</Text>
      <Text style={[styles.fileSize, incomplete && styles.fileWarning, tint && { color: tint.ink }]}>{documentLabel(document)}</Text>
    </>
  )
  const chip = [styles.file, tint && { backgroundColor: tint.chip }]
  return src === undefined ? (
    <View style={chip}>{content}</View>
  ) : (
    <Pressable
      accessibilityLabel={`Open ${document.name}`}
      accessibilityRole="link"
      onPress={() => void WebBrowser.openBrowserAsync(src)}
      style={({ pressed }) => [...chip, pressed && styles.thumbnailPressed]}
    >
      {content}
    </Pressable>
  )
}

/**
 * A stored picture is a link the phone fetches; a failed one is tried again on a
 * press rather than left broken. A new query string is what makes expo-image ask
 * again instead of answering from its failure. A data URL cannot improve.
 */
function useImageSource(image: EventImage) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)
  const source = eventImageSource(image)
  const uri = attempt === 0 || image.src === undefined ? source : `${source}${source.includes('?') ? '&' : '?'}retry=${attempt}`
  const retry = image.src === undefined ? undefined : () => {
    setState('loading')
    setAttempt((value) => value + 1)
  }
  return { state, setState, uri, retry }
}

/** A picture's square tile, or a `width` × `size` one where its shape should show. */
export function AttachmentThumbnail({ image, onOpen, size, width = size, corner = radius.md, top = false, number }: {
  image: EventImage
  onOpen: () => void
  size: number
  width?: number
  /** The corner radius; a small tile takes a smaller one, or it rounds into a pill. */
  corner?: number
  /** Crop from the top, where a screenshot keeps its header. */
  top?: boolean
  /** The `#n` it answers to, when its message refers to its pictures by number. */
  number?: number
}) {
  const { state, setState, uri, retry } = useImageSource(image)
  const shape = { width, height: size, borderRadius: corner, ...squircle }
  return (
    <Pressable
      accessibilityLabel={state === 'failed' && retry !== undefined ? `Couldn't load ${image.name}. Retry` : `Open ${image.name}`}
      accessibilityRole="button"
      onPress={state === 'failed' && retry !== undefined ? retry : onOpen}
      style={({ pressed }) => [shape, styles.thumbnail, pressed && styles.thumbnailPressed]}
    >
      {state === 'failed' ? (
        <View style={styles.failedThumbnail}>
          <HugeiconsIcon color={colors.dim} icon={CancelCircleIcon} size={20} strokeWidth={1.8} />
          <Text numberOfLines={2} style={styles.failedThumbnailText}>{image.name}</Text>
        </View>
      ) : (
        <>
          <Image
            accessibilityIgnoresInvertColors
            contentFit="cover"
            {...(top ? { contentPosition: 'top' as const } : {})}
            onError={() => setState('failed')}
            onLoad={() => setState('loaded')}
            source={{ uri }}
            style={StyleSheet.absoluteFill}
          />
          {state === 'loading' ? <ActivityIndicator color={colors.muted} size="small" /> : null}
        </>
      )}
      {number === undefined ? null : <ImageNumberBadge number={number} />}
    </Pressable>
  )
}

/**
 * The number a picture answers to, in the composer tray and on a sent message that
 * refers to its pictures. Dark in both themes with white ink, so it reads on any picture.
 */
export function ImageNumberBadge({ number }: { number: number }) {
  return (
    <View pointerEvents="none" style={styles.badge}>
      <Text style={styles.badgeText}>#{number}</Text>
    </View>
  )
}

// A release past this share of the screen's height dismisses, or a flick faster than
// DISMISS_VELOCITY px/s; the backdrop is gone by FADE_DISTANCE.
const DISMISS_DISTANCE = 0.15
const DISMISS_VELOCITY = 800
const FADE_DISTANCE = 0.4
const SPRING_BACK = { damping: 26, stiffness: 260, mass: 0.8 }

/**
 * A message's pictures become a swipeable, full-screen gallery without leaving chat.
 * Sideways steps through them; a drag up or down carries the picture with the finger
 * while the chat shows through, and lets go of the viewer past a short distance or on
 * a flick, the way Photos does. A shorter drag springs back. The viewer has no pinch
 * zoom, so every drag starts at zoom 1; a zoom added later must gate this pan on it.
 */
export function ImageViewer({ images, initialIndex, onClose }: { images: readonly EventImage[]; initialIndex: number; onClose: () => void }) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  const [current, setCurrent] = useState(initialIndex)
  const drag = useSharedValue(0)
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setCurrent(Math.round(event.nativeEvent.contentOffset.x / width))
  }

  // Vertical only: a sideways move fails it first, so the list keeps its paging.
  const dismiss = Gesture.Pan()
    .activeOffsetY([-12, 12])
    .failOffsetX([-12, 12])
    .onUpdate((event) => {
      drag.set(event.translationY)
    })
    .onEnd((event, success) => {
      // A drag the system cancelled, rather than one the finger let go of, never dismisses.
      const away = success && (Math.abs(event.translationY) > height * DISMISS_DISTANCE || Math.abs(event.velocityY) > DISMISS_VELOCITY)
      if (!away) {
        drag.set(still ? 0 : withSpring(0, SPRING_BACK))
        return
      }
      // Leave in the direction of the flick, or of the drag when it was let go slowly.
      const direction = Math.sign(Math.abs(event.velocityY) > DISMISS_VELOCITY ? event.velocityY : event.translationY) || 1
      if (still) {
        runOnJS(onClose)()
        return
      }
      drag.set(withTiming(direction * height, { duration: 180, easing: Easing.out(Easing.quad) }, (finished) => {
        if (finished === true) runOnJS(onClose)()
      }))
    })

  const picture = useAnimatedStyle(() => ({
    transform: [
      { translateY: drag.get() },
      { scale: interpolate(Math.abs(drag.get()), [0, height], [1, 0.85], Extrapolation.CLAMP) },
    ],
  }))
  const backdrop = useAnimatedStyle(() => ({
    opacity: interpolate(Math.abs(drag.get()), [0, height * FADE_DISTANCE], [1, 0], Extrapolation.CLAMP),
  }))
  const chrome = useAnimatedStyle(() => ({
    opacity: interpolate(Math.abs(drag.get()), [0, 48], [1, 0], Extrapolation.CLAMP),
  }))

  return (
    <Modal animationType="fade" onRequestClose={onClose} statusBarTranslucent transparent visible>
      {/* A modal is its own native root, so its gestures need their own handler root. */}
      <GestureHandlerRootView style={styles.viewer}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.viewerBackdrop, backdrop]} />
        <GestureDetector gesture={dismiss}>
          <Animated.View style={[styles.viewerList, picture]}>
            <FlatList
              data={images}
              getItemLayout={(_, index) => ({ index, length: width, offset: width * index })}
              horizontal
              initialScrollIndex={initialIndex}
              keyExtractor={(image, index) => `${image.name}:${index}`}
              onMomentumScrollEnd={settle}
              pagingEnabled
              renderItem={({ item }) => <ViewerImage image={item} width={width} />}
              showsHorizontalScrollIndicator={false}
              style={styles.viewerList}
            />
          </Animated.View>
        </GestureDetector>
        <Animated.View pointerEvents="box-none" style={[styles.viewerHeader, { paddingTop: Math.max(insets.top, spacing.lg) }, chrome]}>
          <GlassIconButton accessibilityLabel="Close image" icon={Cancel01Icon} onPress={onClose} />
          {images.length === 1 ? null : (
            <View style={styles.counter}>
              <Text style={styles.counterText}>{current + 1} / {images.length}</Text>
            </View>
          )}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  )
}

function ViewerImage({ image, width }: { image: EventImage; width: number }) {
  const { state, setState, uri, retry } = useImageSource(image)
  return (
    <View style={[styles.viewerPage, { width }]}>
      {state === 'failed' ? (
        <Pressable
          accessibilityRole={retry === undefined ? undefined : 'button'}
          disabled={retry === undefined}
          onPress={retry}
          style={styles.viewerStatus}
        >
          <HugeiconsIcon color={colors.dim} icon={CancelCircleIcon} size={28} strokeWidth={1.8} />
          <Text style={styles.viewerError}>
            {retry === undefined ? 'The image could not be loaded.' : 'The image could not be loaded. Tap to try again.'}
          </Text>
        </Pressable>
      ) : (
        <>
          <Image
            accessibilityIgnoresInvertColors
            accessibilityLabel={image.name}
            contentFit="contain"
            onError={() => setState('failed')}
            onLoad={() => setState('loaded')}
            source={{ uri }}
            style={StyleSheet.absoluteFill}
          />
          {state === 'loading' ? <ActivityIndicator color={colors.muted} /> : null}
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stripEnd: { justifyContent: 'flex-end' },
  thumbnail: { alignItems: 'center', backgroundColor: colors.surface2, justifyContent: 'center', overflow: 'hidden' },
  thumbnailPressed: { opacity: 0.82 },
  badge: { position: 'absolute', left: 4, bottom: 4, borderRadius: radius.round, backgroundColor: colors.onLight, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { color: colors.lightControl, fontFamily: fonts.sans, fontSize: 11, lineHeight: 15, fontWeight: '500' },
  failedThumbnail: { alignItems: 'center', gap: spacing.xs, padding: spacing.sm },
  failedThumbnailText: { color: colors.dim, fontFamily: fonts.sans, fontSize: 11, textAlign: 'center' },
  file: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.chip,
    borderRadius: radius.md,
    ...squircle,
    flexDirection: 'row',
    gap: spacing.xs,
    maxWidth: '100%',
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  fileName: { color: colors.text, flexShrink: 1, fontFamily: fonts.sans, fontSize: 13 },
  fileSize: { color: colors.dim, fontFamily: fonts.sans, fontSize: 11 },
  fileWarning: { color: colors.warning },
  viewer: { flex: 1 },
  viewerBackdrop: { backgroundColor: colors.background },
  viewerList: { flex: 1 },
  viewerPage: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  viewerHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', left: spacing.lg, position: 'absolute', right: spacing.lg, top: 0 },
  counter: { backgroundColor: colors.raised, borderColor: colors.line, borderRadius: radius.round, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  counterText: { color: colors.text, fontFamily: fonts.sans, fontSize: 13 },
  viewerStatus: { alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xl },
  viewerError: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, textAlign: 'center' },
})
