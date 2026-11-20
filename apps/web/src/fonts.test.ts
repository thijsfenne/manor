import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyFont, MONO, readFont, SANS, SANS_FONTS } from './fonts'

let props: Map<string, string>
let store: Map<string, string>

beforeEach(() => {
  props = new Map()
  store = new Map()
  vi.stubGlobal('document', {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => props.set(name, value),
        removeProperty: (name: string) => props.delete(name),
      },
    },
  })
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('fonts', () => {
  it('overrides the token on the root for a pick and survives a reload', () => {
    applyFont(MONO, 'sf-mono')
    expect(props.has('--font-mono')).toBe(false)
    applyFont(SANS, 'inter')
    expect(props.get('--font-sans')).toMatch(/^'Inter Variable', /)
    expect(readFont(SANS)).toBe('inter')
  })

  it('hands the default back to styles.css and forgets the pick', () => {
    applyFont(SANS, 'manrope')
    applyFont(SANS, 'geist')
    expect(props.has('--font-sans')).toBe(false)
    expect(store.has(SANS.key)).toBe(false)
  })

  it('lists Geist first, then the rest from A to Z', () => {
    expect(SANS_FONTS[0].id).toBe('geist')
    const rest = SANS_FONTS.slice(1).map((font) => font.label)
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)))
    expect(SANS_FONTS.find((font) => font.id === 'figtree')).toHaveProperty('load')
  })

  it('reads an unknown stored value as the default', () => {
    store.set(MONO.key, 'comic-mono')
    expect(readFont(MONO)).toBe('sf-mono')
  })
})
