import { createElement, forwardRef, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, ClientMessage, MailCard, MailLabel, MailThread, MailTriageState, ServerMessage } from '@manor/contracts'
import { createWorkspaceCommands } from '@manor/client-runtime/commands'
import { mailTimeLabel } from '../../mail'
import { toast } from '../../notices'
import { emptyWorkspace, reduce } from '../../state'
import { Button } from '../ui/Button'
import { useMailArchivedNotice } from './mailArchivedNotice'
import { MailView } from './MailView'
import { mailView, setMailView } from './mailViewStore'

/**
 * The Mail view over the real reducer and commands, without a browser: portals render in
 * place, motion is plain markup, and the window is a bare event target.
 */
vi.mock('react-dom', () => ({ createPortal: (children: ReactNode) => children }))
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
// The shared composer needs a browser editor; its own tests cover it.
vi.mock('../Composer', () => ({ Composer: ({ placeholder }: { placeholder?: string }) => createElement('div', { 'data-composer': placeholder }) }))

const card = (threadId: string, at: number, label?: MailLabel): MailCard => ({
  threadId, subject: `Subject ${threadId}`, from: { name: 'Robin Example', address: 'robin@example.com' }, at, unread: true, messageCount: 1,
  ...(label === undefined ? {} : { label }),
})
/** Three cards that need a reply, one labelled Other and one no run has reached. */
const CARDS = [card('a', 30, 'reply'), card('b', 20, 'reply'), card('c', 10, 'reply'), card('d', 5, 'other'), card('e', 4)]
const NO_RUN: MailTriageState = { lastRunAt: null, running: false }
const thread = (threadId: string): MailThread => ({
  threadId,
  subject: `Subject ${threadId}`,
  messages: [1, 2].map((index) => ({
    id: `${threadId}-${index}`, from: { name: 'Robin Example', address: 'robin@example.com' }, to: [], cc: [], at: index,
    text: `Body ${index} of ${threadId} <b>https://example.com</b>`, truncated: false, attachments: [], mine: false,
  })),
  reply: { to: 'robin@example.com', cc: '', subject: `Re: Subject ${threadId}` },
})
const agent = { id: 'chief', name: 'Avery', color: 'teal', isCos: true } as unknown as AgentConfig

const chatDoor = { staged: {}, creating: false, canStartChat: true, stage: () => {}, openChat: () => {}, openDm: () => {}, startChat: () => {} }

class FakeElement {
  isContentEditable = false
  constructor(public tagName = 'DIV') {}
}

/** The Archived card as the window's notice stack would draw it. */
function Notices({ args }: { args: Parameters<typeof useMailArchivedNotice> }) {
  return <>{useMailArchivedNotice(...args)?.node}</>
}

let view: ReactTestRenderer
let sent: ClientMessage[]
let hear: (message: ServerMessage) => void
let leave: () => void
let back: () => void
let dialogOpen: boolean
let page: EventTarget
/** The view is unmounted, as when another door is open; the mail state still moves. */
let away: boolean

function mount(cards = CARDS, triage = NO_RUN) {
  let state = reduce(emptyWorkspace, { type: 'mail_state', status: 'ready', cards, syncedAt: 1, triage })
  const render = () => (away ? <></> : (
    <>
      <MailView mail={state.mail} agents={[agent]} projects={[]} chats={[]} chatDoor={chatDoor} status="live" commands={commands} settingsOpen={false}
        sidebarSlot={{} as HTMLElement} actionSlot={{} as HTMLElement} sidebarCollapsed={false} />
      <Notices args={[state.mail, commands.unarchiveMailThread]} />
    </>
  ))
  const change = (next: typeof state) => {
    state = next
    view.update(render())
  }
  const commands = createWorkspaceCommands(
    (message) => { sent.push(message); return true },
    (apply) => change(apply(state)),
  )
  hear = (message) => act(() => change(reduce(state, message)))
  leave = () => { away = true; act(() => view.update(render())) }
  back = () => { away = false; act(() => view.update(render())) }
  act(() => { view = create(render(), { unstable_isConcurrent: true } as never) })
  for (const { threadId: id } of cards) hear({ type: 'mail_thread', requestId: `seed-${id}`, threadId: id, result: { status: 'ready', thread: thread(id) } })
}

