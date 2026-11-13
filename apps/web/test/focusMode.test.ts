import { describe, expect, it } from 'vitest'
import { composerEscapeStep, focusModeKey, startsReply } from '../src/focusMode'

const key = (overrides: Partial<Parameters<typeof focusModeKey>[0]> = {}) => ({
  key: 'a', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false,
  defaultPrevented: false, isComposing: false, ...overrides,
})

describe('focusModeKey', () => {
  it('toggles on ⌘. from anywhere, but not on a held or claimed key', () => {
    expect(focusModeKey(key({ key: '.', metaKey: true }), 'field', false)).toBe('toggle')
    expect(focusModeKey(key({ key: '.', metaKey: true }), 'page', true)).toBe('toggle')
    expect(focusModeKey(key({ key: '.', metaKey: true, repeat: true }), 'page', true)).toBeNull()
    expect(focusModeKey(key({ key: '.', metaKey: true, defaultPrevented: true }), 'page', true)).toBeNull()
  })

  it('leaves on Esc from the page only', () => {
    expect(focusModeKey(key({ key: 'Escape' }), 'page', true)).toBe('exit')
    expect(focusModeKey(key({ key: 'Escape' }), 'field', true)).toBeNull()
    expect(focusModeKey(key({ key: 'Escape' }), 'dialog', true)).toBeNull()
    expect(focusModeKey(key({ key: 'Escape' }), 'page', false)).toBeNull()
  })
})

describe('startsReply', () => {
  it('starts on a printable key on the page, never on space, a shortcut or in a field', () => {
    expect(startsReply(key({ key: 'h' }), 'page')).toBe(true)
    expect(startsReply(key({ key: 'H', shiftKey: true }), 'page')).toBe(true)
    expect(startsReply(key({ key: ' ' }), 'page')).toBe(false)
    expect(startsReply(key({ key: 'k', metaKey: true }), 'page')).toBe(false)
    expect(startsReply(key({ key: 'ArrowDown' }), 'page')).toBe(false)
    expect(startsReply(key({ key: 'h' }), 'field')).toBe(false)
    expect(startsReply(key({ key: 'h', isComposing: true }), 'page')).toBe(false)
  })
})

describe('composerEscapeStep', () => {
  const idle = { menuOpen: false, plusOpen: false, focusMode: false, canClearProject: true }
  it('closes an open menu before anything else', () => {
    expect(composerEscapeStep({ ...idle, menuOpen: true, focusMode: true })).toBe('close-menu')
  })
  it('leaves reading mode before dropping the project', () => {
    expect(composerEscapeStep({ ...idle, focusMode: true })).toBe('put-away')
  })
  it('leaves the open plus menu to close itself', () => {
    expect(composerEscapeStep({ ...idle, plusOpen: true })).toBeNull()
  })
  it('drops the project only when nothing is open, and does nothing without one', () => {
    expect(composerEscapeStep(idle)).toBe('clear-project')
    expect(composerEscapeStep({ ...idle, canClearProject: false })).toBeNull()
  })
})
