import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import CancelCircleIcon from '@hugeicons/core-free-icons/CancelCircleIcon'
import File01Icon from '@hugeicons/core-free-icons/File01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { eventImageSource, type EventDocument, type EventImage, type FileAttachment } from '@manor/contracts'
import type { PendingDocument } from '@manor/client-runtime/state'
import { describeBytes, utf8Size } from '@manor/client-runtime/attachments'
import { Image } from 'expo-image'
import * as WebBrowser from 'expo-web-browser'
import { useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { Easing, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { GlassIconButton } from '@/components/GlassIconButton'
import { useBubbleTint } from '@/components/bubbleTint'
import { Text } from '@/components/Text'
import { ViewerModal } from '@/components/ViewerModal'
import { usePageZoom, ZoomableImage } from '@/components/ZoomableImage'
import { useKeepPage } from '@/lib/viewerOrientation'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/**
 * The pictures on a message, in the transcript: the user's on their bubble, a persona's
 * under her reply. Same strip either way, so a picture reads the same whoever sent it.
 */
export function Attachments({ images, files = [], documents = [], size = 120, numbered = false, alignEnd = false, onOpenImage }: {
  images: readonly EventImage[]
  /** Opens a picture somewhere else than the gallery here, such as a persona's in the file viewer. */
  onOpenImage?: (index: number) => void
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
                onOpen={() => (onOpenImage === undefined ? setOpenImage(index) : onOpenImage(index))}
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
            <Text ellipsizeMode="middle" numberOfLines={1} style={[styles.fileName, tint && { color: tint.ink }]}>{file.name}</Text>
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
  if (status === 'partial') return unreadablePages.length > 0 ? `${pages}, ${unreadablePages.length} unreadable` : 'Partly read'
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
      <Text ellipsizeMode="middle" numberOfLines={1} style={[styles.fileName, tint && { color: tint.ink }]}>{document.name}</Text>
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
// The longest a dismissed picture takes to leave; a faster flick leaves faster.
const EXIT_MS = 180

/**
 * A message's pictures become a swipeable, full-screen gallery without leaving chat.
 * Sideways steps through them; a drag up or down carries the picture with the finger
 * while the chat shows through, and lets go of the viewer past a short distance or on
 * a flick, the way Photos does. A shorter drag springs back. A picture pinches and
 * double-taps to zoom; while it is zoomed a drag pans it, so paging and dismissing wait
 * until it is back at fit. The viewer turns with the phone while it is open.
 */
export function ImageViewer(props: { images: readonly EventImage[]; initialIndex: number; onClose: () => void }) {
  return (
    <ViewerModal onClose={props.onClose} transparent>
      <ImageGallery {...props} />
    </ViewerModal>
  )
}

function ImageGallery({ images, initialIndex, onClose }: { images: readonly EventImage[]; initialIndex: number; onClose: () => void }) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  const [current, setCurrent] = useState(initialIndex)
  const { locked: zoomed, report: reportZoom } = usePageZoom(String(current), width)
  const pager = useRef<FlatList<EventImage>>(null)
  const drag = useSharedValue(0)
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setCurrent(Math.round(event.nativeEvent.contentOffset.x / width))
  }
  useKeepPage(pager, width, current)

  // Vertical and one finger only: a sideways move fails it first, so the list keeps its
  // paging, and a second finger belongs to the picture's pinch.
  const dismiss = Gesture.Pan()
    .enabled(!zoomed)
    .maxPointers(1)
    .activeOffsetY([-12, 12])
    .failOffsetX([-12, 12])
    .onUpdate((event) => {
      drag.set(event.translationY)
    })
    .onEnd((event, success) => {
      // A drag the system cancelled, rather than one the finger let go of, never dismisses.
      const away = success && (Math.abs(event.translationY) > height * DISMISS_DISTANCE || Math.abs(event.velocityY) > DISMISS_VELOCITY)
      if (!away) {
        drag.set(still ? 0 : withSpring(0, { ...SPRING_BACK, velocity: event.velocityY }))
        return
      }
      // Leave in the direction of the flick, or of the drag when it was let go slowly.
      const direction = Math.sign(Math.abs(event.velocityY) > DISMISS_VELOCITY ? event.velocityY : event.translationY) || 1
      if (still) {
        runOnJS(onClose)()
        return
      }
      // Off at a steady speed: the finger's own, or faster when that would take over EXIT_MS.
      const remaining = Math.abs(direction * height - drag.get())
      const duration = Math.min(EXIT_MS, (remaining / Math.abs(event.velocityY)) * 1000)
      drag.set(withTiming(direction * height, { duration, easing: Easing.linear }, (finished) => {
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
    <View style={styles.viewer}>
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
            ref={pager}
            renderItem={({ item, index }) => (
              <ViewerImage active={index === current} height={height} image={item} onZoomedChange={reportZoom} page={String(index)} width={width} />
            )}
            scrollEnabled={!zoomed}
            showsHorizontalScrollIndicator={false}
            style={styles.viewerList}
          />
        </Animated.View>
      </GestureDetector>
      <Animated.View pointerEvents="box-none" style={[styles.viewerHeader, { left: spacing.lg + insets.left, right: spacing.lg + insets.right, paddingTop: Math.max(insets.top, spacing.lg) }, chrome]}>
        <GlassIconButton accessibilityLabel="Close image" icon={Cancel01Icon} onPress={onClose} />
        {images.length === 1 ? null : (
          <View style={styles.counter}>
            <Text style={styles.counterText}>{current + 1} / {images.length}</Text>
          </View>
        )}
      </Animated.View>
    </View>
  )
}

function ViewerImage({ image, page, active, width, height, onZoomedChange }: {
  image: EventImage
  page: string
  active: boolean
  width: number
  height: number
  onZoomedChange: (page: string, zoomed: boolean) => void
}) {
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
        <ZoomableImage
          active={active}
          height={height}
          name={image.name}
          onError={() => setState('failed')}
          onLoad={() => setState('loaded')}
          onZoomedChange={onZoomedChange}
          page={page}
          uri={uri}
          width={width}
        >
          {state === 'loading' ? <ActivityIndicator color={colors.muted} /> : null}
        </ZoomableImage>
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
