import { type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mailContextText, PageContextAttachmentSchema, type AgentConfig, type Chat, type MailThread, type PageContextAttachment, type Project } from '@manor/contracts'
import { clearDrafts, readDraft } from '../../composerDrafts'
import { usePageContexts } from '../../useChatSide'
import { PageContextChip } from '../PageContextChip'
import { MailAddToChatDialog, mailPageContext, type MailChatDoor } from './MailAddToChatDialog'

vi.mock('react-dom', () => ({ createPortal: (children: ReactNode) => children }))

const thread: MailThread = {
  threadId: '1790000000000000001',
  subject: 'Second round <interview>',
  messages: [{
    id: 'm1', from: { name: 'Robin Example', address: 'robin@example.com' }, to: [], cc: [], at: Date.UTC(2026, 0, 5, 9, 30),
    text: 'Can you come on **Tuesday**? <img src=x> https://example.com', truncated: false, attachments: [], mine: false,
  }],
  reply: { to: 'robin@example.com', cc: '', subject: 'Re: Second round <interview>' },
}
const agent = (id: string, name: string, more: Partial<AgentConfig> = {}) =>
  ({ id, name, color: 'teal', isCos: false, ...more }) as unknown as AgentConfig
const agents = [agent('writer', 'Writer'), agent('chief', 'Chief', { isCos: true }), agent('builder', 'Builder', { placement: 'session' })]
const chat = (id: string, kind: Chat['kind'], memberIds: string[] = []) => ({ id, kind, memberIds, archivedAt: null }) as unknown as Chat
const project = (id: string, name: string, threadChatId?: string) => ({ id, name, color: 'olive', threadChatId }) as unknown as Project
const projects = [project('garden', 'Garden', 'garden-thread'), project('folder', 'Folder'), project('move', 'Move', 'move-thread')]
const chats = [chat('chief-dm', 'dm', ['chief']), chat('garden-thread', 'project'), chat('move-thread', 'project')]

let view: ReactTestRenderer
let calls: unknown[][]
let sources: ReturnType<typeof usePageContexts>

/** The dialog over the real staging hook; only navigation is recorded. */
function Harness({ linked, creating = false, onClose, held = {} }: {
  linked?: string
  creating?: boolean
  onClose: () => void
  held?: MailChatDoor['staged']
}) {
  sources = usePageContexts()
  const door: MailChatDoor = {
    staged: { ...held, ...sources.pageContextsByChat },
    creating,
    stage: (key, context) => { calls.push(['stage', key, context]); sources.addPageContext(key, context) },
    openChat: (chatId) => calls.push(['openChat', chatId]),
    openDm: (agentId) => calls.push(['openDm', agentId]),
  }
  return <MailAddToChatDialog thread={thread} agents={agents} chats={chats} projects={projects}
    linkedProjectId={linked} door={door} onClose={onClose} />
}

const mount = (props: Partial<Parameters<typeof Harness>[0]> = {}) => {
  const onClose = vi.fn()
  act(() => { view = create(<Harness onClose={onClose} {...props} />) })
  return onClose
}
const host = (match: (node: ReactTestInstance) => boolean) => view.root.findAll((node) => typeof node.type === 'string' && match(node))
const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
const radios = () => host((node) => node.props.role === 'radio')
const names = () => radios().map((node) => node.props['aria-label'])
const checked = () => radios().find((node) => node.props['aria-checked'] === true)?.props['aria-label']
const radio = (name: string) => radios().find((node) => node.props['aria-label'] === name)!
const button = (name: string) => host((node) => node.type === 'button' && textOf(node) === name)[0]!
const preview = () => textOf(host((node) => node.props['data-mail-preview'] !== undefined)[0]!)
const dialog = () => host((node) => node.props.role === 'dialog')[0]!
const keyDown = (key: string, onRadio = true) => act(() => dialog().props.onKeyDown({
  key, repeat: false, preventDefault: () => {}, target: { matches: () => onRadio },
}))
const staged = () => calls.filter((call) => call[0] === 'stage') as [string, string, PageContextAttachment][]

