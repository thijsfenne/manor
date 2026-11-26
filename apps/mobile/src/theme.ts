import { DynamicColorIOS, Platform, useColorScheme, type ColorValue } from 'react-native'

const adaptive = (light: string, dark: string): ColorValue =>
  Platform.OS === 'ios' ? DynamicColorIOS({ light, dark }) : dark

export const colors = {
  background: adaptive('#f7f8fa', '#0c0d0e'),
  surface: adaptive('#ffffff', '#0f1011'),
  surface2: adaptive('#eef0f3', '#191a1b'),
  raised: adaptive('#ffffff', '#191a1b'),
  // The Mac's sidebar step and the fill drawn on it, for the thread bundle card that shares it.
  sidebar: adaptive('#f3f4f6', '#121314'),
  sidebarFill: adaptive('#e8eaee', '#191a1b'),
  // A native page sheet needs its own depth ladder: in dark mode the page has to
  // remain visible over the room behind it, and its inset groups need one more step.
  sheet: adaptive('#f7f8fa', '#0f1011'),
  sheetSurface: adaptive('#ffffff', '#191a1b'),
  sheetPressed: adaptive('#eef0f3', '#26262b'),
  text: adaptive('#16181b', '#f7f8f8'),
  muted: adaptive('#565b66', '#8a8f98'),
  // Native dark mode collapses Distant Silver into Quiet Silver so compact
  // metadata and placeholders retain readable contrast on inset surfaces.
  dim: adaptive('#616773', '#8a8f98'),
  line: adaptive('rgba(0, 0, 0, 0.11)', 'rgba(255, 255, 255, 0.08)'),
  fill: adaptive('#e8eaee', '#26262b'),
  // The marker under the selected segment of a switch. Light needs a clear step darker than
  // the track (`surface2`) it slides on; dark equals `fill`.
  segment: adaptive('#d3d7de', '#26262b'),
  // Outgoing clouds. Light sits one notch darker than the incoming cloud,
  // at the AA floor for `dim`. Dark equals `fill` so the night room does not move.
  userBubble: adaptive('#e3e5e9', '#26262b'),
  // Incoming clouds. Light sits between the canvas and his own bubble, so who
  // spoke reads first. Dark equals `surface2`.
  bubble: adaptive('#eff1f4', '#191a1b'),
  picked: adaptive('#d2d6dd', '#6b6f78'),
  danger: adaptive('#b02c24', '#eb5757'),
  warning: adaptive('#8a5d00', '#f2c94c'),
  ok: adaptive('#056b4b', '#10b981'),
  busy: adaptive('#1155cc', '#4a9eff'),
  // `busy` at 14%: the ground under an image or quote pill in a sent message.
  // Written out because a dynamic colour cannot be mixed at use time.
  busyWash: adaptive('rgba(17, 85, 204, 0.14)', 'rgba(74, 158, 255, 0.18)'),
  // The Mac's `--color-skill`: the one chromatic mark a skill or a cleared suggestion wears.
  skill: adaptive('#7c4ddb', '#a78bfa'),
  // `skill` at 20%, the Mac's skill chip ground: a skill pill in a sent message.
  skillWash: adaptive('rgba(124, 77, 219, 0.2)', 'rgba(167, 139, 250, 0.2)'),
  // The Mac's `--color-worktree`: a Session that works in its own git worktree.
  worktree: adaptive('#7c4ddb', '#a78bfa'),
  // A diff's line tints: `ok` and `danger` at 15%, the same mix the Mac paints, so a
  // change reads the same on both screens. Written out because a dynamic colour
  // cannot be mixed at use time.
  diffAdded: adaptive('rgba(5, 107, 75, 0.15)', 'rgba(16, 185, 129, 0.15)'),
  diffRemoved: adaptive('rgba(176, 44, 36, 0.15)', 'rgba(235, 87, 87, 0.15)'),
  // The Mac's `--color-find`, its caution fill at 24%: the wash on a message a jump lands on.
  find: adaptive('rgba(181, 136, 0, 0.24)', 'rgba(242, 201, 76, 0.24)'),
  onPrimary: adaptive('#ffffff', '#08090a'),
  onLight: adaptive('#16181b', '#16181b'),
  lightControl: adaptive('#ffffff', '#ffffff'),
  scrim: adaptive('rgba(24, 26, 31, 0.32)', 'rgba(0, 0, 0, 0.55)'),
  chip: adaptive('rgba(0, 0, 0, 0.07)', 'rgba(255, 255, 255, 0.1)'),
  // Floating controls where glass is missing: black in both modes, softened by opacity.
  shadow: adaptive('#000000', '#000000'),
} as const

