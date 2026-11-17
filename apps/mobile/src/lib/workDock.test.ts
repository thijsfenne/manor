import { describe, expect, it } from 'vitest'

import { cardsShownInThread, workCardOut } from './workDock'

// The visible part of the thread: under the header, above the bar or composer.
const view = { top: 112, bottom: 600 }

describe('cardsShownInThread', () => {
  it('keeps a card that has not been measured yet out of the bar', () => {
    const shown = cardsShownInThread(['work:old', 'work:new'], new Set(['work:old']))
    expect([...shown]).toEqual(['work:new'])
  })
})

describe('workCardOut', () => {
  it('lists a card the list has not rendered, which sits in history', () => {
    expect(workCardOut(undefined, view, true)).toBe(true)
  })

  it('does not list a card below the visible part while the list brings its end in', () => {
    expect(workCardOut({ top: 640, bottom: 780 }, view, true)).toBe(false)
    expect(workCardOut({ top: 560, bottom: 700 }, view, true)).toBe(false)
  })

  it('lists that card when measured after a scroll, also with the user stopped near the end', () => {
    expect(workCardOut({ top: 640, bottom: 780 }, view, false)).toBe(true)
  })

  it('lists a card scrolled out above the visible part, even at the end', () => {
    expect(workCardOut({ top: -200, bottom: 120 }, view, true)).toBe(true)
  })

  it('does not list a card that shows', () => {
    expect(workCardOut({ top: 300, bottom: 440 }, view, false)).toBe(false)
  })
})
