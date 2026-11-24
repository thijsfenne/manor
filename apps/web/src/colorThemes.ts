import { DEFAULT_HOUSE_SETTINGS, type ColorTheme, type HouseSettings } from '@manor/contracts'

/**
 * The colour themes on the Appearance page. The mode (System, Light, Dark) picks which
 * side shows; the user picks a theme for each side, and the two may differ.
 *
 * `manor` is the stylesheet itself: its palette restates the tokens in styles.css so
 * its card draws true, and picking it writes nothing, so the house tones stay exactly
 * as styles.css has them. Any other theme is written over those tokens by `paletteCss`.
 */

export type Mode = 'light' | 'dark'

/** The roles a theme sets. Every other token is derived from them in `modeTokens`. */
export interface Palette {
  bg: string
  /** The stage, settings page and menus. Only Manor's light side is pure white; the
      other themes keep their own tinted canvas there, so nothing reads as bare paper. */
  surface: string
  /** Group headers, hover and selected fills on the stage. Light keeps Manor's step below
      `surface` (about 0.045 OKLCH L), hue taken from `bubble`, so those fills read on a tint. */
  surface2: string
  /** The left sidebar and the panels docked right. In light it sits a clear step below `surface`. */
  sidebar: string
  /** Cards on the stage: the strip under the composer, Changed files, tasks. Light keeps it
      lighter than `sidebar`, so the stage's own hover fills still read on it. */
  tray: string
  composer: string
  /** The agent's reply bubble on the stage; keeps about Manor's lightness step below `surface`. */
  bubble: string
  userBubble: string
  line: string
  text: string
  muted: string
  dim: string
  primary: string
  onPrimary: string
  /** The theme's own hue. Only its card's orbs show it; the house's one loud colour stays `primary`. */
  accent: string
  ok: string
  warn: string
  danger: string
  busy: string
}

interface ThemeDefinition {
  label: string
  description: string
  light: Palette
  dark: Palette
}

