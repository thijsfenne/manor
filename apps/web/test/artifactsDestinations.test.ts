import { describe, expect, it } from 'vitest'
import { blockedReason, type ChatDestination } from '../src/components/artifacts/AddToChatButton'
import { isXPost, xPostHandle } from '../src/components/artifacts/artifact'

const destination = (usedIds: string[], unavailable?: string): ChatDestination => ({
  id: 'chat_1',
  kind: 'chat',
  label: 'Sage',
  usedIds,
  ...(unavailable === undefined ? {} : { unavailable }),
})

describe('add-to-chat destinations', () => {
  it('lets a source through when the target has room for it', () => {
    expect(blockedReason(destination([]), ['a'])).toBeUndefined()
    expect(blockedReason(destination(['a', 'b']), ['c'])).toBeUndefined()
  })

  it('refuses a target that already holds every one of them', () => {
    // Dedupe would make this a press that changes nothing while reading as success.
    expect(blockedReason(destination(['a', 'b']), ['a'])).toBe('Already there')
    expect(blockedReason(destination(['a', 'b']), ['a', 'b'])).toBe('Already there')
  })

  it('counts what is already there as free room rather than double', () => {
    expect(blockedReason(destination(['a', 'b', 'c']), ['a', 'd'])).toBe('No room left')
    expect(blockedReason(destination(['a', 'b']), ['a', 'd'])).toBeUndefined()
  })

  it('says what is left rather than calling a half-full chat full', () => {
    // Two staged and two new do not fit, but the chat is not holding three.
    expect(blockedReason(destination(['a', 'b']), ['c', 'd'])).toBe('1 slot left')
    expect(blockedReason(destination(['a']), ['b', 'c', 'd'])).toBe('2 slots left')
  })

  it('keeps a target own reason ahead of any counting', () => {
    expect(blockedReason(destination([], 'No project to start one in'), ['a'])).toBe(
      'No project to start one in',
    )
  })

  it('reads an x.com address as a post and names who wrote it', () => {
    expect(isXPost('https://x.com/Vox/status/1')).toBe(true)
    expect(isXPost('https://twitter.com/Vox/status/1')).toBe(true)
    expect(isXPost('https://example.com/x.com/fake')).toBe(false)
    expect(xPostHandle('https://x.com/Vox/status/1')).toBe('Vox')
    // The /i/ shape names nobody, so the card says so instead of inventing a handle.
    expect(xPostHandle('https://x.com/i/status/1')).toBeUndefined()
    expect(xPostHandle('https://example.com/a')).toBeUndefined()
  })
})
