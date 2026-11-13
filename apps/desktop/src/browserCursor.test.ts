import { describe, expect, it, vi } from 'vitest'
import { BrowserCursor } from './browserCursor'

function browser() {
  const sendCommand = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
    return {}
  })
  const contents = { debugger: { sendCommand }, isDestroyed: () => false }
  return { contents, sendCommand, cursor: new BrowserCursor(contents as never) }
}

describe('BrowserCursor document lifetime', () => {
  it('renders real positions in one isolated world and removes the action on completion', async () => {
    const { cursor, sendCommand } = browser()
    await cursor.show('move', { x: 12.5, y: 40 })
    await cursor.show('click', { x: 12.5, y: 40 })
    await cursor.clear()
    const renders = sendCommand.mock.calls
    const evaluations = renders.filter(([method]) => method === 'Runtime.evaluate').map(([, params]) => params)
    expect(evaluations).toHaveLength(3)
    expect(evaluations.every((params) => params?.contextId === 17)).toBe(true)
    expect(evaluations[0]?.expression).toContain('"phase":"move","x":12.5,"y":40')
    expect(evaluations[1]?.expression).toContain('"phase":"click","x":12.5,"y":40')
    expect(evaluations[2]?.expression).toMatch(/, null\)$/)
    expect(renders.filter(([method]) => method === 'Page.createIsolatedWorld')).toHaveLength(1)
  })

  it('never recreates a cursor when interruption beats context creation', async () => {
    const { cursor, sendCommand } = browser()
    let resolveFrame: (value: unknown) => void = () => {}
    sendCommand.mockImplementationOnce(() => new Promise((resolve) => { resolveFrame = resolve }))
    const showing = cursor.show('move', { x: 1, y: 2 })
    const clearing = cursor.clear()
    resolveFrame({ frameTree: { frame: { id: 'old-document' } } })
    await Promise.all([showing, clearing])
    await cursor.show('click', { x: 1, y: 2 })
    expect(sendCommand).toHaveBeenCalledTimes(1)
  })

  it('tolerates a context disappearing during navigation and clears only once', async () => {
    const { cursor, sendCommand } = browser()
    await cursor.show('move', { x: 1, y: 2 })
    sendCommand.mockRejectedValue(new Error('Execution context was destroyed'))
    await expect(Promise.all([cursor.clear(), cursor.clear()])).resolves.toEqual([undefined, undefined])
    expect(sendCommand).toHaveBeenCalledTimes(4)
    await expect(cursor.show('click', { x: 1, y: 2 })).resolves.toBeUndefined()
    expect(sendCommand).toHaveBeenCalledTimes(4)
  })

  it('does not install a surface for invalid coordinates or a destroyed tab', async () => {
    const { cursor, sendCommand, contents } = browser()
    await cursor.show('move', { x: NaN, y: 2 })
    expect(sendCommand).not.toHaveBeenCalled()
    await cursor.show('move', { x: 1, y: 2 })
    contents.isDestroyed = () => true
    await cursor.clear()
    expect(sendCommand).toHaveBeenCalledTimes(3)
  })
})
