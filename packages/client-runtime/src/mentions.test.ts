import type { AgentConfig, SkillConfig, ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'

import { imageRefSpans, snapRefDeletion } from '@manor/contracts'
import { addressDraft, agentMentionSpans, activeImageRef, activeMention, applyImageRef, applyMention, matchAgents, matchImageRefs, matchesBrowserMention, matchesWorkMention, chatFallbackTargets, composerShowsRecipients, draftRecipients, eligibleSkills, followUpTargets, replyFallbackTargets, roomAgents } from './mentions'

const agent = (id: string, name: string, isCos = false) => ({ id, name, isCos }) as AgentConfig
const smith = agent('smith', 'Smith', true)
const ada = agent('ada', 'Ada')
const bob = agent('bob', 'Bob')
const roster = [smith, ada, bob]

const user = { type: 'user_message', text: 'hi' } as ThreadEvent
const reply = (agentId: string) => ({ type: 'agent_message', agentId } as ThreadEvent)

/** The picture case every plain text field runs: its spans come from the text before the edit. */
const snapImageRefDeletion = (previous: string, next: string, count: number, selection?: { start: number; end: number }) =>
  snapRefDeletion(previous, next, imageRefSpans(previous, count), selection)

describe('draftRecipients', () => {
  it('names the mentioned personas in the room', () => {
    expect(draftRecipients('@Ada help', roster, undefined, ['smith', 'ada'])).toEqual([ada])
  })
  it('is nobody for a mention of only outsiders, not a fall back', () => {
    expect(draftRecipients('@Bob help', roster, [smith], ['smith', 'ada'])).toEqual([])
  })
  it('falls back to the chief of staff when nothing is passed', () => {
    expect(draftRecipients('help', roster)).toEqual([smith])
  })
  it('keeps an explicitly empty fallback empty', () => {
    expect(draftRecipients('help', roster, [])).toEqual([])
  })
  it('reaches every chat agent by mention, a former DM-only one included', () => {
    const watcher = { ...ada, id: 'watcher', name: 'Watcher' }
    expect(draftRecipients('@Watcher help', [...roster, watcher])).toEqual([watcher])
  })
  it('uses a staged reply as fallback while leaving explicit mentions in charge', () => {
    const fallback = replyFallbackTargets({ agentId: 'ada' }, roster, [smith], ['smith', 'ada'])
    expect(draftRecipients('help', roster, fallback, ['smith', 'ada'])).toEqual([ada])
    expect(draftRecipients('@Smith help', roster, fallback, ['smith', 'ada'])).toEqual([smith])
  })
})

describe('followUpTargets', () => {
  it('is the sole persona who answered since the user last spoke', () => {
    expect(followUpTargets([user, reply('ada')], roster)).toEqual([ada])
  })
  it('is undefined with two repliers or none', () => {
    expect(followUpTargets([user, reply('ada'), reply('bob')], roster)).toBeUndefined()
    expect(followUpTargets([reply('ada'), user], roster)).toBeUndefined()
  })
})

describe('chatFallbackTargets', () => {
  it('takes the chief of staff in a project chat with no follow-up or lead', () => {
    expect(chatFallbackTargets({ kind: 'project' }, [user], roster)).toEqual([smith])
  })
  it('drops a follow-up target who left the group and takes the chief of staff', () => {
    expect(chatFallbackTargets({ kind: 'group', memberIds: ['smith', 'ada'] }, [user, reply('bob')], roster)).toEqual([smith])
  })
  it('is nobody in a group without the chief of staff', () => {
    expect(chatFallbackTargets({ kind: 'group', memberIds: ['ada', 'bob'] }, [user], roster)).toEqual([])
  })
  it('follows up with a former DM-only speaker in a group it sits in', () => {
    const watcher = { ...ada, id: 'watcher', name: 'Watcher' }
    expect(chatFallbackTargets({ kind: 'group', memberIds: ['smith', 'watcher'] }, [user, reply('watcher')], [...roster, watcher])).toEqual([watcher])
  })
})

describe('composerShowsRecipients', () => {
  it('waits for the thread to begin and never shows on a dm', () => {
    expect(composerShowsRecipients('project', [])).toBe(false)
    expect(composerShowsRecipients('project', [], 1)).toBe(true)
    expect(composerShowsRecipients('group', [user])).toBe(true)
    expect(composerShowsRecipients('dm', [user])).toBe(false)
  })
})

describe('the skills a draft may run', () => {
  const withSkills = (one: AgentConfig, skillIds: string[]) => ({ ...one, skillIds }) as AgentConfig
  const skill = (id: string) => ({ id, name: id, description: '' }) as SkillConfig

  const sage = withSkills(ada, ['distill', 'wiki'])
  const dev = withSkills(bob, ['deploy'])
  const skills = [skill('distill'), skill('wiki'), skill('deploy')]

  it('offers the DM recipient its own skills, named or not', () => {
    // A DM is a solo room: the orchestrator parses no mentions there, so `@Bob` is
    // text Ada reads and the skills on offer stay hers. The caller says so by
    // passing an empty routing roster, which is what makes every draft fall back.
    expect(eligibleSkills('$', [], skills, [sage]).map((one) => one.id)).toEqual(['distill', 'wiki'])
    expect(eligibleSkills('@Bob $', [], skills, [sage]).map((one) => one.id)).toEqual(['distill', 'wiki'])
  })

  it('offers nothing when a group names only an outsider', () => {
    // A group does route mentions, and the server drops one from outside the room,
    // so a skill picked here would go to nobody.
    expect(eligibleSkills('@Bob $', [sage, dev], skills, [sage], ['ada'])).toEqual([])
  })

  it('offers only what every addressed persona holds', () => {
    expect(eligibleSkills('@Ada @Bob $', [sage, dev], skills)).toEqual([])
    expect(eligibleSkills('@Ada $', [sage, dev], skills).map((one) => one.id)).toEqual(['distill', 'wiki'])
  })

  it('offers the reply target skills until an explicit mention replaces it', () => {
    const fallback = replyFallbackTargets({ agentId: dev.id }, [sage, dev], [sage])
    expect(eligibleSkills('$', [sage, dev], skills, fallback).map((one) => one.id)).toEqual(['deploy'])
    expect(eligibleSkills('@Ada $', [sage, dev], skills, fallback).map((one) => one.id)).toEqual(['distill', 'wiki'])
  })
})


describe('the shared browser completion used by web and mobile', () => {
  it('matches the browser token and inserts a complete explicit target', () => {
    const text = 'Check @BRO after this'
    const caret = 'Check @BRO'.length
    const query = activeMention(text, caret)!
    expect(matchesBrowserMention(query.query)).toBe(true)
    expect(matchesBrowserMention('')).toBe(true)
    expect(matchesBrowserMention('smith')).toBe(false)
    expect(['', 'wo', 'Ses', 'sessions'].every(matchesWorkMention)).toBe(true)
    expect(matchesWorkMention('smith')).toBe(false)
    expect(matchAgents([...roster, agent('browser-agent', 'Browser')], 'bro')).toEqual([])
    expect(matchAgents([...roster, agent('computer-agent', 'Computer')], 'comp')).toEqual([])
    expect(applyMention(text, caret, query.start, 'browser')).toEqual({
      text: 'Check @browser  after this', caret: 'Check @browser '.length,
    })
  })

  it('keeps browser targeting separate from the addressed persona', () => {
    expect(draftRecipients('@browser check this', roster, [ada])).toEqual([ada])
    expect(draftRecipients('@Smith use @browser', roster, [ada])).toEqual([smith])
  })
})


describe('persona chips shared by mobile Markdown and web', () => {
  it('preserves known-persona chips while leaving tool targets as text', () => {
    const agents = [...roster, agent('browser-persona', 'Browser'), agent('computer-persona', 'Computer')]
    expect(agentMentionSpans('@Browser @Computer ask @Ada in @browser, @unknown', agents)).toEqual([
      { start: '@Browser @Computer ask '.length, handle: 'Ada' },
    ])
  })
})

describe('placement', () => {
  const wren = { ...agent('wren', 'Wren'), placement: 'session' } as AgentConfig
  const argus = { ...agent('argus', 'Argus'), placement: 'session' } as AgentConfig
  const sage = { ...agent('sage', 'Sage', true), placement: 'chat' } as AgentConfig
  const house = [sage, wren, argus]
  it('seats Session personas in a Session and chat personas everywhere else', () => {
    expect(roomAgents(house, { kind: 'project' })).toEqual([wren, argus])
    expect(roomAgents(house, { kind: 'group' })).toEqual([sage])
    expect(roomAgents(house, { kind: 'project', legacySessionAgentIds: ['sage'] })).toEqual([sage])
  })
  it('reads a typed name against the whole house and reaches nobody when the room cannot seat it', () => {
    const session = { kind: 'project' } as const
    // A chat persona named in a Session reaches nobody, not the Session lead.
    expect(draftRecipients('@Sage help', house, [wren], undefined, roomAgents(house, session))).toEqual([])
    expect(eligibleSkills('@Sage $', house, [{ id: 'distill' } as SkillConfig], [wren], undefined, roomAgents(house, session))).toEqual([])
    // And a Session persona named in a group reaches nobody, not the chief of staff.
    expect(draftRecipients('@Wren help', house, [sage], ['sage', 'wren'], roomAgents(house, { kind: 'group' }))).toEqual([])
    expect(draftRecipients('@Argus help', house, [wren], undefined, roomAgents(house, session))).toEqual([argus])
  })
  it('falls back to the Session lead, then a fitting chief of staff, then the first Session persona seated', () => {
    expect(chatFallbackTargets({ kind: 'project' }, [], house, 'argus')).toEqual([argus])
    expect(chatFallbackTargets({ kind: 'project' }, [], house)).toEqual([wren])
    expect(chatFallbackTargets({ kind: 'project' }, [user, reply('argus')], house, 'wren')).toEqual([argus])
  })
  it('names the same fallback on an install without that persona, or nobody', () => {
    const ellis = { ...agent('ellis', 'Ellis'), placement: 'session' } as AgentConfig
    expect(chatFallbackTargets({ kind: 'project' }, [], [sage, ellis, argus])).toEqual([ellis])
    expect(chatFallbackTargets({ kind: 'project' }, [], [sage, ellis, argus], 'gone')).toEqual([ellis])
    expect(chatFallbackTargets({ kind: 'project', legacySessionAgentIds: ['argus'] }, [], [sage, ellis, argus])).toEqual([argus])
    expect(chatFallbackTargets({ kind: 'project' }, [], [sage])).toEqual([])
    // The author's roster order is argus, wren, ellis, and the default persona still answers.
    expect(chatFallbackTargets({ kind: 'project' }, [], [sage, argus, wren, ellis])).toEqual([wren])
  })
})

describe('image references', () => {
  it('opens # only with staged pictures and digits, and inserts the reference', () => {
    expect(activeImageRef('see #', 5, 0)).toBeNull()
    expect(activeImageRef('## Heading', 2, 3)).toBeNull()
    expect(activeImageRef('C#', 2, 3)).toBeNull()
    expect(activeImageRef('see #2', 6, 3)).toEqual({ start: 4, query: '2' })
    expect(matchImageRefs(3, '')).toEqual([1, 2, 3])
    expect(applyImageRef('see #2', 6, 4, 2)).toEqual({ text: 'see [Image #2] ', caret: 15 })
  })

  it('takes a whole reference on a backspace into it, and leaves other edits alone', () => {
    expect(snapImageRefDeletion('see [Image #2] now', 'see [Image #2 now', 2)).toEqual({ text: 'see  now', caret: 4 })
    expect(snapImageRefDeletion('see [Image #2] now', 'see [Image #2]now', 2)).toBeNull()
    // A number past the staged pictures is prose, so it deletes a character at a time.
    expect(snapImageRefDeletion('see [Image #4]', 'see [Image #4', 2)).toBeNull()
    // Typing over a selected reference keeps what was typed.
    expect(snapImageRefDeletion('see [Image #1] now', 'see x now', 2)).toEqual({ text: 'see x now', caret: 5 })
    expect(snapImageRefDeletion('see [Image #1] now', 'see [Imxe #1] now', 2)).toEqual({ text: 'see x now', caret: 5 })
    // With the selection known, a replacement that starts like the reference keeps all of it.
    expect(snapImageRefDeletion('see [Image #1] now', 'see [ now', 2, { start: 4, end: 14 })).toEqual({ text: 'see [ now', caret: 5 })
    expect(snapImageRefDeletion('see [Image #1] now', 'see [Image #2] now', 2, { start: 4, end: 14 })).toEqual({ text: 'see [Image #2] now', caret: 14 })
    // A collapsed caret is a backspace, which the diff reads on its own.
    expect(snapImageRefDeletion('see [Image #2] now', 'see [Image #2 now', 2, { start: 14, end: 14 })).toEqual({ text: 'see  now', caret: 4 })
  })
})

describe('addressDraft', () => {
  it('puts the pick first in place of the mentions that open the draft', () => {
    expect(addressDraft('', roster, 'Ada')).toEqual({ text: '@Ada ', caret: 5 })
    expect(addressDraft('kijk even mee', roster, 'Ada').text).toBe('@Ada kijk even mee')
    expect(addressDraft('@Smith kijk even mee', roster, 'Ada').text).toBe('@Ada kijk even mee')
    expect(addressDraft('@Smith @Bob kijk', roster, 'Ada').text).toBe('@Ada kijk')
    expect(addressDraft('@Smith, @Bob please review', roster, 'Ada').text).toBe('@Ada please review')
    expect(addressDraft('@Smith & @Bob, kijk', roster, 'Ada').text).toBe('@Ada kijk')
  })

  it('keeps mentions later in the text and handles that are not agents', () => {
    expect(addressDraft('@Smith vraag @Bob ook', roster, 'Ada').text).toBe('@Ada vraag @Bob ook')
    expect(addressDraft('@browser open de site', roster, 'Ada').text).toBe('@Ada @browser open de site')
  })
})