export const COLOR_THEMES: Record<ColorTheme, ThemeDefinition> = {
  manor: {
    label: 'Manor',
    description: 'Neutral graphite, teal',
    light: { bg: '#f7f8fa', surface: '#ffffff', surface2: '#eef0f3', sidebar: '#f0f1f3', tray: '#f3f4f6', composer: '#ffffff', bubble: '#eff1f4', userBubble: '#e3e5e9', line: 'rgba(0,0,0,0.11)', text: '#16181b', muted: '#565b66', dim: '#616773', primary: '#16181b', onPrimary: '#ffffff', accent: '#388B83', ok: '#056b4b', warn: '#8a5d00', danger: '#b02c24', busy: '#1155cc' },
    dark: { bg: '#0c0d0e', surface: '#0f1011', surface2: '#191a1b', sidebar: '#121314', tray: '#121314', composer: '#171819', bubble: '#191a1b', userBubble: '#26262b', line: 'rgba(255,255,255,0.08)', text: '#f7f8f8', muted: '#8a8f98', dim: '#62666d', primary: '#f7f8f8', onPrimary: '#08090a', accent: '#388B83', ok: '#10b981', warn: '#f2c94c', danger: '#eb5757', busy: '#4a9eff' },
  },
  parchment: {
    label: 'Parchment',
    description: 'Warm cream and brown',
    light: { bg: '#fffcf5', surface: '#fffcf5', surface2: '#f3ecdd', sidebar: '#f2eee4', tray: '#fefaef', composer: '#fffcf5', bubble: '#f4edde', userBubble: '#f8f1e2', line: 'rgba(45,30,10,0.13)', text: '#1a1612', muted: '#5d5549', dim: '#6c6355', primary: '#1a1612', onPrimary: '#fbf8f0', accent: '#bf5a38', ok: '#3a6b32', warn: '#85590a', danger: '#ad2440', busy: '#2c66a0' },
    dark: { bg: '#0f0a05', surface: '#120c08', surface2: '#1e160d', sidebar: '#160f08', tray: '#160f08', composer: '#1c140c', bubble: '#1e160d', userBubble: '#2d2216', line: 'rgba(255,232,200,0.10)', text: '#f8f2e8', muted: '#b0a291', dim: '#877968', primary: '#f8f2e8', onPrimary: '#19130d', accent: '#d97757', ok: '#86b46c', warn: '#e5b454', danger: '#f2607a', busy: '#6aa9e9' },
  },
  indigo: {
    label: 'Indigo',
    description: 'Navy and blue',
    light: { bg: '#fbfcff', surface: '#fbfcff', surface2: '#e9edf7', sidebar: '#eceef3', tray: '#f7faff', composer: '#fbfcff', bubble: '#eaeef8', userBubble: '#ecf2ff', line: 'rgba(20,40,95,0.13)', text: '#111a2e', muted: '#48556f', dim: '#586480', primary: '#111a2e', onPrimary: '#ffffff', accent: '#2f62d8', ok: '#0b6e4f', warn: '#855a00', danger: '#b32d3a', busy: '#0a6a94' },
    dark: { bg: '#060a18', surface: '#080d1d', surface2: '#0f172b', sidebar: '#0a1022', tray: '#0a1022', composer: '#0e1428', bubble: '#0f172b', userBubble: '#182240', line: 'rgba(160,185,255,0.12)', text: '#f1f4fb', muted: '#939fbc', dim: '#68748f', primary: '#f1f4fb', onPrimary: '#0b1020', accent: '#5b8def', ok: '#34c38f', warn: '#f0c24f', danger: '#f0626e', busy: '#5cc4f2' },
  },
  moss: {
    label: 'Moss',
    description: 'Forest and sage',
    light: { bg: '#fbfdf5', surface: '#fbfdf5', surface2: '#eaefdf', sidebar: '#ecefe5', tray: '#f8fcf1', composer: '#fbfdf5', bubble: '#ebf0e0', userBubble: '#edf5e3', line: 'rgba(30,50,20,0.13)', text: '#151c13', muted: '#4b5647', dim: '#5c6757', primary: '#151c13', onPrimary: '#ffffff', accent: '#557a26', ok: '#0a6a70', warn: '#855a00', danger: '#b0302a', busy: '#1c5fb0' },
    dark: { bg: '#060d08', surface: '#08100a', surface2: '#0c1c11', sidebar: '#09130d', tray: '#09130d', composer: '#0d1911', bubble: '#0c1c11', userBubble: '#132a1b', line: 'rgba(190,235,200,0.10)', text: '#f0f5ef', muted: '#9aab9e', dim: '#67786b', primary: '#f0f5ef', onPrimary: '#0b140e', accent: '#90b354', ok: '#2cc4b8', warn: '#e8c04f', danger: '#ee6a5f', busy: '#5aa7f2' },
  },
  plum: {
    label: 'Plum',
    description: 'Aubergine and lilac',
    light: { bg: '#fefbff', surface: '#fefbff', surface2: '#f3e9f7', sidebar: '#f1ecf3', tray: '#fdf8ff', composer: '#fefbff', bubble: '#f4eaf8', userBubble: '#f9edff', line: 'rgba(60,20,75,0.13)', text: '#1e1422', muted: '#594b60', dim: '#6d5f73', primary: '#1e1422', onPrimary: '#ffffff', accent: '#8e3fa6', ok: '#0b6b48', warn: '#855a00', danger: '#b3301c', busy: '#1e58c0' },
    dark: { bg: '#0f0812', surface: '#120a16', surface2: '#1f1124', sidebar: '#160c1a', tray: '#160c1a', composer: '#1c1021', bubble: '#1f1124', userBubble: '#2e1b36', line: 'rgba(235,200,250,0.10)', text: '#f6f0f7', muted: '#ab9ab0', dim: '#7d6d83', primary: '#f6f0f7', onPrimary: '#150c18', accent: '#bb7fd9', ok: '#3fbf8a', warn: '#ecc050', danger: '#f2684e', busy: '#5aa6f5' },
  },
}

export const COLOR_THEME_IDS = Object.keys(COLOR_THEMES) as ColorTheme[]

export interface ThemePair {
  light: ColorTheme
  dark: ColorTheme
}

export const DEFAULT_THEMES: ThemePair = { light: DEFAULT_HOUSE_SETTINGS.lightTheme, dark: DEFAULT_HOUSE_SETTINGS.darkTheme }

/** The theme on screen in `mode`; the house tones until the settings record arrives. */
export const stageTheme = (settings: HouseSettings | null, mode: Mode): ColorTheme =>
  settings === null ? 'manor' : mode === 'light' ? settings.lightTheme : settings.darkTheme

const mix = (a: string, b: string, share: number) => `color-mix(in srgb, ${a} ${100 - share}%, ${b})`

