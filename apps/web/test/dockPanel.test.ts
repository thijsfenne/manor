import { describe, expect, it } from 'vitest'
import { browserPanelLayoutClass } from '../src/components/BrowserPanel'
import { sideChatPanelLayoutClass } from '../src/components/SideChatPanel'
import { dockPanelLayoutClass } from '../src/components/ui/dockPanel'

const FILES_WIDTH = 'w-[calc(var(--files-width)-8px)]'
const files = (expanded: boolean) => dockPanelLayoutClass(FILES_WIDTH, expanded)

describe('the shared dock layout', () => {
  it('gives both resizable panels the same geometry at the same state', () => {
    for (const expanded of [false, true]) {
      expect(files(expanded).replace(FILES_WIDTH, 'W')).toBe(
        browserPanelLayoutClass(expanded).replace('w-[calc(var(--browser-width)-8px)]', 'W'),
      )
    }
  })

  it('puts the side chat on the same docked overlay as the others, without expand', () => {
    expect(sideChatPanelLayoutClass().replace('w-[calc(var(--side-width)-8px)]', 'W')).toBe(
      files(false).replace(FILES_WIDTH, 'W'),
    )
  })

  it('goes full screen and back without motion', () => {
    expect(files(true)).toContain('absolute inset-y-0 right-0')
    expect(files(false)).toContain('relative')
    expect(files(true)).not.toContain('transition')
    expect(files(false)).not.toContain('transition')
  })
})
