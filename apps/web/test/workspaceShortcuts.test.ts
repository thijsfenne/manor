import { describe, expect, it } from 'vitest'
import { doorShortcut } from '../src/components/NavRail'
import { workspaceShortcut } from '../src/useWorkspaceNav'

const press = (
  key: string,
  extra: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>> = {},
) => ({
  key,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...extra,
})

describe('workspaceShortcut', () => {
  it('leaves ⌘1 to ⌘9 to the rail doors', () => {
    expect(workspaceShortcut(press('1'))).toBe(null)
    expect(doorShortcut(press('1'))).toBe(0)
    expect(doorShortcut(press('3'))).toBe(2)
    expect(doorShortcut(press('3', { shiftKey: true }))).toBe(null)
    expect(doorShortcut(press('0'))).toBe(null)
  })

  it('reads ⌘D as the list toggle and ⌘N as a new chat', () => {
    expect(workspaceShortcut(press('d'))).toBe('switch-list')
    expect(workspaceShortcut(press('n'))).toBe('new-chat')
  })

  it('keeps the browser-style history keys', () => {
    expect(workspaceShortcut(press('['))).toBe('back')
    expect(workspaceShortcut(press(']'))).toBe('forward')
  })

  it('answers to Ctrl the same as ⌘, for the web client', () => {
    expect(workspaceShortcut(press('d', { metaKey: false, ctrlKey: true }))).toBe('switch-list')
  })

  it('reads a capital from Caps Lock as the letter, but not a shifted one', () => {
    expect(workspaceShortcut(press('D'))).toBe('switch-list')
    expect(workspaceShortcut(press('D', { shiftKey: true }))).toBe(null)
  })

  it('leaves bare keys, Alt combinations and a held-down key alone', () => {
    expect(workspaceShortcut(press('d', { metaKey: false }))).toBe(null)
    expect(workspaceShortcut(press('d', { altKey: true }))).toBe(null)
    expect(workspaceShortcut(press('d', { repeat: true }))).toBe(null)
  })

  it('claims no key the composer or the browser already owns', () => {
    expect(workspaceShortcut(press('k'))).toBe(null)
    expect(workspaceShortcut(press('s'))).toBe(null)
    expect(workspaceShortcut(press('b'))).toBe(null)
  })
})
