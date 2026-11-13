import type { AgentConfig, SkillConfig } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer, plusMentionLabel } from '../src/components/Composer'
import { RuntimeControls } from '../src/components/RuntimeControls'
import { clearDrafts, writeDraft } from '../src/composerDrafts'

// These component tests exercise the composer's routing and controls without a DOM.
// Lexical's own editor state and commands have a focused headless suite beside them.
vi.mock('@lexical/react/LexicalRichTextPlugin', () => ({
  RichTextPlugin: ({ contentEditable, placeholder }: { contentEditable: ReactNode; placeholder: ReactNode }) => <>{contentEditable}{placeholder}</>,
}))

const agent = (id: string, name: string): AgentConfig =>
  ({ id, name, color: '#8b5cf6', driver: 'claude', model: 'claude-opus-5', effort: 'high', allowedTools: [] }) as unknown as AgentConfig

const ROSTER = [agent('sage', 'Sage'), agent('smith', 'Smith')]

/** One imported skill, so a `$` has something real to be gated against. */
const SKILLS = [
  { id: 'distill', name: 'Distill', description: 'Writes a note to the vault.' },
] as unknown as SkillConfig[]

/** Stands in for whatever the caller puts in the control slot, roster strip included. */
const STRIP = 'data-strip="roster"'

/** The class the control row wears, and nothing else does. */
const CONTROL_ROW = 'mt-2 flex items-center gap-2'

const render = (props: { controls?: boolean }) =>
  renderToStaticMarkup(
    <Composer
      agents={ROSTER}
      onSend={() => true}
      canSend
      blockedNote=""
      {...(props.controls === true ? { controls: <span data-strip="roster" /> } : {})}
    />,
  )

