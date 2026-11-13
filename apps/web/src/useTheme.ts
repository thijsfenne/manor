import { useEffect, useMemo, useState } from 'react'

/** What the user picked. `system` is a standing deferral, not a third palette. */
export type ThemeChoice = 'system' | 'light' | 'dark'

/** What is actually on screen. Only ever one of two things. */
export type Theme = 'light' | 'dark'

const KEY = 'manor:theme'

/**
 * Queried for light rather than dark, so a browser that answers nothing at all lands
 * on dark — which is the theme Manor is drawn for and the one the no-flash script in
 * index.html falls back to.
 */
const QUERY = '(prefers-color-scheme: light)'

const systemTheme = (): Theme => {
  try {
    return window.matchMedia(QUERY).matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * The theme, and the one control that changes it. Which theme is showing lives on
 * `<html data-theme>` because the stylesheet is what has to react, not the tree: a
 * React-held class would repaint every component on a switch, and the switch is a
 * repaint of the page either way.
 *
 * The same attribute is set by an inline script in index.html before first paint, so
 * this hook is never the first thing to write it — it only keeps it true.
 */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read)
  const [system, setSystem] = useState<Theme>(systemTheme)
  const theme: Theme = choice === 'system' ? system : choice

  // Followed only while the choice defers to it. An explicit pick means the OS
  // flipping at sunset is none of Manor's business.
  useEffect(() => {
    if (choice !== 'system') return
    let media: MediaQueryList
    try {
      media = window.matchMedia(QUERY)
    } catch {
      return
    }
    const onChange = () => setSystem(media.matches ? 'light' : 'dark')
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [choice])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    try {
      // `system` is stored as the absence of a choice, so a fresh browser and a
      // browser that was explicitly handed back to the OS behave the same.
      if (choice === 'system') window.localStorage.removeItem(KEY)
      else window.localStorage.setItem(KEY, choice)
    } catch {
      // Private-mode or blocked storage: the theme still switches, it just forgets.
    }
  }, [choice])

  // One object, kept, because it travels as a single prop into a memoised `NavRail`.
  // The popover and Appearance both pick a state rather than step to the next one.
  return useMemo(() => ({ choice, theme, set: setChoice }), [choice, theme])
}

function read(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}
