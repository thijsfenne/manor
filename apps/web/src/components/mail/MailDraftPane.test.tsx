import { createElement, forwardRef, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, MailThread } from '@manor/contracts'
import type { MailDraft } from '@manor/client-runtime/mail'
import { MailDraftPane, type MailDraftsState } from './MailDraftPane'
import type { MailReply } from './mailViewStore'

/** The reply pane without a browser: motion is plain markup, and the reply is held here as the Mail view would. */
vi.mock('motion/react', () => {
  const plain = new Map<string, unknown>()
  const motion = new Proxy({}, {
    get: (_target, tag: string) => {
      if (!plain.has(tag)) {
        plain.set(tag, forwardRef(({ initial: _i, animate: _a, exit: _e, transition: _t, layoutId: _l, ...props }: Record<string, unknown>, ref) =>
          createElement(tag, { ...props, ref })))
      }
      return plain.get(tag)
    },
  })
  return { motion, AnimatePresence: ({ children }: { children: ReactNode }) => children, useReducedMotion: () => true }
})
// The shared composer needs a browser editor; the pane is tested through the props it hands it.
const composer = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }))
vi.mock('../Composer', () => ({
  Composer: (props: Record<string, unknown>) => {
    composer.props = props
    return null
  },
}))

const thread: MailThread = {
  threadId: 't1',
  subject: 'Second round interview',
  messages: [{
    id: 'm1', from: { name: 'Robin Example', address: 'robin@example.com' }, to: [], cc: [{ name: 'Team', address: 'team@example.com' }],
    at: 1, text: 'Could you come on Thursday?', truncated: false, attachments: [], mine: false,
  }],
  reply: { to: 'robin@example.com', cc: 'team@example.com', subject: 'Re: Second round interview' },
}
const agent = { id: 'chief', name: 'Avery', color: 'teal', isCos: true } as unknown as AgentConfig

let view: ReactTestRenderer
let calls: { start: [string | undefined, string | undefined][]; stop: number; send: [string, string, string][]; close: number }
let state: MailDraftsState
let reply: MailReply

const draft = (status: MailDraft['status'], text: string, draftId = 'd1', message?: string): MailDraft =>
  ({ draftId, threadId: 't1', status, text, ...(message === undefined ? {} : { message }) })

const pane = () => (
  <MailDraftPane thread={thread} agent={agent} reply={reply} drafts={state}
    onChange={(change) => {
      reply = { ...reply, ...change }
      view.update(pane())
    }}
    onClose={() => { calls.close += 1 }}
    onStart={(instruction, current) => { calls.start.push([instruction, current]); return true }}
    onStop={() => { calls.stop += 1 }}
    onSend={(to, cc, body) => { calls.send.push([to, cc, body]) }} />
)
function show(next: Partial<MailDraftsState>) {
  state = { ...state, ...next }
  act(() => view.update(pane()))
}
const host = (match: (node: ReactTestInstance) => boolean) => view.root.findAll((node) => typeof node.type === 'string' && match(node))
const labelled = (label: string) => {
  const [node] = host((node) => node.props['aria-label'] === label)
  if (node === undefined) throw new Error(`No ${label}`)
  return node
}
const sendButton = () => {
  const [node] = host((node) => node.type === 'button' && (node.children.includes('Send') || node.children.includes('Sending…')))
  if (node === undefined) throw new Error('No Send')
  return node
}
const text = () => labelled('Reply text').props.value as string
const asked = (instruction: string) => {
  let accepted = false
  act(() => { accepted = (composer.props!.onSend as (text: string) => boolean)(instruction) })
  return accepted
}
const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')

beforeEach(() => {
  calls = { start: [], stop: 0, send: [], close: 0 }
  state = { draft: undefined, sending: false }
  reply = { to: thread.reply.to, cc: thread.reply.cc, body: '' }
  act(() => { view = create(pane()) })
})
afterEach(() => act(() => view.unmount()))