describe('the composer layout', () => {
  it('keeps the control row where there is something to control', () => {
    const html = render({ controls: true })

    expect(html).toContain(STRIP)
    expect(html).toContain(CONTROL_ROW)
  })

  // The row also carries the note and the send button, so it stays; only the slot
  // is empty. Asserting the strip is gone is what proves nothing was left behind.
  it('leaves the slot empty when the caller controls nothing', () => {
    const html = render({})

    expect(html).not.toContain(STRIP)
    expect(html).toContain(CONTROL_ROW)
    expect(html).toContain('Send (Enter)')
    expect(html).toContain('text-[16px] h-8 w-8')
    expect(html).toContain('rounded-[calc(var(--radius-composer)-var(--default-border-width))] bg-[color-mix(in_srgb,var(--color-composer)_82%,transparent)] backdrop-blur-[16px]')
  })

  it('does not draw a context ring beside send', () => {
    const html = render({})

    expect(html).not.toContain('Context per agent')
    expect(html).not.toContain('Context window')
  })

  it('draws the Single Work meter when the caller hands one', () => {
    const html = renderToStaticMarkup(
      <Composer
        agents={ROSTER}
        contextMeter={{ used: 44_000, window: 258_000 }}
        onSend={() => true}
        canSend
        blockedNote=""
      />,
    )

    expect(html).toContain('Context window 17% · 44k/258k')
    expect(html.indexOf('Context window 17%')).toBeLessThan(html.indexOf('Send (Enter)'))
    expect(html).not.toContain('Context per agent')
    expect(html).not.toContain('Session cost')
  })

  it('lifts a reply without outlining it', () => {
    const html = renderToStaticMarkup(
      <Composer
        agents={ROSTER}
        replyTo={{ turnId: 'reply-1', agentId: 'sage', text: 'Earlier reply' }}
        onSend={() => true}
        canSend
        blockedNote=""
      />,
    )

    expect(html.match(/bg-user-bg" title=/g)).toHaveLength(1)
    expect(html).not.toContain('border border-line bg-surface-2')
  })

  it('says why sending is off', () => {
    const html = renderToStaticMarkup(
      <Composer
        agents={ROSTER}
        onSend={() => true}
        canSend={false}
        blockedNote="Disconnected, sending is paused"
      />,
    )

    expect(html).toContain('Disconnected, sending is paused')
  })

  it('does not offer or highlight agent mentions in a DM', () => {
    const html = renderToStaticMarkup(
      <Composer
        agents={ROSTER}
        allowAgentMentions={false}
        placeholder="Message Sage. $ for a skill."
        onSend={() => true}
        canSend
        blockedNote=""
      />,
    )

    expect(html).toContain('placeholder="Message Sage. $ for a skill."')
    expect(html).not.toContain('@ for an agent')
  })

  it('offers every imported skill in a bare session without a persona', () => {
    writeDraft('single-skill', { text: '$di', images: [], files: [] })
    const html = renderToStaticMarkup(
      <Composer
        agents={[]}
        draftKey="single-skill"
        skills={SKILLS}
        allSkillsAvailable
        allowAgentMentions={false}
        allowWorkDestination={false}
        onSend={() => true}
        canSend
        blockedNote=""
      />,
    )

    expect(html).toContain('>Distill</span>')
    expect(html).not.toContain('No shared skills')
  })

  /**
   * What a DM puts in that slot: its one recipient and no one else. The facepile is
   * the failure this guards against — it is a picker, and a DM has nothing to pick.
   */
  it('gives a DM one menu, for the persona it is addressed to', () => {
    const html = renderToStaticMarkup(
      <RuntimeControls agents={[ROSTER[0]!]} overrides={{}} disabled={false} onChange={() => {}} />,
    )

    expect(html).toContain('Sage, provider, model, reasoning and speed for this chat')
    expect(html).not.toContain('Smith')
    // The facepile's own trigger copy, which a one-persona row must never fall back to.
    expect(html).not.toContain('Model and reasoning per agent')
  })

  it('folds a small Session roster into the facepile instead of bare model menus', () => {
    const team = ['Wren', 'Argus', 'Ellis'].map((name) => agent(name.toLowerCase(), name))
    const html = renderToStaticMarkup(
      <RuntimeControls agents={team} overrides={{}} disabled={false} onChange={() => {}} />,
    )

    expect(html).toContain('Model and reasoning per agent, for this chat')
    expect(html.match(/-ml-1.5 flex/g)).toHaveLength(3)
  })

  it('shows every Work face and a change mark instead of a count', () => {
    const house = ['Jeeves', 'Sage', 'Smith', 'Wren', 'Argus', 'Iris'].map((name) =>
      agent(name.toLowerCase(), name),
    )
    const html = renderToStaticMarkup(
      <RuntimeControls
        agents={house}
        overrides={{ smith: { model: 'claude-opus-5' } }}
        disabled={false}
        onChange={() => {}}
      />,
    )

    expect(html).toContain('Model and reasoning per agent, for this chat')
    expect(html).not.toContain('6 agents')
    expect(html).not.toContain('pinned')
    expect(html).toContain('changed from default')
    expect(html.match(/-ml-1.5 flex/g)).toHaveLength(6)
  })
})

/**
 * The way in for anyone who never learned `@` and `$`. The menu itself needs a
 * press and this suite has no DOM, so what is checked here is the trigger it hangs
 * off and the per-chat decision about which rows it would hold.
 */
describe('the plus menu', () => {
  it('hangs off the composer, with a picker that outlives the menu', () => {
    const html = render({})

    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('Attach and insert')
    // Rendered whether or not the menu is open: a picker opened from a row that
    // unmounts in the same click loses the file it was opened for.
    expect(html).toContain('type="file"')
    expect(html).toContain('image/png,image/jpeg,image/webp')
  })

  it('names all targets the one @ menu holds, in a project with files', () => {
    expect(plusMentionLabel(true, true)).toBe('Mention an agent, file or browser')
  })

  it('offers the browser alongside personas without a linked folder', () => {
    expect(plusMentionLabel(true, false)).toBe('Mention an agent or browser')
  })

  it('puts a direct finger-sized mention control on the phone', () => {
    const html = renderToStaticMarkup(
      <Composer agents={ROSTER} touchMode onSend={() => true} canSend blockedNote="" />,
    )

    expect(html).toContain('aria-label="Mention an agent, browser or Sessions"')
    expect(html).toContain('min-w-11')
    expect(html).toContain('h-11 w-11')
  })

  // A DM still has the integrated browser, without addressing another persona.
  it('drops the agent half in a DM', () => {
    expect(plusMentionLabel(false, true)).toBe('Reference a file or browser')
    expect(plusMentionLabel(false, false)).toBe('Use the Manor browser')
    expect(plusMentionLabel(false, false, { browser: false })).toBeNull()
  })

  /**
   * The side panel's composer: no persona to address, no picture to attach, and a
   * voice that can never run a skill however many are imported. The button is what
   * would be left, and it would open on an empty sheet.
   */
  it('is not drawn at all when it would hold nothing', () => {
    const bare = (allowSkills: boolean) =>
      renderToStaticMarkup(
        <Composer
          agents={ROSTER}
          allowAgentMentions={false}
          allowAttachments={false}
          allowWorkDestination={false}
          allowBrowserMentions={false}
          allowSkills={allowSkills}
          skills={SKILLS}
          onSend={() => true}
          canSend
          blockedNote=""
        />,
      )

    expect(bare(true)).toContain('Attach and insert')
    expect(bare(false)).not.toContain('Attach and insert')
  })

  it('keeps contenteditable on desktop and the native textarea on touch surfaces', () => {
    const desktop = render({})
    const touch = renderToStaticMarkup(
      <Composer agents={ROSTER} touchMode onSend={() => true} canSend blockedNote="" />,
    )

    expect(desktop).toContain('data-composer-editor="true"')
    expect(desktop).not.toContain('<textarea')
    expect(touch).toContain('<textarea')
    expect(touch).not.toContain('data-composer-editor="true"')
  })
})

/**
 * The composer's half of per-chat drafts: which one it picks up when it appears.
 * Parking on the way out is the store's job and is tested there; the swap between
 * two chats without an unmount needs a DOM this suite has not got.
 */
describe('a composer picking up a draft', () => {
  afterEach(clearDrafts)

  it('opens holding what was left in this chat', () => {
    writeDraft('chat-a', { text: 'half a thought', images: [], files: [] })

    const html = renderToStaticMarkup(
      <Composer agents={ROSTER} draftKey="chat-a" onSend={() => true} canSend blockedNote="" />,
    )

    expect(html).not.toContain('title="Send (Enter)" disabled=""')
  })

  it('opens empty in a chat nothing was left in', () => {
    writeDraft('chat-a', { text: 'half a thought', images: [], files: [] })

    const html = renderToStaticMarkup(
      <Composer agents={ROSTER} draftKey="chat-b" onSend={() => true} canSend blockedNote="" />,
    )

    expect(html).toContain('disabled="" title="Send (Enter)"')
  })
})

describe('the recipient label', () => {
  afterEach(clearDrafts)

  it('stays off until the caller asks for it', () => {
    const html = render({})
    expect(html).not.toContain('This message goes to')
  })

  it('names the fallback on an unmarked draft', () => {
    const html = renderToStaticMarkup(
      <Composer
        agents={ROSTER}
        showRecipients
        fallbackTargets={[ROSTER[0]!]}
        onSend={() => true}
        canSend
        blockedNote=""
      />,
    )
    expect(html).toContain('This message goes to')
    expect(html).toContain('Sage')
    expect(html).not.toContain('no one')
  })

  it('says no one when a group mention names only an outsider', () => {
    writeDraft('grp', { text: '@Sage kijk je mee', images: [], files: [] })
    const html = renderToStaticMarkup(
      <Composer
        agents={ROSTER}
        draftKey="grp"
        showRecipients
        memberIds={['smith']}
        fallbackTargets={[ROSTER[1]!]}
        onSend={() => true}
        canSend
        blockedNote=""
      />,
    )
    expect(html).toContain('no one')
    expect(html).not.toContain('Sends to Sage')
  })

  it('does not name a follow-up while a turn is still in flight', () => {
    const html = renderToStaticMarkup(
      <Composer
        agents={ROSTER}
        showRecipients
        recipientsUnknown
        fallbackTargets={[ROSTER[0]!]}
        onSend={() => true}
        canSend
        blockedNote=""
      />,
    )
    expect(html).toContain('This message goes to')
    expect(html).toContain('…')
    expect(html).not.toContain('Sends to Sage')
  })

  it('still names an explicit mention while a turn is in flight', () => {
    writeDraft('busy', { text: '@Smith pak jij dit', images: [], files: [] })
    const html = renderToStaticMarkup(
      <Composer
        agents={ROSTER}
        draftKey="busy"
        showRecipients
        recipientsUnknown
        fallbackTargets={[ROSTER[0]!]}
        onSend={() => true}
        canSend
        blockedNote=""
      />,
    )
    expect(html).toContain('Smith')
    expect(html).toContain('Sends to Smith')
    expect(html).not.toContain('>…<')
  })
})


describe('Work as a composer destination', () => {
  afterEach(clearDrafts)

  const renderWork = (text: string, allowAgentMentions = true, allowWorkDestination = true) => {
    writeDraft('work-destination', { text, images: [], files: [] })
    return renderToStaticMarkup(
      <Composer agents={ROSTER} draftKey="work-destination" allowAgentMentions={allowAgentMentions}
        allowWorkDestination={allowWorkDestination} allowBrowserMentions={false} onSend={() => true} canSend blockedNote="" />,
    )
  }

  it.each([true, false])('offers Work independently of agent mentions (%s)', (allowAgentMentions) => {
    const html = renderWork('@wo', allowAgentMentions)
    expect(html).toContain('role="option"')
    expect(html).toContain('>Sessions</span>')
    expect(html).toContain('>Destination</span>')
    expect(html).toContain('Send a task or this discussion to Sessions')
    expect(html).not.toContain('data-avatar=')
  })

  it('picks and sends the destination token with the discussed assignment', () => {
    writeDraft('work-send', { text: 'Stuur deze drie opdrachten door @wo', images: [], files: [] })
    const sent: string[] = []
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<Composer agents={[]} draftKey="work-send" allowAgentMentions={false}
        allowBrowserMentions={false}
        onSend={(text) => { sent.push(text); return true }} canSend blockedNote="" />)
    })
    act(() => tree.root.findByProps({ role: 'option' }).props.onMouseDown({ preventDefault() {} }))
    act(() => tree.root.findByProps({ title: 'Send (Enter)' }).props.onClick())
    expect(sent).toEqual(['Stuur deze drie opdrachten door @work'])
    act(() => tree.unmount())
  })

  it('filters the destination and leaves unsupported contexts without a Work option', () => {
    expect(renderWork('@WO')).toContain('>Destination</span>')
    expect(renderWork('@Smith')).not.toContain('>Destination</span>')
    expect(renderWork('@wo', false, false)).not.toContain('role="option"')
    expect(plusMentionLabel(false, false, { work: true, browser: false })).toBe('Send to Sessions')
  })
})