function press(key: string, target: object = new FakeElement(), extra: object = {}) {
  const event = Object.assign(new Event('keydown', { cancelable: true }), { key, metaKey: false, ctrlKey: false, altKey: false, repeat: false, ...extra })
  Object.defineProperty(event, 'target', { value: target })
  act(() => { page.dispatchEvent(event) })
}

const host = (match: (node: ReactTestInstance) => boolean) => view.root.findAll((node) => typeof node.type === 'string' && match(node))
const cardsShown = () => host((node) => node.props['data-mail-card'] !== undefined)
const shown = () => cardsShown().map((node) => node.props['data-mail-card'])
const selected = () => cardsShown().find((node) => node.props['aria-current'] === 'true')?.props['data-mail-card'] ?? null
const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
const button = (name: string) => host((node) => node.type === 'button' && (node.props['aria-label'] === name || textOf(node) === name))[0]!
const says = (text: string) => JSON.stringify(view.toJSON()).includes(text)
const search = (query: string) => act(() => host((node) => node.props['aria-label'] === 'Search mail')[0]!.props.onChange({ target: { value: query } }))
const paneOpen = () => host((node) => node.props['aria-label'] === 'Reply draft').length === 1
/** A click on a card with the modifiers held, and a right click on it. */
const clickCard = (id: string, keys: object = {}) =>
  act(() => cardsShown().find((node) => node.props['data-mail-card'] === id)!.props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false, ...keys }))
const menuOn = (id: string) =>
  act(() => cardsShown().find((node) => node.props['data-mail-card'] === id)!.parent!.props.onContextMenu({ preventDefault: () => {}, clientX: 10, clientY: 10 }))
const menuItems = () => host((node) => node.props.role === 'menuitem')
const ofType = <T extends ClientMessage['type']>(type: T) =>
  sent.filter((message): message is Extract<ClientMessage, { type: T }> => message.type === type)
const replyText = () => host((node) => node.props['aria-label'] === 'Reply text')[0]!
const typeReply = (value: string) => act(() => replyText().props.onChange({ target: { value } }))
const drafted = (index: number, status: 'streaming' | 'done', text: string) => {
  const { draftId, threadId } = ofType('mail_draft_start')[index]!
  hear({ type: 'mail_draft', draftId, threadId, status, text })
}

beforeEach(() => {
  sent = []
  dialogOpen = false
  away = false
  page = new EventTarget()
  vi.stubGlobal('window', page)
  vi.stubGlobal('document', { querySelector: () => (dialogOpen ? {} : null), body: {}, addEventListener: () => {}, removeEventListener: () => {} })
  Object.assign(page, { setTimeout, clearTimeout })
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => { run(); return 0 })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setMailView({ selectedId: null, tab: 'reply', query: '', picked: [], archived: null, replies: {} })
})
afterEach(() => {
  act(() => view.unmount())
  vi.unstubAllGlobals()
})

