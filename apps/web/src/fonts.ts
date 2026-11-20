/**
 * The interface and code fonts the Appearance page offers. Every face is bundled through
 * Fontsource, so nothing reaches the network and the page CSP keeps `font-src 'self'`.
 * Only the defaults sit in the main stylesheet: any other face loads its own CSS chunk
 * once it is chosen, or once its menu opens to draw the names in their own fonts.
 *
 * A choice lands on `<html>` as `--font-sans` or `--font-mono`, overriding the theme
 * token in styles.css, so a pick repaints at once with no reload. The default is the
 * absence of an override, which keeps styles.css the one place the default stack lives.
 */

export interface FontOption<Id extends string = string> {
  id: Id
  label: string
  /** The full `font-family` value, own face first, then the house fallbacks. */
  stack: string
  /** Absent for a face the main stylesheet already declares. */
  load?: () => Promise<unknown>
}

const SANS_TAIL = "'SF Pro Rounded', ui-rounded, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const MONO_TAIL = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace"

const sans = <Id extends string>(id: Id, label: string, family: string, load?: () => Promise<unknown>): FontOption<Id> => ({
  id,
  label,
  stack: `'${family}', ${SANS_TAIL}`,
  ...(load === undefined ? {} : { load }),
})

const mono = <Id extends string>(id: Id, label: string, family: string, load: () => Promise<unknown>): FontOption<Id> => ({
  id,
  label,
  stack: `'${family}', ${MONO_TAIL}`,
  load,
})

/* Figtree, Instrument Sans and Geist are imported by styles.css as part of the default stack.
   After the default the list runs alphabetically. Faces without an italic cut get a slanted upright. */
