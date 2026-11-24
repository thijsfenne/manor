import { describe, expect, test } from 'vitest'
import { panelDockWidth, rightPanelOverlays, sidebarFoldsForPanels } from './useRightPanel'
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

  test('folds the pinned sidebar only when that alone lets the panels dock', () => {
    // 960 wide, the sidebar at 288 and the rail with its gutter at 50: a 622 stage.
    const stage = 960 - 50 - 288
    // Agent settings: 428 + 375 floats beside the sidebar and docks without it.
    expect(sidebarFoldsForPanels(panelDockWidth([428]), stage, 288)).toBe(true)
    // A panel that docks beside the sidebar leaves it alone.
    expect(sidebarFoldsForPanels(panelDockWidth([428]), 1_000, 288)).toBe(false)
    // Wider than the stage even without the sidebar: it floats and the sidebar stays.
    expect(sidebarFoldsForPanels(panelDockWidth([720]), stage, 288)).toBe(false)
    // Two columns may give way to 300 each: 975 does not fit a 910 stage either.
    expect(sidebarFoldsForPanels(panelDockWidth([428, 412]), stage, 288)).toBe(false)
    expect(sidebarFoldsForPanels(panelDockWidth([428, 412]), 700, 288)).toBe(true)
    // Nothing open, or a panel covering the stage, asks for nothing.
    expect(sidebarFoldsForPanels(panelDockWidth([]), stage, 288)).toBe(false)
    expect(sidebarFoldsForPanels(panelDockWidth([0]), stage, 288)).toBe(false)
  })

  test('enters the phone shell from width, not a device guess', () => {
    expect(isPhoneLayout(390)).toBe(true)
    expect(isPhoneLayout(440)).toBe(true)
    expect(isPhoneLayout(600)).toBe(true)
    expect(isPhoneLayout(601)).toBe(false)
  })
})