describe('MailView', () => {
  it('asks the host to look again on opening and on every window focus, and opens nothing by itself', () => {
    mount()
    const before = ofType('mail_load').length
    expect(before).toBeGreaterThan(0)
    expect(ofType('mail_load').every((message) => message.refresh === true)).toBe(true)
    act(() => { page.dispatchEvent(new Event('focus')) })
    expect(ofType('mail_load')).toHaveLength(before + 1)
    expect(ofType('mail_open')).toEqual([])
    expect(selected()).toBeNull()
  })

  it('lists Needs attention first, without an All tab, and draws no actions until a mail is open', () => {
    mount()
    const tabs = host((node) => node.props.role === 'tab').map(textOf)
    expect(tabs).toEqual(['Needs attention', 'Waiting', 'FYI'])
    expect(shown()).toEqual(['a', 'b', 'c'])
    for (const name of ['Reply', 'Add to chat', 'Archive']) expect(button(name)).toBeUndefined()
    expect(says('Select a mail to read.')).toBe(true)
    press('j')
    for (const name of ['Reply', 'Add to chat', 'Archive']) expect(button(name)).toBeDefined()
    expect(button('Reply').props.title).toBe('Draft a reply (R)')
    expect(says('Select a mail to read.')).toBe(false)
  })

  it('keeps Other and unlabelled mail out of every tab and finds it in a search, with its label', () => {
    mount()
    for (const name of ['Needs attention', 'Waiting', 'FYI']) {
      act(() => button(name).props.onClick())
      expect(shown()).not.toContain('d')
      expect(shown()).not.toContain('e')
    }
    search('subject')
    expect(shown()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(host((node) => node.props.role === 'tab')).toEqual([])
    expect(says('Other')).toBe(true)
    search('')
    expect(host((node) => node.props.role === 'tab')).toHaveLength(3)
    expect(says('Other')).toBe(false)
  })

  it('sets Other with key 4, which takes the card off its tab', () => {
    mount()
    press('j')
    press('4')
    expect(ofType('mail_set_label')).toEqual([{ type: 'mail_set_label', threadId: 'a', label: 'other' }])
    expect(shown()).toEqual(['b', 'c'])
  })

  it('says why each view is empty, and offers a run for the unlabelled cards', () => {
    mount([card('d', 5, 'other'), card('e', 4)])
    expect(says('Nothing needs your attention.')).toBe(true)
    expect(says('Not labelled yet')).toBe(true)
    expect(button('1 new')).toBeDefined()
    act(() => button('Label 1 new').props.onClick())
    expect(ofType('mail_triage_run')).toHaveLength(1)
    act(() => button('Waiting').props.onClick())
    expect(says('Nothing is waiting on someone.')).toBe(true)
    act(() => button('FYI').props.onClick())
    expect(says('Nothing to read.')).toBe(true)
    search('nothing like it')
    expect(says('No mail matches this search.')).toBe(true)
    expect(says('Not labelled yet')).toBe(false)
    search('subject')
    expect(says('Select a mail to read.')).toBe(true)
  })

  it('says a run is going instead of offering one', () => {
    mount([card('e', 4)], { lastRunAt: null, running: true })
    expect(says('Labelling new mail…')).toBe(true)
    expect(says('Not labelled yet')).toBe(false)
    expect(button('Label 1 new')).toBeUndefined()
  })

  it('names the last run when every card is labelled', () => {
    const at = Date.now() - 60_000
    mount([card('a', 30, 'reply')], { lastRunAt: at, running: false })
    act(() => button('Waiting').props.onClick())
    expect(says(`Last labelled ${mailTimeLabel(at, Date.now())}`)).toBe(true)
    expect(button(mailTimeLabel(at, Date.now()))).toBeDefined()
    expect(button('Label 1 new')).toBeUndefined()
  })

  it('walks the list by key, reads each thread, and folds all but the newest message', () => {
    mount()
    press('j')
    expect(selected()).toBe('a')
    expect(ofType('mail_open').at(-1)?.threadId).toBe('a')
    press('ArrowDown')
    press('k')
    press('ArrowDown', new FakeElement(), { repeat: true })
    expect(selected()).toBe('b')
    expect(button('Reply').props.disabled).toBe(false)
    const rendered = JSON.stringify(view.toJSON())
    expect(rendered).toContain('Body 2 of b <b>https://example.com</b>')
    expect(rendered).not.toContain('Body 1 of b')
    expect(host((node) => node.type === 'a')).toEqual([])
  })

  it('leaves keys alone while typing, under a dialog, and with a modifier held', () => {
    mount()
    press('j')
    press('e', new FakeElement('INPUT'))
    press('e', new FakeElement(), { metaKey: true })
    press('e', new FakeElement(), { repeat: true })
    dialogOpen = true
    press('e')
    expect(ofType('mail_archive')).toEqual([])
    expect(shown()).toEqual(['a', 'b', 'c'])
  })

  it('archives at once and selects the next card, else the previous one', () => {
    mount()
    press('j')
    press('j')
    press('e')
    expect(shown()).toEqual(['a', 'c'])
    expect(selected()).toBe('c')
    press('e')
    expect(shown()).toEqual(['a'])
    expect(selected()).toBe('a')
    expect(ofType('mail_archive').map((message) => message.threadId)).toEqual(['b', 'c'])
    // A refusal brings the card back.
    hear({ type: 'mail_result', requestId: ofType('mail_archive')[1]!.requestId, ok: false, message: 'No archive folder' })
    expect(shown()).toEqual(['a', 'c'])
  })

  it('offers Undo on the Archived notice, which brings the card back selected', () => {
    mount()
    press('j')
    press('2')
    act(() => button('Waiting').props.onClick())
    press('e')
    expect(JSON.stringify(view.toJSON())).toContain('Archived')
    act(() => button('Needs attention').props.onClick())
    act(() => button('Undo').props.onClick())
    expect(ofType('mail_unarchive').map((message) => message.threadId)).toEqual(['a'])
    // The tab that would hide it gives way to its own.
    expect(host((node) => node.props.role === 'tab' && node.props['aria-selected'] === true).map(textOf)).toEqual(['Waiting'])
    expect(shown()).toEqual(['a'])
    expect(selected()).toBe('a')
    expect(button('Undo')).toBeUndefined()
  })

  it('archives a pick of several cards with one request each, and undoes them all', () => {
    mount()
    press('j')
    clickCard('c', { metaKey: true })
    expect(says('2 mails selected')).toBe(true)
    expect(selected()).toBeNull()
    expect(button('Reply')).toBeUndefined()
    press('Escape')
    expect(selected()).toBe('a')
    clickCard('c', { shiftKey: true })
    expect(says('3 mails selected')).toBe(true)
    expect(button('Archive')).toBeDefined()
    menuOn('b')
    expect(menuItems().map(textOf)).toEqual(['Archive 3 mails'])
    act(() => menuItems()[0]!.props.onClick())
    expect(ofType('mail_archive').map((message) => message.threadId)).toEqual(['a', 'b', 'c'])
    expect(shown()).toEqual([])
    expect(says('Archived 3 mails')).toBe(true)
    act(() => button('Undo').props.onClick())
    expect(ofType('mail_unarchive').map((message) => message.threadId)).toEqual(['a', 'b', 'c'])
    expect(shown()).toEqual(['a', 'b', 'c'])
    expect(selected()).toBe('a')
  })

  it('archives a card that is not open from its right click menu and leaves the open mail open', () => {
    mount()
    press('j')
    menuOn('c')
    expect(menuItems().map(textOf)).toEqual(['Archive'])
    act(() => menuItems()[0]!.props.onClick())
    expect(ofType('mail_archive').map((message) => message.threadId)).toEqual(['c'])
    expect(shown()).toEqual(['a', 'b'])
    expect(selected()).toBe('a')
    expect(says('Archived')).toBe(true)
  })

  it('drops the Archived notice when the host refuses', () => {
    mount()
    press('j')
    press('e')
    hear({ type: 'mail_result', requestId: ofType('mail_archive')[0]!.requestId, ok: false, message: 'No archive folder' })
    expect(button('Undo')).toBeUndefined()
    expect(shown()).toEqual(['a', 'b', 'c'])
  })

  it('sets a label by key, keeps the thread open off its tab, and says when a view is empty', () => {
    mount()
    press('j')
    press('2')
    expect(ofType('mail_set_label')).toEqual([{ type: 'mail_set_label', threadId: 'a', label: 'wait' }])
    act(() => button('Waiting').props.onClick())
    expect(shown()).toEqual(['a'])
    press('3')
    expect(shown()).toEqual([])
    expect(says('Nothing is waiting on someone.')).toBe(true)
    expect(button('Archive')).toBeUndefined()
  })

  it('leads the toolbar with Reply as the primary button, then Add to chat and Archive', () => {
    mount()
    press('j')
    const toolbar = host((node) => node.props.role === 'toolbar')[0]!
    expect(toolbar.findAll((node) => node.type === 'button').map(textOf)).toEqual(['Reply', 'Add to chat', 'Archive'])
    expect(toolbar.findAllByType(Button).map((node) => [node.props.variant, node.props.size]))
      .toEqual([['primary', 'small'], [undefined, 'small'], [undefined, 'small']])
  })

  it('opens the reply split with one draft, and Escape stops it and ends the reply', () => {
    mount()
    press('j')
    press('r')
    expect(paneOpen()).toBe(true)
    expect(ofType('mail_draft_start').map((message) => message.threadId)).toEqual(['a'])
    press('r')
    expect(ofType('mail_draft_start')).toHaveLength(1)
    press('Escape')
    expect(paneOpen()).toBe(false)
    expect(ofType('mail_draft_stop').map((message) => message.draftId)).toEqual([ofType('mail_draft_start')[0]!.draftId])
    expect(mailView().replies).toEqual({})
  })

  it('keeps a reply with the edited text through leaving Mail, without a second draft', () => {
    mount()
    press('j')
    press('r')
    drafted(0, 'done', 'Thanks, Thursday works.')
    typeReply('Thanks, Thursday at ten works.')
    leave()
    back()
    expect(paneOpen()).toBe(true)
    expect(replyText().props.value).toBe('Thanks, Thursday at ten works.')
    expect(ofType('mail_draft_start')).toHaveLength(1)
    expect(ofType('mail_draft_stop')).toEqual([])
  })

  it('fills in a draft that finished while Mail was left, and keeps an edit after it', () => {
    mount()
    press('j')
    press('r')
    drafted(0, 'streaming', 'Thanks,')
    leave()
    drafted(0, 'done', 'Thanks, see you then.')
    back()
    expect(replyText().props.value).toBe('Thanks, see you then.')
    typeReply('Thanks, see you on Thursday.')
    leave()
    back()
    expect(replyText().props.value).toBe('Thanks, see you on Thursday.')
    expect(ofType('mail_draft_start')).toHaveLength(1)
  })

  it('keeps a reply while another mail is open and shows it again on return', () => {
    mount()
    press('j')
    press('r')
    drafted(0, 'done', 'Draft for a.')
    press('j')
    expect(selected()).toBe('b')
    expect(paneOpen()).toBe(false)
    press('k')
    expect(paneOpen()).toBe(true)
    expect(replyText().props.value).toBe('Draft for a.')
    expect(ofType('mail_draft_stop')).toEqual([])
    expect(ofType('mail_draft_start')).toHaveLength(1)
  })

  it('stops the streaming draft of one reply before a draft for another thread starts', () => {
    mount()
    press('j')
    press('r')
    drafted(0, 'streaming', 'Half of a')
    press('j')
    press('r')
    const [first, second] = ofType('mail_draft_start')
    expect(second?.threadId).toBe('b')
    expect(ofType('mail_draft_stop').map((message) => message.draftId)).toEqual([first!.draftId])
    press('k')
    // Stopped, the text it reached is the reply's.
    expect(replyText().props.value).toBe('Half of a')
    expect(replyText().props.readOnly).toBe(false)
  })

  it('ends the reply of an archived thread and stops its draft', () => {
    mount()
    press('j')
    press('r')
    press('e')
    expect(mailView().replies).toEqual({})
    expect(ofType('mail_draft_stop').map((message) => message.draftId)).toEqual([ofType('mail_draft_start')[0]!.draftId])
  })

  it('tells a send confirmed while Mail was left on return, and ends the reply', () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => {})
    mount()
    press('j')
    press('r')
    drafted(0, 'done', 'Thanks.')
    act(() => button('Send').props.onClick())
    leave()
    hear({ type: 'mail_result', requestId: ofType('mail_send')[0]!.requestId, ok: true })
    expect(success).not.toHaveBeenCalled()
    back()
    expect(success).toHaveBeenCalledWith('Sent to robin@example.com')
    expect(mailView().replies).toEqual({})
    expect(paneOpen()).toBe(false)
    success.mockRestore()
  })

  it('keeps a reply open when a search empties the list', () => {
    mount()
    press('j')
    press('r')
    search('nothing like it')
    expect(shown()).toEqual([])
    expect(paneOpen()).toBe(true)
    expect(ofType('mail_draft_stop')).toEqual([])
  })

  it('opens Add to chat from its key and its button', () => {
    mount()
    press('j')
    press('a')
    const dialog = () => host((node) => node.props.role === 'dialog' && node.props['aria-label'] === 'Add to chat')
    expect(dialog()).toHaveLength(1)
    act(() => button('Cancel').props.onClick())
    expect(dialog()).toHaveLength(0)
    act(() => button('Add to chat').props.onClick())
    expect(dialog()).toHaveLength(1)
  })
})