/**
 * Literal tints passed to native glass, whose API does not accept dynamic colours;
 * `useScheme` picks one. The primary tint is `colors.text` a little sheer, so the
 * material still shows through a dark button in light mode and a light one in dark.
 */
export const glassTints = {
  primary: { light: 'rgba(22, 24, 27, 0.86)', dark: 'rgba(247, 248, 248, 0.86)' },
} as const

/**
 * The colours a code preview reads in, one per token kind the highlighter emits.
 * Muted rather than a full editor theme: the phone reads code, it does not write
 * it, and a page that shouts in six colours is harder to scan than one that
 * whispers in four.
 */
export const syntax = {
  plain: colors.text,
  comment: adaptive('#7a8089', '#6f7580'),
  string: adaptive('#1f7a4d', '#7fc9a1'),
  number: adaptive('#9a5b00', '#e5b567'),
  keyword: adaptive('#8a3fb8', '#c792ea'),
  type: adaptive('#0f6fb5', '#82aaff'),
  function: adaptive('#1155cc', '#8fbcff'),
  property: adaptive('#b03b6a', '#f29cb8'),
  punctuation: adaptive('#565b66', '#8a8f98'),
  tag: adaptive('#b03b3b', '#f07178'),
  attribute: adaptive('#8a5d00', '#ffcb6b'),
  variable: adaptive('#b03b6a', '#f29cb8'),
} as const

/** The scrim's fade in one surface colour: whole at the edge, gone over the content. */
const ramp = (rgb: string) => ({ edge: `rgba(${rgb}, 1)`, mid: `rgba(${rgb}, 0.72)`, clear: `rgba(${rgb}, 0)` })

/**
 * Stops for the scrims behind every header, tab bar and composer. Plain strings rather
 * than `DynamicColorIOS`, because a gradient is drawn by a native view that takes
 * literal colours; `useScheme` picks the set for the current appearance.
 */
export const scrims = {
  light: {
    /** The page (`background`) at the edge, nothing over the content. */
    ...ramp('247, 248, 250'),
    /** Mask stops for the progressive blur: alpha is all a mask reads. */
    mask: 'rgba(0, 0, 0, 1)',
    maskClear: 'rgba(0, 0, 0, 0)',
    blurTint: 'light' as const,
  },
  dark: {
    ...ramp('12, 13, 14'),
    mask: 'rgba(0, 0, 0, 1)',
    maskClear: 'rgba(0, 0, 0, 0)',
    blurTint: 'dark' as const,
  },
} as const

/** The same ramp in a page sheet's own colour (`sheet`), which is a step lighter than the page in dark. */
export const sheetScrims = {
  light: ramp('247, 248, 250'),
  dark: ramp('15, 16, 17'),
} as const

/**
 * A folded text's tail as mask stops, the Mac's `.clamp` ramp: eased, so the first line
 * in the fade barely dims and the last is already gone. Alpha is all a mask reads.
 */
export const clampFade = {
  colors: ['rgba(0, 0, 0, 1)', 'rgba(0, 0, 0, 1)', 'rgba(0, 0, 0, 0.78)', 'rgba(0, 0, 0, 0.4)', 'rgba(0, 0, 0, 0.14)', 'rgba(0, 0, 0, 0)'],
  /** Where each stop sits inside the fade zone, from its top. */
  stops: [0, 0, 0.3, 0.6, 0.82, 1],
} as const

