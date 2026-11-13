import { describe, expect, it } from 'vitest'
import type { ToolStep } from '../src/state'
import { currentLabel, settledLabel } from '../src/turnLabels'

const step = (tool: string, detail?: string): ToolStep => ({
  kind: 'tool',
  key: tool,
  tool,
  ...(detail === undefined ? {} : { detail }),
  status: 'done',
  startedAt: 1,
})

describe('browser activity labels', () => {
  it('describes browser MCP navigation without exposing its technical tool name', () => {
    const activity = step('mcp__browser__browser_navigate', 'https://www.example.com/')
    expect(currentLabel(activity)).toBe('Opening example.com…')
    expect(settledLabel(activity)).toBe('Opened example.com')
  })

  it.each([
    ['browser_snapshot', 'Reading the page…', 'Read the page'],
    ['browser_click', 'Clicking on the page…', 'Clicked on the page'],
    ['browser_type', 'Entering text…', 'Entered text'],
    ['browser_press', 'Using the keyboard…', 'Used the keyboard'],
    ['browser_scroll', 'Scrolling the page…', 'Scrolled the page'],
    ['browser_screenshot', 'Taking a screenshot…', 'Took a screenshot'],
    ['browser_tabs', 'Checking browser tabs…', 'Checked browser tabs'],
  ])('uses plain language for %s', (tool, current, settled) => {
    const activity = step(`mcp__browser__${tool}`, '#technical-selector')
    expect(currentLabel(activity)).toBe(current)
    expect(settledLabel(activity)).toBe(settled)
  })

  it('keeps the connector and tool identity for tools outside the browser', () => {
    expect(settledLabel(step('mcp__calendar__list_events'))).toBe(
      'Used MCP calendar.list_events',
    )
  })
})
