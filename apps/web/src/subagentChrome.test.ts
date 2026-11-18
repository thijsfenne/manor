import { describe, expect, it } from 'vitest'

import { subagentChrome } from './subagentChrome'

describe('subagentChrome', () => {
  it('shows the Session chrome while no subagent is open', () => {
    expect(subagentChrome([])).toEqual({ settle: true, doors: true, panelHidden: false })
  })

  it('hides Settle, the panel doors and the panel for a subagent, at any depth', () => {
    const hidden = { settle: false, doors: false, panelHidden: true }
    expect(subagentChrome(['call-1'])).toEqual(hidden)
    expect(subagentChrome(['call-1', 'call-2'])).toEqual(hidden)
  })

  it('returns to the Session chrome once the path is empty again', () => {
    expect(subagentChrome(['call-1'].slice(1))).toEqual(subagentChrome([]))
  })
})
