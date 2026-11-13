import { describe, expect, it } from 'vitest'
import { applyDirectoryPatch, type Chat, type DirectoryMessage } from '@manor/contracts'
import { createDirectoryChannel } from '../src/directoryChannel.js'

const chat = (id: string, title = id): Chat => ({
  id, projectId: null, kind: 'dm', routineId: null, parentChatId: null, sideModel: null, sideEffort: null,
  memberIds: [], agentIds: [], title, createdAt: 1, lastMessageAt: 1, lastMessagePreview: null,
  settledAt: null, archivedAt: null, checkout: { mode: 'current', branch: null },
})
const listing = (chats: Chat[]): DirectoryMessage => ({ type: 'directory', projects: [], chats, workHandoffs: [] })
const PATCHING = '/ws?token=secret&directory=patch'

describe('directory channel', () => {
  it('sends a patching socket its first listing whole and every later one as a patch against it', () => {
    const channel = createDirectoryChannel()
    const socket = {}
    channel.connect(socket, PATCHING)
    const first = listing([chat('a'), chat('b')])
    const second = listing([chat('a'), chat('b', 'Renamed')])
    expect(JSON.parse(channel.payload(socket, first))).toEqual(first)
    const patch = JSON.parse(channel.payload(socket, second))
    expect(patch).toEqual({ type: 'directory_patch', projects: { changed: [] }, chats: { changed: [chat('b', 'Renamed')] }, workHandoffs: { changed: [] } })
    expect(applyDirectoryPatch(first, patch)).toEqual(second)
  })

  it('always sends a socket that did not opt in the whole listing', () => {
    const channel = createDirectoryChannel()
    const socket = {}
    channel.connect(socket, '/ws?token=secret')
    const second = listing([chat('a', 'Renamed')])
    channel.payload(socket, listing([chat('a')]))
    expect(JSON.parse(channel.payload(socket, second))).toEqual(second)
  })

  it('patches each socket against the listing that socket holds', () => {
    const channel = createDirectoryChannel()
    const early = {}
    const late = {}
    channel.connect(early, PATCHING)
    channel.connect(late, PATCHING)
    const first = listing([chat('a')])
    const second = listing([chat('a'), chat('b')])
    const third = listing([chat('a', 'Renamed'), chat('b')])
    channel.payload(early, first)
    channel.payload(early, second)
    channel.payload(late, second)
    channel.payload(late, third)
    const next = listing([chat('a', 'Renamed'), chat('b'), chat('c')])
    const fromSecond = channel.payload(early, next)
    const fromThird = channel.payload(late, next)
    expect(fromSecond).not.toBe(fromThird)
    expect(applyDirectoryPatch(second, JSON.parse(fromSecond))).toEqual(next)
    expect(applyDirectoryPatch(third, JSON.parse(fromThird))).toEqual(next)
  })
})
