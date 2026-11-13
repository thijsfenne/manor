import { palette } from '@manor/blobatar'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_COLOR } from '@manor/contracts'
import { avatarBubbleTint, projectBubbleTint } from './avatarBubble'
import { accentHue } from './accentHue'
import { BLOB_TONES } from './blobShapes'

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const hexAt = (hue: number) => {
  const toByte = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')
  const angle = (hue * Math.PI) / 180
  return `#${toByte(0.5 + 0.4 * Math.cos(angle))}${toByte(0.5 + 0.4 * Math.cos(angle - 2.1))}${toByte(0.5 + 0.4 * Math.cos(angle + 2.1))}`
}

describe('avatarBubbleTint', () => {
  it('wears the body colour of the face, with ink and chip wash at AA on every hue and tone', () => {
    // Pale neutral (0.3) is not offered in the picker but can be stored.
    for (const tone of [...BLOB_TONES.map((entry) => entry.value), 0.3]) {
      for (let hue = 0; hue < 360; hue += 3) {
        const tint = avatarBubbleTint({ color: hexAt(hue), avatarTone: tone })
        expect(tint).toBeDefined()
        if (tint === undefined) continue
        expect(contrast(tint.ink, tint.fill)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(tint.ink, tint.wash)).toBeGreaterThanOrEqual(contrast(tint.ink, tint.fill))
      }
    }
  })

  it('writes white and keeps the face colour when it is already dark enough, darkening it otherwise', () => {
    const color = '#4a9eff'
    const ink = BLOB_TONES.find((entry) => entry.label === 'Ink')?.value
    expect(avatarBubbleTint({ color })?.ink).toBe('#ffffff')
    expect(avatarBubbleTint({ color, avatarTone: ink })?.fill).toBe(palette(accentHue(color) ?? 0, true, ink).head)
    const pastel = palette(accentHue(color) ?? 0, true, 0.1).head ?? ''
    const fill = avatarBubbleTint({ color, avatarTone: 0.1 })?.fill ?? ''
    expect(luminance(fill)).toBeLessThan(luminance(pastel))
  })

  it('keeps the plain bubble for a portrait or a colour that is not a hex', () => {
    expect(avatarBubbleTint({ color: '#4a9eff', avatar: 'data:image/png;base64,AAAA' })).toBeUndefined()
    expect(avatarBubbleTint({ color: 'var(--color-primary)' })).toBeUndefined()
  })
})

describe('projectBubbleTint', () => {
  it('fills with the project colour under white ink, darkened only as far as AA needs', () => {
    const dark = projectBubbleTint({ color: '#1f4e8c' })
    expect(dark).toEqual({ fill: '#1f4e8c', ink: '#ffffff', wash: expect.any(String), chip: expect.stringMatching(/^rgba\(255, 255, 255, 0\./) })
    for (const color of ['#E0AF68', '#9ECE6A']) {
      const tint = projectBubbleTint({ color })
      expect(tint?.ink).toBe('#ffffff')
      expect(contrast('#ffffff', tint?.fill ?? '#ffffff')).toBeGreaterThanOrEqual(4.5)
      expect(luminance(tint?.fill ?? '')).toBeLessThan(luminance(color))
    }
  })

  it('keeps the plain bubble when the project has no colour of its own', () => {
    expect(projectBubbleTint({ color: DEFAULT_PROJECT_COLOR })).toBeUndefined()
    expect(projectBubbleTint({ color: DEFAULT_PROJECT_COLOR.toLowerCase() })).toBeUndefined()
    expect(projectBubbleTint({ color: 'var(--color-primary)' })).toBeUndefined()
  })
})
