import { WORK_CHANGES_LIMIT, clearWorkChanges, readWorkChanges, writeWorkChanges } from '@manor/client-runtime/work-changes'
import { readWorkChangesOpen, setWorkChangesOpen } from '@manor/client-runtime/work-proposals'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkChangesField } from '../src/components/WorkChangesField'
import { WorkResultBody, type WorkResultActions } from '../src/components/WorkResultBody'
import { Button } from '../src/components/ui/Button'
import type { RequestEvents, RequestResponse } from '../src/useRequest'
import { sendWorkChanges } from '../src/workChanges'

// The editor needs a DOM; these tests only read the field's buttons.
vi.mock('../src/components/ComposerEditor', () => ({ ComposerEditor: () => null }))

function socket() {
  const listeners = new Set<(response: RequestResponse) => void>()
  const events: RequestEvents = { subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const answer = (response: RequestResponse) => { for (const listener of [...listeners]) listener(response) }
  return { events, answer, listening: () => listeners.size }
}

/** The store itself is tested in `packages/client-runtime/src/workChanges.test.ts`. */
describe('Request changes drafts', () => {
  beforeEach(clearWorkChanges)

  // Nothing of the field that sent it is left by then: the user may have opened another chat.
  it('drops the draft when the server takes it, keeps it on a refusal, and stops listening either way', () => {
    const { events, answer, listening } = socket()
    writeWorkChanges('a', '- Sent ')
    writeWorkChanges('b', 'Refused')

    expect(sendWorkChanges(events, 'a', '- Sent', 'r1', () => true)).toBe(true)
    expect(sendWorkChanges(events, 'b', 'Refused', 'r2', () => true)).toBe(true)
    answer({ type: 'ack', requestId: 'r1' })
    answer({ type: 'notice', requestId: 'r2', kind: 'error', text: 'No.' })

    expect(readWorkChanges('a')).toBe('')
    expect(readWorkChanges('b')).toBe('Refused')
    expect(listening()).toBe(0)
  })

  it('keeps text written after the send, and does not listen when the send never left', () => {
    const { events, answer, listening } = socket()
    writeWorkChanges('a', 'First')
    sendWorkChanges(events, 'a', 'First', 'r1', () => true)
    writeWorkChanges('a', 'First and more')
    answer({ type: 'ack', requestId: 'r1' })

    expect(readWorkChanges('a')).toBe('First and more')
    expect(sendWorkChanges(events, 'a', 'First and more', 'r2', () => false)).toBe(false)
    expect(listening()).toBe(0)
  })

  it('will not send feedback past the wire limit and says by how much', () => {
    writeWorkChanges('a', 'x'.repeat(WORK_CHANGES_LIMIT + 2))
    let view!: ReturnType<typeof create>
    act(() => { view = create(<WorkChangesField handoffId="a" connected pending={false} autoFocus={false} onCancel={() => undefined} onSend={() => undefined} />) })

    const send = view.root.findAllByType(Button).find((button) => button.props.children === 'Send to Session')!
    expect(send.props.disabled).toBe(true)
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toBe('2 characters over the 40,000 limit')
    act(() => view.unmount())
  })

  // The Session starts working the moment the revision lands, which takes the card's
  // actions away before the ack, so only the send's own listener sees the answer.
  it('starts the next result closed once the request was sent, even when the card lost its actions before the ack', () => {
    const { events, answer } = socket()
    let sentAs = ''
    const result = { handoffId: 'a', workChatId: 'w', version: 1, result: 'Done.', leadAgentName: 'Wren', files: 1, operation: 'commit', worktree: false, decision: 'open', evidence: [] } as const
    const actions: WorkResultActions = {
      requestEvents: events, connected: true, accept: () => true, retry: () => true, askCheckout: () => undefined,
      revise: (_handoffId, _version, _text, requestId) => { sentAs = requestId; return true },
    }
    const card = (version: number, live: boolean) => <WorkResultBody result={{ ...result, version }} {...(live ? { actions } : {})} />
    const buttons = (view: ReturnType<typeof create>) => view.root.findAllByType(Button).map((button) => button.props.children)
    setWorkChangesOpen('a', true)
    writeWorkChanges('a', 'Move it 1px')
    let view!: ReturnType<typeof create>
    act(() => { view = create(card(1, true)) })
    expect(view.root.findAllByType(WorkChangesField)).toHaveLength(1)

    act(() => view.root.findAllByType(Button).find((button) => button.props.children === 'Send to Session')!.props.onClick())
    act(() => view.update(card(1, false)))
    act(() => answer({ type: 'ack', requestId: sentAs }))
    act(() => view.update(card(2, true)))

    expect(readWorkChangesOpen('a')).toBe(false)
    expect(view.root.findAllByType(WorkChangesField)).toHaveLength(0)
    expect(buttons(view)).toEqual(expect.arrayContaining(['Request changes', 'Confirm']))
    act(() => view.unmount())
  })
})
