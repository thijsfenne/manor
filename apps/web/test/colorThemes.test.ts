import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COLOR_THEME_IDS, COLOR_THEMES, paletteCss, type Palette } from '../src/colorThemes'

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
  }

  it('writes nothing for the house theme, so its tones stay exactly the stylesheet', () => {
    expect(paletteCss({ light: 'manor', dark: 'manor' })).toBe('')
    expect(paletteCss({ light: 'parchment', dark: 'manor' })).toMatch(/^html:root\[data-theme='light'\]\{[^}]*\}$/)
  })

  it('restates the stylesheet in the Manor palette, so its cards draw the real tones', () => {
    const lightBlock = styles.slice(styles.indexOf(":root[data-theme='light'] {"))
    const token = (source: string, name: string) => source.match(new RegExp(`--color-${name}: (#[0-9a-f]{6});`, 'i'))?.[1]?.toLowerCase()
    const roles: ReadonlyArray<readonly [keyof Palette, string]> = [
      ['bg', 'bg'], ['surface', 'surface'], ['surface2', 'surface-2'], ['sidebar', 'composer-tray'],
      ['composer', 'composer'], ['bubble', 'bubble'], ['userBubble', 'user-bubble'], ['text', 'text'],
      ['muted', 'muted'], ['dim', 'dim'], ['primary', 'primary'], ['onPrimary', 'on-primary'],
      ['ok', 'ok'], ['warn', 'warn'], ['danger', 'danger'], ['busy', 'busy'],
    ]
    for (const [role, name] of roles) {
      expect([role, token(styles, name)]).toEqual([role, COLOR_THEMES.manor.dark[role].toLowerCase()])
      expect([role, token(lightBlock, name)]).toEqual([role, COLOR_THEMES.manor.light[role].toLowerCase()])
    }
  })
})
