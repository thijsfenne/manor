import { DEFAULT_PROJECT_COLOR } from '@manor/contracts'
import { ensureContrast, fromHex, ramp, toHex, type Oklch } from '@manor/blobatar'
import { accentHue } from './accentHue'
import { DEFAULT_BLOB_TONE } from './blobShapes'

/**
 * The user's own bubble in a DM, filled with the colour of the face they are talking to
 * (a project thread uses the same terms with the project colour, below).
 *
 * The text is always white. `fill` is a vivid colour in the hue her blobatar wears:
 * full chroma, as light as white still clears a hair over AA (4.5:1) on it. It never
 * follows the face's tone, because a pastel or ink face darkened to AA turns dull.
 * Yellows and olives go brown at that lightness, so they move to the nearest hue that
 * stays bright there: orange below the turn, green above it. `wash` is the fill moved
 * further towards black, for code and inline chips inside the text; that can only raise
 * the white's contrast. `chip` is a low white veil for the rows that sit above the text (the reply
 * row, an attached file), so they read as part of the bubble instead of a dark box.
 */
export interface BubbleTint {
  fill: string
  ink: string
  wash: string
  chip: string
}

/** A hair over 4.5:1, because the pair is read back from 8-bit hex. */
const INK_FLOOR = 4.6
const WASH_SHARE = 0.22
const WHITE = { l: 1, c: 0, h: 0 }
const CHIP_VEIL = 'rgba(255, 255, 255, 0.14)'
/** Where the search for the fill starts; `toHex` and `contrast` pull the chroma into gamut. */
const VIVID = { l: 0.72, c: 0.22 }

/** OKLCh hue: the yellow and olive band, which darkens to brown, folded out to its edges. */
const vividHue = (h: number) => (h > 48 && h <= 102 ? 44 + (h - 48) * 0.08 : h > 102 && h < 138 ? 138 + (h - 102) * 0.1 : h)

/**
 * Undefined keeps the plain bubble: a portrait has no single colour to wear, and an
 * accent that is not a hex gives the face no hue of ours to match.
 */
export function avatarBubbleTint(agent: { color: string; avatar?: string | undefined; avatarTone?: number | undefined }): BubbleTint | undefined {
  if (agent.avatar !== undefined && agent.avatar !== '') return undefined
  const hue = accentHue(agent.color)
  if (hue === undefined) return undefined
  const { head } = ramp(hue, true, agent.avatarTone ?? DEFAULT_BLOB_TONE)
  if (head === undefined) return undefined
  return whiteInkTint({ ...VIVID, h: vividHue(head.h) })
}

/**
 * The user's own bubble in a project thread, filled with the project's icon colour on
 * the same white-ink terms as a DM. The grey default means no colour was picked, so
 * it keeps the plain bubble, as does anything that is not a six-digit hex.
 */
export function projectBubbleTint(project: { color: string }): BubbleTint | undefined {
  const color = project.color.trim()
  if (!/^#[0-9a-f]{6}$/i.test(color) || color.toLowerCase() === DEFAULT_PROJECT_COLOR.toLowerCase()) return undefined
  return whiteInkTint(fromHex(color))
}

function whiteInkTint(color: Oklch): BubbleTint {
  const fill = toHex(ensureContrast(color, WHITE, INK_FLOOR))
  return { fill, ink: '#ffffff', wash: mixHex(fill, '#000000', WASH_SHARE), chip: CHIP_VEIL }
}

/** `color-mix(in srgb, a, b share)`, which is monotone in every channel. */
function mixHex(a: string, b: string, share: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16)
  return `#${[0, 1, 2]
    .map((at) => Math.round(channel(a, at) + (channel(b, at) - channel(a, at)) * share).toString(16).padStart(2, '0'))
    .join('')}`
}
