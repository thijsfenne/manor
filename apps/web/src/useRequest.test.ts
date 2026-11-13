import { describe, expect, it } from 'vitest'
import { requestOutcome } from './useRequest'

describe('requestOutcome', () => {
  it('settles on the matching ack without needing a broadcast', () => {
    expect(requestOutcome('save-1', { type: 'ack', requestId: 'save-1' })).toBe('ack')
  })

  it('keeps waiting through unrelated answers and settles its own refusal', () => {
    expect(requestOutcome('save-1', {
      type: 'notice',
      kind: 'error',
      text: 'Another request failed.',
      requestId: 'save-2',
    })).toBeNull()
    expect(requestOutcome('save-1', {
      type: 'notice',
      kind: 'error',
      text: 'This draft was refused.',
      requestId: 'save-1',
    })).toBe('notice')
  })

  it('leaves panel-owned responses for the requesting panel', () => {
    expect(requestOutcome('summary-1', {
      type: 'chat_summary',
      requestId: 'summary-1',
      chatId: 'dm_sage',
      summary: null,
    })).toBeNull()
  })
})