describe('MailDraftPane', () => {
  it('asks for one draft on open and lets the stream replace the text', () => {
    expect(calls.start).toEqual([[undefined, undefined]])
    show({ draft: draft('streaming', '') })
    expect(host((node) => node.props.role === 'status').map(textOf)).toEqual(['Writing…'])
    expect(composer.props!.running).toBe(true)
    show({ draft: draft('streaming', 'Thank you, Thursday') })
    expect(text()).toBe('Thank you, Thursday')
    expect(labelled('Reply text').props.readOnly).toBe(true)
    show({ draft: draft('streaming', 'Thank you, Thursday at ten works.') })
    expect(text()).toBe('Thank you, Thursday at ten works.')
    show({ draft: draft('done', 'Thank you, Thursday at ten works.') })
    expect(text()).toBe('Thank you, Thursday at ten works.')
    expect(labelled('Reply text').props.readOnly).toBe(false)
  })

  it('keeps an edit until a new version is asked for, and sends that version along', () => {
    show({ draft: draft('done', 'First version.') })
    act(() => labelled('Reply text').props.onChange({ target: { value: 'My own words.' } }))
    show({ draft: draft('done', 'First version.') })
    expect(text()).toBe('My own words.')

    expect(asked('Shorter')).toBe(true)
    expect(calls.start.at(-1)).toEqual(['Shorter', 'My own words.'])

    show({ draft: draft('streaming', 'Short.', 'd2') })
    expect(text()).toBe('Short.')
    show({ draft: draft('done', 'Short.', 'd2') })
    expect(text()).toBe('Short.')
  })

  it('disables Send while the draft streams and while a send is on its way', () => {
    show({ draft: draft('streaming', 'Half a') })
    expect(sendButton().props.disabled).toBe(true)
    expect(composer.props!.canSend).toBe(false)
    expect(asked('Longer')).toBe(false)
    act(() => (composer.props!.onStop as () => void)())
    expect(calls.stop).toBe(1)

    show({ draft: draft('done', 'Half a sentence.') })
    expect(sendButton().props.disabled).toBe(false)
    act(() => sendButton().props.onClick())
    expect(calls.send).toEqual([['robin@example.com', 'team@example.com', 'Half a sentence.']])
    show({ sending: true })
    expect(sendButton().props.disabled).toBe(true)
  })

  it('keeps the text when a failed revision wrote nothing and shows why', () => {
    show({ draft: draft('done', 'Kept text.') })
    show({ draft: draft('error', '', 'd2', 'Avery wrote no draft.') })
    expect(text()).toBe('Kept text.')
    expect(host((node) => node.props.role === 'alert')[0]!.children).toEqual(['Avery wrote no draft.'])
  })

  it('keeps the text when a new version was stopped before it wrote anything', () => {
    show({ draft: draft('done', 'Thanks.') })
    show({ draft: draft('done', '', 'd2') })
    expect(text()).toBe('Thanks.')
  })

  it('marks a recipient the thread never saw', () => {
    expect(host((node) => node.props.title === 'Not in this thread')).toHaveLength(0)
    act(() => labelled('Edit To').props.onClick())
    act(() => labelled('To').props.onChange({ target: { value: 'robin@example.com, stranger@else.example' } }))
    act(() => labelled('To').props.onBlur())
    const marked = host((node) => node.props.title === 'Not in this thread')
    expect(marked).toHaveLength(1)
    expect(marked[0]!.children).toEqual(['stranger@else.example'])
  })

  it('closes on Escape in its own text and in an idle composer', () => {
    const key = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() }
    act(() => labelled('Reply text').props.onKeyDown(key))
    expect(key.stopPropagation).toHaveBeenCalledTimes(1)
    act(() => (composer.props!.onEscapeIdle as () => void)())
    expect(calls.close).toBe(2)
  })

  it('heads the pane Reply without the agent, and asks the agent by name in the composer', () => {
    const header = host((node) => node.type === 'h2').map(textOf)
    expect(header).toEqual(['Reply'])
    expect(JSON.stringify(view.toJSON())).not.toContain('Avery')
    expect(composer.props).toMatchObject({ placeholder: 'Ask Avery to change it', draftKey: 'mail:t1', compact: true, allowAttachments: false })
  })

  it('refuses a request over the cap and keeps it in the composer', () => {
    show({ draft: draft('done', 'Text.') })
    expect(asked('x'.repeat(2_001))).toBe(false)
    expect(calls.start).toHaveLength(1)
    expect(host((node) => node.props.role === 'alert')).toHaveLength(1)
  })

  it('stays open on a refused send', () => {
    show({ draft: draft('done', 'Thanks.') })
    act(() => sendButton().props.onClick())
    show({ sending: false })
    expect(calls.close).toBe(0)
    expect(text()).toBe('Thanks.')
  })

  it('asks for no draft when its reply already has one, and fills in one that finished meanwhile once', () => {
    act(() => view.unmount())
    calls.start = []
    reply = { ...reply, draftId: 'd1', body: 'Before.' }
    state = { ...state, draft: draft('done', 'Finished while away.') }
    act(() => { view = create(pane()) })
    expect(calls.start).toEqual([])
    expect(text()).toBe('Finished while away.')
    expect(reply).toMatchObject({ body: 'Finished while away.', settled: 'd1:done' })
    act(() => labelled('Reply text').props.onChange({ target: { value: 'Edited after.' } }))
    act(() => view.unmount())
    act(() => { view = create(pane()) })
    expect(text()).toBe('Edited after.')
  })
})
