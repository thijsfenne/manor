import { describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../src/useSidebar'

describe('sidebar width', () => {
  it('keeps the default between its explicit bounds', () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(288)
    expect(SIDEBAR_DEFAULT_WIDTH).toBeGreaterThan(SIDEBAR_MIN_WIDTH)
    expect(SIDEBAR_DEFAULT_WIDTH).toBeLessThan(SIDEBAR_MAX_WIDTH)
  })

  it('clamps widths at 232 and 420 pixels', () => {
    expect(clampSidebarWidth(120)).toBe(232)
    expect(clampSidebarWidth(320)).toBe(320)
    expect(clampSidebarWidth(600)).toBe(420)
  })
})