export const SANS_FONTS = [
  sans('figtree', 'Figtree', 'Figtree Variable'),
  sans('albert-sans', 'Albert Sans', 'Albert Sans Variable', () => Promise.all([import('@fontsource-variable/albert-sans'), import('@fontsource-variable/albert-sans/wght-italic.css')])),
  sans('archivo', 'Archivo', 'Archivo Variable', () => Promise.all([import('@fontsource-variable/archivo'), import('@fontsource-variable/archivo/wght-italic.css')])),
  sans('atkinson-hyperlegible-next', 'Atkinson Hyperlegible Next', 'Atkinson Hyperlegible Next Variable', () => Promise.all([import('@fontsource-variable/atkinson-hyperlegible-next'), import('@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css')])),
  // No variable cut exists, so the two house weights come as static files.
  sans('be-vietnam-pro', 'Be Vietnam Pro', 'Be Vietnam Pro', () =>
    Promise.all([import('@fontsource/be-vietnam-pro/400.css'), import('@fontsource/be-vietnam-pro/500.css'), import('@fontsource/be-vietnam-pro/400-italic.css'), import('@fontsource/be-vietnam-pro/500-italic.css')]),
  ),
  sans('bricolage-grotesque', 'Bricolage Grotesque', 'Bricolage Grotesque Variable', () => import('@fontsource-variable/bricolage-grotesque')),
  sans('dm-sans', 'DM Sans', 'DM Sans Variable', () => Promise.all([import('@fontsource-variable/dm-sans'), import('@fontsource-variable/dm-sans/wght-italic.css')])),
  // No variable cut exists, so the two house weights come as static files.
  sans('fira-sans', 'Fira Sans', 'Fira Sans', () =>
    Promise.all([import('@fontsource/fira-sans/400.css'), import('@fontsource/fira-sans/500.css'), import('@fontsource/fira-sans/400-italic.css'), import('@fontsource/fira-sans/500-italic.css')]),
  ),
  sans('geist', 'Geist', 'Geist Variable'),
  sans('hanken-grotesk', 'Hanken Grotesk', 'Hanken Grotesk Variable', () => Promise.all([import('@fontsource-variable/hanken-grotesk'), import('@fontsource-variable/hanken-grotesk/wght-italic.css')])),
  sans('ibm-plex-sans', 'IBM Plex Sans', 'IBM Plex Sans Variable', () => Promise.all([import('@fontsource-variable/ibm-plex-sans'), import('@fontsource-variable/ibm-plex-sans/wght-italic.css')])),
  sans('instrument-sans', 'Instrument Sans', 'Instrument Sans Variable'),
  sans('inter', 'Inter', 'Inter Variable', () => Promise.all([import('@fontsource-variable/inter'), import('@fontsource-variable/inter/wght-italic.css')])),
  sans('karla', 'Karla', 'Karla Variable', () => Promise.all([import('@fontsource-variable/karla'), import('@fontsource-variable/karla/wght-italic.css')])),
  // No variable cut, and no 500 either: Lato's medium text shows at 400.
  sans('lato', 'Lato', 'Lato', () => Promise.all([import('@fontsource/lato/400.css'), import('@fontsource/lato/400-italic.css')])),
  sans('lexend', 'Lexend', 'Lexend Variable', () => import('@fontsource-variable/lexend')),
  sans('libre-franklin', 'Libre Franklin', 'Libre Franklin Variable', () => Promise.all([import('@fontsource-variable/libre-franklin'), import('@fontsource-variable/libre-franklin/wght-italic.css')])),
  sans('manrope', 'Manrope', 'Manrope Variable', () => import('@fontsource-variable/manrope')),
  sans('montserrat', 'Montserrat', 'Montserrat Variable', () => Promise.all([import('@fontsource-variable/montserrat'), import('@fontsource-variable/montserrat/wght-italic.css')])),
  sans('mulish', 'Mulish', 'Mulish Variable', () => Promise.all([import('@fontsource-variable/mulish'), import('@fontsource-variable/mulish/wght-italic.css')])),
  sans('noto-sans', 'Noto Sans', 'Noto Sans Variable', () => Promise.all([import('@fontsource-variable/noto-sans'), import('@fontsource-variable/noto-sans/wght-italic.css')])),
  sans('nunito-sans', 'Nunito Sans', 'Nunito Sans Variable', () => Promise.all([import('@fontsource-variable/nunito-sans'), import('@fontsource-variable/nunito-sans/wght-italic.css')])),
  sans('onest', 'Onest', 'Onest Variable', () => import('@fontsource-variable/onest')),
  sans('open-sans', 'Open Sans', 'Open Sans Variable', () => Promise.all([import('@fontsource-variable/open-sans'), import('@fontsource-variable/open-sans/wght-italic.css')])),
  sans('outfit', 'Outfit', 'Outfit Variable', () => import('@fontsource-variable/outfit')),
  sans('plus-jakarta-sans', 'Plus Jakarta Sans', 'Plus Jakarta Sans Variable', () => Promise.all([import('@fontsource-variable/plus-jakarta-sans'), import('@fontsource-variable/plus-jakarta-sans/wght-italic.css')])),
  // No variable cut exists, so the two house weights come as static files.
  sans('poppins', 'Poppins', 'Poppins', () =>
    Promise.all([import('@fontsource/poppins/400.css'), import('@fontsource/poppins/500.css'), import('@fontsource/poppins/400-italic.css'), import('@fontsource/poppins/500-italic.css')]),
  ),
  sans('public-sans', 'Public Sans', 'Public Sans Variable', () => Promise.all([import('@fontsource-variable/public-sans'), import('@fontsource-variable/public-sans/wght-italic.css')])),
  sans('raleway', 'Raleway', 'Raleway Variable', () => Promise.all([import('@fontsource-variable/raleway'), import('@fontsource-variable/raleway/wght-italic.css')])),
  sans('red-hat-text', 'Red Hat Text', 'Red Hat Text Variable', () => Promise.all([import('@fontsource-variable/red-hat-text'), import('@fontsource-variable/red-hat-text/wght-italic.css')])),
  sans('roboto', 'Roboto', 'Roboto Variable', () => Promise.all([import('@fontsource-variable/roboto'), import('@fontsource-variable/roboto/wght-italic.css')])),
  sans('rubik', 'Rubik', 'Rubik Variable', () => Promise.all([import('@fontsource-variable/rubik'), import('@fontsource-variable/rubik/wght-italic.css')])),
  sans('schibsted-grotesk', 'Schibsted Grotesk', 'Schibsted Grotesk Variable', () => Promise.all([import('@fontsource-variable/schibsted-grotesk'), import('@fontsource-variable/schibsted-grotesk/wght-italic.css')])),
  sans('sora', 'Sora', 'Sora Variable', () => import('@fontsource-variable/sora')),
  sans('source-sans-3', 'Source Sans 3', 'Source Sans 3 Variable', () => Promise.all([import('@fontsource-variable/source-sans-3'), import('@fontsource-variable/source-sans-3/wght-italic.css')])),
  sans('space-grotesk', 'Space Grotesk', 'Space Grotesk Variable', () => import('@fontsource-variable/space-grotesk')),
  sans('spline-sans', 'Spline Sans', 'Spline Sans Variable', () => import('@fontsource-variable/spline-sans')),
  sans('urbanist', 'Urbanist', 'Urbanist Variable', () => Promise.all([import('@fontsource-variable/urbanist'), import('@fontsource-variable/urbanist/wght-italic.css')])),
  sans('work-sans', 'Work Sans', 'Work Sans Variable', () => Promise.all([import('@fontsource-variable/work-sans'), import('@fontsource-variable/work-sans/wght-italic.css')])),
] as const

