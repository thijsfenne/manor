import { describe, expect, test } from 'vitest'
import { rightPanelOverlays } from './useRightPanel'
import { sidebarOverlays } from './useSidebar'
import { isPhoneLayout } from './phoneLayout'

describe('responsive workspace layout', () => {
  test('turns the sidebar into a drawer only when it would break the chat floor', () => {
    expect(sidebarOverlays(375, 288)).toBe(true)
    expect(sidebarOverlays(700, 288)).toBe(true)
    expect(sidebarOverlays(768, 288)).toBe(false)
  })

  test('floats a right panel when docking would leave less than 375px for chat', () => {
    expect(rightPanelOverlays(1_024, 288 + 44, 372)).toBe(true)
    expect(rightPanelOverlays(1_280, 288 + 44, 372)).toBe(false)
    expect(rightPanelOverlays(768, 44, 372)).toBe(true)
    expect(rightPanelOverlays(800, 44, 372)).toBe(false)
  })

  test('uses the actual panel width instead of an agents-only breakpoint', () => {
    expect(rightPanelOverlays(1_024, 288 + 44, 432)).toBe(true)
    expect(rightPanelOverlays(1_280, 288 + 44, 432)).toBe(false)
  })

  test('floats a previously maximized panel when pinning the navigation sidebar', () => {
    expect(rightPanelOverlays(1_108, 0, 1_021)).toBe(true)
  })

  test('enters the phone shell from width, not a device guess', () => {
    expect(isPhoneLayout(390)).toBe(true)
    expect(isPhoneLayout(440)).toBe(true)
    expect(isPhoneLayout(600)).toBe(true)
    expect(isPhoneLayout(601)).toBe(false)
  })
})