beforeEach(() => {
  calls = []
  clearDrafts()
  vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
afterEach(() => {
  act(() => view.unmount())
  vi.unstubAllGlobals()
})

describe('MailAddToChatDialog', () => {
  it('previews exactly the text it stages, as plain text, and sends nothing', () => {
    const onClose = mount()
    const shown = preview()
    expect(shown).toBe(mailContextText(thread))
    expect(host((node) => node.type === 'img' || node.type === 'a' || node.type === 'strong')).toEqual([])
    expect(textOf(dialog())).toContain(`Untrusted${shown}`)
    act(() => button('Add').props.onClick())
    expect(onClose).toHaveBeenCalledOnce()
    const [[, key, context]] = staged() as [[string, string, PageContextAttachment]]
    expect(context.text).toBe(shown)
    expect(context).toEqual({
      id: 'mail:1790000000000000001', kind: 'mail', url: '', html: '',
      title: thread.subject, label: thread.subject, text: shown,
    })
    expect(PageContextAttachmentSchema.safeParse(context).success).toBe(true)
    // Staging and going there is all that happens.
    expect(calls.map((call) => call[0])).toEqual(['stage', 'openDm'])
    expect(key).toBe('chief-dm')
    // A source above the text, never a quote inside it.
    expect(sources.pageContextsByChat).toEqual({ 'chief-dm': [context] })
    expect(readDraft('chief-dm')).toMatchObject({ text: '' })
    expect(readDraft('chief-dm').quotes).toBeUndefined()
  })

  it('lists the linked project first, then the default agent, the other DMs and the other project threads', () => {
    mount({ linked: 'move' })
    expect(names()).toEqual(['Move, project chat', 'Chief, direct message', 'Writer, direct message', 'Garden, project chat'])
    expect(checked()).toBe('Move, project chat')
    expect(host((node) => node.props['data-mark'] !== undefined).map((node) => node.props['data-mark']))
      .toEqual(['project', 'dm', 'dm', 'project'])
    act(() => button('Add').props.onClick())
    expect(calls.map((call) => [call[0], call[1]])).toEqual([['stage', 'move-thread'], ['openChat', 'move-thread']])
  })

  it('starts with the default agent when the sender is linked to no thread', () => {
    mount({ linked: 'folder' })
    expect(checked()).toBe('Chief, direct message')
    expect(names()).toHaveLength(4)
  })

  it('stages for a DM that does not exist yet in the slot of its draft, picked by arrow and added by Enter', () => {
    const onClose = mount()
    keyDown('ArrowDown', false)
    expect(checked()).toBe('Chief, direct message')
    keyDown('ArrowDown')
    expect(checked()).toBe('Writer, direct message')
    keyDown('Enter')
    expect(onClose).toHaveBeenCalledOnce()
    expect(calls.map((call) => [call[0], call[1]])).toEqual([['stage', 'new-chat:dm:writer'], ['openDm', 'writer']])
  })

  it('adds the target Enter is pressed on, even when Tab left another one picked', () => {
    mount()
    const stopPropagation = vi.fn()
    act(() => radio('Garden, project chat').props.onKeyDown({ key: 'Enter', repeat: false, preventDefault: () => {}, stopPropagation }))
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(calls.map((call) => [call[0], call[1]])).toEqual([['stage', 'garden-thread'], ['openChat', 'garden-thread']])
  })

  it('holds back a DM that does not exist while a chat is being made', () => {
    mount({ creating: true })
    expect(radio('Writer, direct message, A chat is still being started').props.disabled).toBe(true)
    expect(radio('Chief, direct message').props.disabled).toBe(false)
  })

  it('does not aim at a chat with no source slot left, unless the thread already holds one there', () => {
    const other = (id: string): PageContextAttachment => ({ ...mailPageContext(thread), id })
    mount({ held: {
      'chief-dm': [other('one'), other('two'), other('three')],
      'new-chat:dm:writer': [other('one'), other('two'), other('mail:1790000000000000001')],
    } })
    expect(radio('Chief, direct message, No room left').props.disabled).toBe(true)
    expect(checked()).toBe('Writer, direct message')
  })

  it('gives a thread added again the newer text in the same slot', () => {
    mount()
    const old = { ...mailPageContext(thread), text: 'Before the latest message' }
    act(() => sources.addPageContext('chief-dm', old))
    act(() => button('Add').props.onClick())
    expect(sources.pageContextsByChat['chief-dm']).toEqual([mailPageContext(thread)])
  })

  it('cancels without staging', () => {
    const onClose = mount()
    act(() => button('Cancel').props.onClick())
    keyDown('Escape')
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(calls).toEqual([])
  })

  it('names a mail with an empty subject and shows it on the chip once, with no address', () => {
    mount()
    const unnamed = mailPageContext({ ...thread, subject: '' })
    expect(unnamed.label).toBe('(no subject)')
    expect(PageContextAttachmentSchema.safeParse(unnamed).success).toBe(true)
    act(() => view.update(<PageContextChip context={mailPageContext(thread)} onRemove={() => {}} />))
    expect(textOf(view.root)).toBe(thread.subject)
    const chip = host((node) => node.props.title !== undefined)[0]!
    expect(chip.props.title).toBe(thread.subject)
    expect(button('')?.props['aria-label']).toBe(`Remove context from ${thread.subject}`)
  })
})