/* SF Mono is the system face, never bundled. Code has no italics, so only uprights load. */
export const MONO_FONTS = [
  { id: 'sf-mono', label: 'SF Mono', stack: MONO_TAIL },
  // No variable cut exists, so the two house weights come as static files.
  mono('dm-mono', 'DM Mono', 'DM Mono', () => Promise.all([import('@fontsource/dm-mono/400.css'), import('@fontsource/dm-mono/500.css')])),
  mono('fira-code', 'Fira Code', 'Fira Code Variable', () => import('@fontsource-variable/fira-code')),
  mono('geist-mono', 'Geist Mono', 'Geist Mono Variable', () => import('@fontsource-variable/geist-mono')),
  // No variable cut exists, so the two house weights come as static files.
  mono('ibm-plex-mono', 'IBM Plex Mono', 'IBM Plex Mono', () => Promise.all([import('@fontsource/ibm-plex-mono/400.css'), import('@fontsource/ibm-plex-mono/500.css')])),
  mono('inconsolata', 'Inconsolata', 'Inconsolata Variable', () => import('@fontsource-variable/inconsolata')),
  mono('jetbrains-mono', 'JetBrains Mono', 'JetBrains Mono Variable', () => import('@fontsource-variable/jetbrains-mono')),
  mono('martian-mono', 'Martian Mono', 'Martian Mono Variable', () => import('@fontsource-variable/martian-mono')),
  mono('red-hat-mono', 'Red Hat Mono', 'Red Hat Mono Variable', () => import('@fontsource-variable/red-hat-mono')),
  mono('roboto-mono', 'Roboto Mono', 'Roboto Mono Variable', () => import('@fontsource-variable/roboto-mono')),
  mono('source-code-pro', 'Source Code Pro', 'Source Code Pro Variable', () => import('@fontsource-variable/source-code-pro')),
  // No variable cut and no 500 either: Space Mono's medium text shows at 400.
  mono('space-mono', 'Space Mono', 'Space Mono', () => import('@fontsource/space-mono/400.css')),
  mono('spline-sans-mono', 'Spline Sans Mono', 'Spline Sans Mono Variable', () => import('@fontsource-variable/spline-sans-mono')),
  // No variable cut and no 500 either: Ubuntu Mono's medium text shows at 400.
  mono('ubuntu-mono', 'Ubuntu Mono', 'Ubuntu Mono', () => import('@fontsource/ubuntu-mono/400.css')),
  mono('victor-mono', 'Victor Mono', 'Victor Mono Variable', () => import('@fontsource-variable/victor-mono')),
] as const satisfies readonly FontOption[]

export type SansFont = (typeof SANS_FONTS)[number]['id']
export type MonoFont = (typeof MONO_FONTS)[number]['id']

/** One of the two pickers: its fonts, the token it overrides and where the pick is kept. */
export interface FontKind<Id extends string> {
  fonts: readonly FontOption<Id>[]
  variable: '--font-sans' | '--font-mono'
  key: string
}

export const SANS: FontKind<SansFont> = { fonts: SANS_FONTS, variable: '--font-sans', key: 'manor:font' }
export const MONO: FontKind<MonoFont> = { fonts: MONO_FONTS, variable: '--font-mono', key: 'manor:code-font' }

/** The first font of a list is its default. */
export const defaultFont = <Id extends string>(kind: FontKind<Id>): FontOption<Id> => kind.fonts[0] as FontOption<Id>

export const fontOf = <Id extends string>(kind: FontKind<Id>, id: Id): FontOption<Id> =>
  kind.fonts.find((font) => font.id === id) ?? defaultFont(kind)

/** A failed chunk leaves the fallback stack showing, which is the right thing to see. */
export const loadFont = (font: FontOption): void => {
  void font.load?.().catch(() => undefined)
}

/** Every face of a list, so an open menu can draw each name in its own font. */
export const loadFonts = (kind: FontKind<string>): void => kind.fonts.forEach(loadFont)

export function readFont<Id extends string>(kind: FontKind<Id>): Id {
  try {
    const stored = window.localStorage.getItem(kind.key)
    const match = kind.fonts.find((font) => font.id === stored)
    return (match ?? defaultFont(kind)).id
  } catch {
    return defaultFont(kind).id
  }
}

/** Puts the font on screen and, unless it is the default, remembers it on this device. */
export function applyFont<Id extends string>(kind: FontKind<Id>, id: Id): void {
  const font = fontOf(kind, id)
  const root = document.documentElement.style
  const isDefault = font.id === defaultFont(kind).id
  loadFont(font)
  if (isDefault) root.removeProperty(kind.variable)
  else root.setProperty(kind.variable, font.stack)
  try {
    // The default is stored as no choice, the way the theme stores `system`.
    if (isDefault) window.localStorage.removeItem(kind.key)
    else window.localStorage.setItem(kind.key, font.id)
  } catch {
    // Blocked storage: the font still changes, it is only forgotten on reload.
  }
}

/** Called once before the first render, so a stored pick starts loading with the app. */
export function applyStoredFonts(): void {
  applyFont(SANS, readFont(SANS))
  applyFont(MONO, readFont(MONO))
}
