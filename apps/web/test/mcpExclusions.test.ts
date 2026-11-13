import { describe, expect, it } from 'vitest'
import type { AgentDraft } from '@manor/contracts'
import { setExcludedTools, toggleExcludedTool } from '../src/mcp'

/**
 * The whole-server switch behind "Restore all", and the one thing it must not do:
 * touch a server it was not aimed at.
 */

const draft = (mcpServers: AgentDraft['mcpServers']): AgentDraft =>
  ({ mcpServers }) as AgentDraft

describe('setExcludedTools', () => {
  it('restores every tool of the named server', () => {
    const next = setExcludedTools(draft([{ serverId: 'a', disabledTools: ['read', 'write'] }]), 'a', [])
    expect(next).toEqual([{ serverId: 'a', disabledTools: [] }])
  })

  it('leaves the other attachments alone', () => {
    const next = setExcludedTools(
      draft([
        { serverId: 'a', disabledTools: ['read'] },
        { serverId: 'b', disabledTools: ['write'] },
      ]),
      'a',
      [],
    )
    expect(next[1]).toEqual({ serverId: 'b', disabledTools: ['write'] })
  })

  it('does nothing for a server that is not attached, rather than inventing one', () => {
    const attachments: AgentDraft['mcpServers'] = [{ serverId: 'a', disabledTools: [] }]
    expect(setExcludedTools(draft(attachments), 'gone', ['read'])).toEqual(attachments)
  })

  it('agrees with the per-tool toggle it replaces', () => {
    const one = toggleExcludedTool(draft([{ serverId: 'a', disabledTools: [] }]), 'a', 'read')
    expect(setExcludedTools(draft([{ serverId: 'a', disabledTools: [] }]), 'a', ['read'])).toEqual(one)
  })
})