/**
 * The two tones a shimmering label is painted in, and the transparent end of its
 * band. Literal strings for the same reason the scrims are: the band is drawn by a
 * native gradient view, which cannot read a dynamic colour. `base` is `muted` and
 * `glow` is `text`, so the sweep travels the same distance here as it does on the
 * Mac, where `.shimmer-text` uses exactly that pair.
 */
export const shimmerTones = {
  /** The glyph shapes the band is clipped to: alpha is all a mask reads. */
  mask: '#000000',
  light: { base: '#565b66', glow: '#16181b', clear: 'rgba(22, 24, 27, 0)' },
  dark: { base: '#8a8f98', glow: '#f7f8f8', clear: 'rgba(247, 248, 248, 0)' },
} as const

export const useScheme = () => {
  const scheme = useColorScheme()
  // As `adaptive`: only iOS follows the system into light.
  return Platform.OS === 'ios' && scheme === 'light' ? 'light' : 'dark'
}

export const fonts = {
  // Geist is the UI face, bundled and loaded in the root layout.
  // Native text resolves a face by family name alone and synthesizes neither a weight
  // nor a slant, so every cut the app uses is registered as its own family; the shared
  // Text component picks between them from the weight and style a screen asks for.
  // To hand the room back to SF Pro Rounded, put `Platform.select({ ios: 'ui-rounded',
  // default: 'System' })` back on `sans` and drop the loader; iOS hands that face over
  // without shipping a byte of it, the only route Apple's licence allows.
  sans: 'Geist_400Regular',
  sansMedium: 'Geist_500Medium',
  sansItalic: 'Geist_400Regular_Italic',
  sansMediumItalic: 'Geist_500Medium_Italic',
  // Place titles only, once per screen, as on the Mac: the room heading, the house
  // menu's name and the sign-in welcome. Never chat, sheets or list rows. It is a
  // single Medium cut, so a title in it sets no fontWeight of its own.
  display: 'Geist_500Medium',
  mono: Platform.select({ ios: 'SF Mono', android: 'monospace', default: 'monospace' }),
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

export const radius = {
  /** Only for marks small enough that a larger corner would round them away. */
  xs: 3,
  sm: 8,
  md: 12,
  lg: 16,
  panel: 20,
  composer: 22,
  round: 999,
} as const

/**
 * Apple's continuous corner, the squircle iOS draws instead of a plain circular
 * arc. Spread next to any `borderRadius`; Android does not know the key and
 * ignores it, and on a full capsule both curves draw the same shape anyway.
 */
export const squircle = { borderCurve: 'continuous' } as const

/**
 * The one size dial for text, the phone's counterpart to `font-size-adjust` on the Mac.
 * Geist's lowercase is 0.53 of its size where Figtree's was 0.50, so every size a screen
 * states is drawn at 0.94 of it and the text keeps the height it had. The shared Text
 * and TextInput apply it; line heights stay as stated.
 */
export const fontScale = 0.94

/**
 * The optical tracking iOS gives the system font natively but RN leaves out, so
 * running text sits looser here than in a native app. The shared Text component
 * applies it by size; text inputs set it directly. Headings tune their own.
 */
export const tracking = {
  /** 13–14px. */
  small: -0.1,
  /** 15–17px running text. */
  body: -0.3,
} as const

/**
 * The words in a DM bubble, his and the agent's: a step above the transcript's 17pt
 * reading size, set a little tighter. The fold, the send flight and the held lift
 * measure with it, so they keep matching the bubble.
 */
export const bubbleText = { fontSize: 18, lineHeight: 24 } as const

/**
 * The quiet one-line marks between DM messages: the day and time line, and the line
 * that says an agent messaged another. `face` is the avatar on the relay line.
 */
export const transcriptMark = { fontSize: 13, lineHeight: 17, face: 20 } as const

/** Tallest the Slack draft editor grows before it scrolls inside its card. */
export const outboundLayout = { inputMaxHeight: 256 } as const