/**
 * Every token a theme moves, from its roles. Each derived token keeps the relation it
 * has to the roles in Manor's own values in styles.css: the dark room lifts toward
 * `text`, the light room sinks toward it, so a tinted theme keeps its tint on every step.
 * What no theme moves stays out: persona and project colours, fonts, provider logos,
 * syntax and file-type colours, media scrims, the browser page plate and the shadows.
 */
export function modeTokens(palette: Palette, mode: Mode): Record<string, string> {
  const p = palette
  const dark = mode === 'dark'
  // Light selection sinks from the stage fill toward text, so hover < user-bg < menu-selected in every theme.
  const lightUserBg = mix(p.surface2, p.text, 3)
  return {
    bg: p.bg,
    surface: p.surface,
    'surface-2': p.surface2,
    field: dark ? p.surface2 : mix(p.surface, p.surface2, 60),
    'icon-fill': dark ? p.surface2 : lightUserBg,
    'tree-hover': dark ? p.surface2 : mix(p.surface2, p.text, 1),
    'user-bg': dark ? p.userBubble : lightUserBg,
    ...(dark ? {} : { 'side-hover': mix(p.sidebar, p.text, 3.5), 'side-picked': mix(p.sidebar, p.text, 5) }),
    'menu-selected': dark ? mix(p.userBubble, p.text, 9) : mix(p.surface2, p.text, 8),
    'user-bubble': p.userBubble,
    bubble: p.bubble,
    raised: dark ? p.surface2 : p.surface,
    composer: p.composer,
    ...(dark ? {} : { 'composer-line': `color-mix(in srgb, ${p.text} 18%, transparent)` }),
    'composer-tray': p.tray,
    sidebar: p.sidebar,
    ...(dark ? {} : { frame: mix(p.sidebar, p.text, 5), 'frame-fill': mix(p.sidebar, p.text, 12) }),
    picked: dark ? mix(p.bg, p.text, 42) : mix(p.bg, p.text, 15),
    line: p.line,
    text: p.text,
    muted: p.muted,
    dim: p.dim,
    primary: p.primary,
    'primary-hover': mix(p.primary, dark ? '#ffffff' : '#000000', 50),
    'on-primary': p.onPrimary,
    control: dark ? p.userBubble : mix(p.text, p.muted, 65),
    ok: p.ok,
    warn: p.warn,
    'warn-fill': dark ? p.warn : `oklch(from ${p.warn} calc(l + 0.13) c h)`,
    danger: p.danger,
    busy: p.busy,
    ...(dark ? {} : { scrim: `color-mix(in srgb, ${p.text} 32%, transparent)` }),
  }
}

/**
 * The stylesheet that lays the picked themes over the tokens, or '' for Manor on both
 * sides. `html:root[data-theme]` outranks the `:root[data-theme='light']` block in
 * styles.css by one element, so the order the two sheets load in does not matter.
 */
export function paletteCss(themes: ThemePair): string {
  return (['light', 'dark'] as const)
    .filter((mode) => themes[mode] !== 'manor')
    .map((mode) => {
      const tokens = modeTokens(COLOR_THEMES[themes[mode]][mode], mode)
      const lines = Object.entries(tokens).map(([name, value]) => `--color-${name}:${value};`)
      return `html:root[data-theme='${mode}']{${lines.join('')}}`
    })
    .join('\n')
}

/** Read by the inline script in index.html before first paint; keep the two in step. */
export const PALETTE_STORAGE_KEY = 'manor:palette'
const STYLE_ID = 'manor-palette'

/**
 * Writes the themes onto the page and remembers the sheet for the next first paint. The
 * settings record is the source; this cache only spares a reload the flash of the house
 * tones before the server's settings arrive.
 */
export function applyThemes(themes: ThemePair): void {
  const css = paletteCss(themes)
  let style = document.getElementById(STYLE_ID)
  if (css === '') style?.remove()
  else {
    if (style === null) {
      style = document.createElement('style')
      style.id = STYLE_ID
      document.head.append(style)
    }
    if (style.textContent !== css) style.textContent = css
  }
  try {
    if (css === '') window.localStorage.removeItem(PALETTE_STORAGE_KEY)
    else window.localStorage.setItem(PALETTE_STORAGE_KEY, css)
  } catch {
    // Blocked storage: the themes still apply, the next reload shows the house tones first.
  }
}
