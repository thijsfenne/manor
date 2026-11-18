import type { Chat, WorkHandoff } from '@manor/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWorkChanges, forgetClosedWorkChanges, readWorkChangeImages, readWorkChanges, settleWorkChanges, subscribeWorkChanges, writeWorkChangeImages, writeWorkChanges } from './workChanges'
import { readWorkChangesOpen, setWorkChangesOpen } from './workProposals'

const handoff = (id: string, changes: Partial<WorkHandoff> = {}) => ({ id, state: 'active', workChatId: `session-${id}`, ...changes }) as WorkHandoff
const session = (id: string, changes: Partial<Chat> = {}) => ({ id: `session-${id}`, settledAt: null, archivedAt: null, ...changes }) as Chat

describe('Request changes texts', () => {
  beforeEach(clearWorkChanges)

  it('keeps one text per result and tells a reader only when it changed', () => {
    let told = 0
    const stop = subscribeWorkChanges(() => { told += 1 })
    writeWorkChanges('a', '- Rename the field')
    writeWorkChanges('a', '- Rename the field')
    stop()

    expect(readWorkChanges('a')).toBe('- Rename the field')
    expect(readWorkChanges('b')).toBe('')
    expect(told).toBe(1)
  })

  it('closes the field and drops the text once it was taken, and keeps text written since the send', () => {
    setWorkChangesOpen('a', true)
    setWorkChangesOpen('b', true)
    writeWorkChanges('a', '- Sent ')
    writeWorkChanges('b', 'First and more')

    settleWorkChanges('a', '- Sent')
    settleWorkChanges('b', 'First')

    expect(readWorkChangesOpen('a')).toBe(false)
    expect(readWorkChanges('a')).toBe('')
    expect(readWorkChangesOpen('b')).toBe(false)
    expect(readWorkChanges('b')).toBe('First and more')
  })

  it('drops the pictures that were sent and keeps one pasted since the send', () => {
    const sent = [{ name: 'pasted-image.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }]
    writeWorkChangeImages('a', sent)
    writeWorkChangeImages('b', sent)
    const added = [...sent, { name: 'pasted-image.jpg', dataUrl: 'data:image/jpeg;base64,BBBB' }]
    writeWorkChangeImages('b', added)

    settleWorkChanges('a', '', sent)
    settleWorkChanges('b', '', sent)

    expect(readWorkChangeImages('a')).toEqual([])
    expect(readWorkChangeImages('a')).toBe(readWorkChangeImages('none'))
    expect(readWorkChangeImages('b')).toEqual([added[1]])
  })

  it('forgets the feedback of a confirmed, withdrawn or closed result and keeps the rest', () => {
    for (const id of ['open', 'confirmed', 'withdrawn', 'settled', 'archived', 'gone']) writeWorkChanges(id, `about ${id}`)
    writeWorkChangeImages('gone', [{ name: 'pasted-image.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }])

    forgetClosedWorkChanges(
      [handoff('open'), handoff('confirmed', { goalConfirmedAt: 1 }), handoff('withdrawn', { state: 'deleted' }), handoff('settled'), handoff('archived')],
      [session('open'), session('confirmed'), session('withdrawn'), session('settled', { settledAt: 1 }), session('archived', { archivedAt: 1 })],
    )

    expect(['open', 'confirmed', 'withdrawn', 'settled', 'archived', 'gone'].filter((id) => readWorkChanges(id) !== '')).toEqual(['open'])
    expect(readWorkChangeImages('gone')).toEqual([])
  })
})
