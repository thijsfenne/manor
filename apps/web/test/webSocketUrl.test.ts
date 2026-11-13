import { describe, expect, it } from 'vitest'
import { resolveWebSocketUrl } from '../src/webSocketUrl'

describe('resolveWebSocketUrl', () => {
  it('keeps an explicit development backend', () => {
    expect(resolveWebSocketUrl('ws://localhost:43179/ws', { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:43179/ws',
    )
  })

  it('uses the serving host for a local production build', () => {
    expect(resolveWebSocketUrl(undefined, { protocol: 'http:', host: 'localhost:43179' })).toBe(
      'ws://localhost:43179/ws',
    )
  })

  it('upgrades the socket behind an HTTPS tailnet proxy', () => {
    expect(resolveWebSocketUrl(undefined, { protocol: 'https:', host: 'manor.example.ts.net' })).toBe(
      'wss://manor.example.ts.net/ws',
    )
  })
})