describe('the explicit browser suggestion', () => {
  afterEach(clearDrafts)

  it.each([true, false])('offers the integrated browser with agent mentions enabled: %s', (allowAgentMentions) => {
    writeDraft('browser', { text: 'Use @bro', images: [], files: [] })
    const html = renderToStaticMarkup(
      <Composer agents={ROSTER} draftKey="browser" allowAgentMentions={allowAgentMentions} allowWorkDestination={false} onSend={() => true} canSend blockedNote="" />,
    )
    expect(html).toContain('Integrated Manor browser')
    expect(html).toContain('>@browser<')
  })

  it('does not advertise the browser in a tool-free side chat', () => {
    writeDraft('browser', { text: '@bro', images: [], files: [] })
    const html = renderToStaticMarkup(
      <Composer agents={ROSTER} draftKey="browser" allowBrowserMentions={false} allowWorkDestination={false} onSend={() => true} canSend blockedNote="" />,
    )
    expect(html).not.toContain('Integrated Manor browser')
  })
})

describe('the desktop computer suggestion', () => {
  afterEach(clearDrafts)

  it('offers Computer Use as an @ mention on desktop', () => {
    writeDraft('computer', { text: 'Use @comp', images: [], files: [] })
    const html = renderToStaticMarkup(
      <Composer agents={ROSTER} draftKey="computer" allowComputerMentions onSend={() => true} canSend blockedNote="" />,
    )
    expect(html).toContain('Use Mac apps through Cua')
    expect(html).toContain('>Computer Use<')
    expect(html).toContain('>@computer<')
  })

  it('does not offer Computer Use in a phone layout or without the desktop capability', () => {
    writeDraft('computer', { text: '@comp', images: [], files: [] })
    const renderComputer = (props: { touchMode?: boolean; allowComputerMentions?: boolean }) => renderToStaticMarkup(
      <Composer agents={ROSTER} draftKey="computer" onSend={() => true} canSend blockedNote="" {...props} />,
    )
    expect(renderComputer({ touchMode: true, allowComputerMentions: true })).not.toContain('Use Mac apps through Cua')
    expect(renderComputer({ allowComputerMentions: false })).not.toContain('Use Mac apps through Cua')
  })
})
