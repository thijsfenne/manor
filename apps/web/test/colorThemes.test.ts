import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ColorTheme } from '@manor/contracts'
import { COLOR_THEME_IDS, COLOR_THEMES, modeTokens, paletteCss, type Palette } from '../src/colorThemes'

const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')

const luminance = (hex: string) => {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
  const [r = 0, g = 0, b = 0] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** `color-mix(in srgb, a, b share%)` for two hex colours, as modeTokens writes it. */
const mixHex = (a: string, b: string, share: number) =>
  `#${[1, 3, 5].map((at) => Math.round((Number.parseInt(a.slice(at, at + 2), 16) * (100 - share) + Number.parseInt(b.slice(at, at + 2), 16) * share) / 100).toString(16).padStart(2, '0')).join('')}`

/** A light token the theme's sheet writes as a two-colour mix, resolved to hex. */
const lightMix = (theme: ColorTheme, token: string) => {
  const [, a = '', keep = '', b = ''] = modeTokens(COLOR_THEMES[theme].light, 'light')[token]?.match(/^color-mix\(in srgb, (#[0-9a-f]{6}) ([\d.]+)%, (#[0-9a-f]{6})\)$/i) ?? []
  return mixHex(a, b, 100 - Number(keep))
}

/** A light sidebar fill: Manor's stylesheet value, or the mix a theme's sheet writes. */
const sideFill = (theme: ColorTheme, token: 'side-hover' | 'side-picked') =>
  theme === 'manor' ? (styles.match(new RegExp(`--color-${token}: (#[0-9a-f]{6});`, 'i'))?.[1] ?? '') : lightMix(theme, token)

/** Foreground role, background role, the floor it has to clear. */
const PAIRS: ReadonlyArray<readonly [keyof Palette, keyof Palette, number]> = [
  ['text', 'bg', 7],
  ['text', 'surface', 7],
  ['text', 'userBubble', 7],
  ['muted', 'bg', 4.5],
  ['muted', 'userBubble', 4.5],
  ['dim', 'bg', 3],
  ['accent', 'bg', 3],
  ['ok', 'bg', 4.5],
  ['warn', 'bg', 4.5],
  ['danger', 'bg', 4.5],
  ['busy', 'bg', 4.5],
]

describe('colour themes', () => {
  for (const theme of COLOR_THEME_IDS) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${theme} ${mode} clears every contrast floor`, () => {
        const palette = COLOR_THEMES[theme][mode]
        const misses = PAIRS
          .map(([fg, bg, floor]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(palette[fg], palette[bg]), floor }))
          .filter(({ ratio, floor }) => !(ratio >= floor))
        expect(misses).toEqual([])
      })
    }

    it(`${theme} light sets its sidebar a clear step below the stage, its text still readable`, () => {
      const p = COLOR_THEMES[theme].light
      expect(luminance(p.sidebar)).toBeLessThan(luminance(p.tray))
      expect(luminance(p.tray)).toBeLessThanOrEqual(luminance(p.surface))
      expect(contrast(p.surface, p.sidebar)).toBeGreaterThanOrEqual(1.12)
      // A selected sidebar row, on the fill the page really gets.
      const picked = sideFill(theme, 'side-picked')
      const misses = (['muted', 'dim', 'ok', 'warn', 'danger', 'busy'] as const).filter((role) => !(contrast(p[role], picked) >= 4.5))
      expect(misses).toEqual([])
      // Hover, and the active tab of a side panel, read at least as clearly as in Manor.
      const hover = sideFill(theme, 'side-hover')
      expect(contrast(hover, p.sidebar)).toBeGreaterThanOrEqual(contrast(sideFill('manor', 'side-hover'), COLOR_THEMES.manor.light.sidebar) - 0.002)
      expect(luminance(picked)).toBeLessThan(luminance(hover))
    })

    it(`${theme} light keeps its stage fills a visible step below the stage, selection below hover`, () => {
      const p = COLOR_THEMES[theme].light
      const selected = lightMix(theme, 'user-bg')
      const manor = COLOR_THEMES.manor.light
      expect(contrast(p.surface, p.surface2)).toBeGreaterThanOrEqual(1.12)
      // The overview's group header is surface-2 at half strength; it should read as it does in Manor.
      expect(Math.abs(contrast(p.surface, mixHex(p.surface, p.surface2, 50)) - contrast(manor.surface, mixHex(manor.surface, manor.surface2, 50)))).toBeLessThanOrEqual(0.01)
      expect(luminance(selected)).toBeLessThan(luminance(p.surface2))
      expect(luminance(lightMix(theme, 'menu-selected'))).toBeLessThan(luminance(selected))
      // Group headers and picked rows carry dim labels on these fills.
      expect(contrast(p.dim, p.surface2)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.dim, selected)).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('writes nothing for the house theme, so its tones stay exactly the stylesheet', () => {
    expect(paletteCss({ light: 'manor', dark: 'manor' })).toBe('')
    expect(paletteCss({ light: 'parchment', dark: 'manor' })).toMatch(/^html:root\[data-theme='light'\]\{[^}]*\}$/)
  })

  it('restates the stylesheet in the Manor palette, so its cards draw the real tones', () => {
    const lightBlock = styles.slice(styles.indexOf(":root[data-theme='light'] {"))
    const token = (source: string, name: string) => source.match(new RegExp(`--color-${name}: (#[0-9a-f]{6});`, 'i'))?.[1]?.toLowerCase()
    const roles: ReadonlyArray<readonly [keyof Palette, string]> = [
      ['bg', 'bg'], ['surface', 'surface'], ['surface2', 'surface-2'], ['tray', 'composer-tray'],
      ['composer', 'composer'], ['bubble', 'bubble'], ['userBubble', 'user-bubble'], ['text', 'text'],
      ['muted', 'muted'], ['dim', 'dim'], ['primary', 'primary'], ['onPrimary', 'on-primary'],
      ['ok', 'ok'], ['warn', 'warn'], ['danger', 'danger'], ['busy', 'busy'],
    ]
    for (const [role, name] of roles) {
      expect([role, token(styles, name)]).toEqual([role, COLOR_THEMES.manor.dark[role].toLowerCase()])
      expect([role, token(lightBlock, name)]).toEqual([role, COLOR_THEMES.manor.light[role].toLowerCase()])
    }
    // Dark's sidebar is the tray itself; light gives it its own step.
    expect(COLOR_THEMES.manor.dark.sidebar).toBe(COLOR_THEMES.manor.dark.tray)
    expect(token(lightBlock, 'sidebar')).toBe(COLOR_THEMES.manor.light.sidebar)
  })
})
