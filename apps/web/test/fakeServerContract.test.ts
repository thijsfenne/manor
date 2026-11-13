import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { ServerMessageSchema, type ServerMessage } from '@manor/contracts'
import { afterEach, describe, expect, it } from 'vitest'

const children: ReturnType<typeof spawn>[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (port === undefined) throw new Error('could not reserve a fake-server port')
  return port
}

describe('fake server contract', () => {
  it('serves a schema-valid directory, mirrored DM markers and standing pair snapshot', async () => {
    const port = await freePort()
    const child = spawn(process.execPath, ['dev/fake-server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MANOR_FAKE_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout?.once('data', () => resolve())
    })

    const messages: ServerMessage[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake server did not return the pair snapshot')), 10_000)
      socket.onerror = () => reject(new Error('fake server websocket failed'))
      socket.onmessage = (event) => {
        const message = ServerMessageSchema.parse(JSON.parse(String(event.data)))
        messages.push(message)
        if (message.type === 'roster') {
          socket.send(JSON.stringify({ type: 'open_chat', chatId: 'pair-nova-sage' }))
        }
        if (message.type === 'snapshot' && message.chatId === 'pair-nova-sage') {
          socket.send(JSON.stringify({ type: 'open_chat', chatId: 'dm-sage' }))
        }
        if (message.type === 'snapshot' && message.chatId === 'dm-sage') {
          clearTimeout(timer)
          resolve()
        }
      }
    })
    socket.close()

    const directory = messages.find((message) => message.type === 'directory')
    expect(directory?.type === 'directory' && directory.chats.find((chat) => chat.id === 'pair-nova-sage'))
      .toMatchObject({ kind: 'pair', memberIds: ['nova', 'sage'] })
    const snapshot = messages.find(
      (message) => message.type === 'snapshot' && message.chatId === 'pair-nova-sage',
    )
    expect(snapshot?.type === 'snapshot' ? snapshot.events : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'user_message', source: 'agent_relay', authorAgentId: 'nova' }),
      expect.objectContaining({ type: 'agent_message', agentId: 'sage' }),
    ]))
    const targetDm = messages.find(
      (message) => message.type === 'snapshot' && message.chatId === 'dm-sage',
    )
    expect(targetDm?.type === 'snapshot' ? targetDm.events : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent_relay', phase: 'received', peerAgentId: 'nova' }),
      expect.objectContaining({ type: 'agent_relay', phase: 'sent', peerAgentId: 'nova' }),
    ]))
  }, 15_000)
})
