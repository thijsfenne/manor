import { describe, expect, it } from 'vitest'
import {
  bornSplitChatId,
  chatOnStage,
  nextSplitDraftSide,
  parkDraftSide,
  clampSplitRatio,
  closeSplitPane,
  dropMissingSplit,
  focusSplitPane,
  splitLane,
  laneOfView,
  roomSplit,
  isWorkChat,
  navigateSplit,
  newSessionOnRight,
  occupiedSplitIds,
  openOnRight,
  replaceSplitPane,
  settleSplitChat,
  splitAvailable,
  splitPaneContentWidth,
  splitResumeIds,
  splitSideOf,
  unloadedSplitPanes,
  type SplitStage,
} from '../src/splitStage'
import { CHAT_STAGE_MIN_WIDTH, rightPanelOverlays } from '../src/useRightPanel'

const split = (partial: Partial<SplitStage> = {}): SplitStage => ({
  leftChatId: 'left',
  rightChatId: 'right',
  focus: 'left',
  view: 'inbox',
  ...partial,
})

describe('work-thread split', () => {
  it('floats a panel inside a narrow pane even when the full stage could dock it', () => {
    const stage = 1_300
    const panel = 412
    expect(rightPanelOverlays(stage, 0, panel)).toBe(false)
    for (const side of ['left', 'right'] as const) {
      const available = splitPaneContentWidth(stage, 0.5, side)
      expect(available).toBe(650)
      expect(rightPanelOverlays(available, 0, panel)).toBe(true)
    }
  })

  it('uses the resized owning pane and restores docking at the chat floor', () => {
    const panel = 412
    const pane = CHAT_STAGE_MIN_WIDTH + panel
    const stage = pane * 3
    const left = splitPaneContentWidth(stage, 1 / 3, 'left')
    expect(rightPanelOverlays(left, 0, panel)).toBe(false)
    expect(rightPanelOverlays(left - 1, 0, panel)).toBe(true)
    const right = splitPaneContentWidth(stage, 1 / 3, 'right')
    expect(right).toBeCloseTo(pane * 2)
    expect(rightPanelOverlays(right, 0, panel)).toBe(false)
    expect(rightPanelOverlays(left, 0, 0)).toBe(false)
  })

  it('opens a second work thread on the right without moving focus', () => {
    expect(openOnRight(null, 'left', 'right', 'work', 'work', 'inbox')).toEqual({
      split: { leftChatId: 'left', rightChatId: 'right', focus: 'left', view: 'inbox' },
      focusId: null,
      loadId: 'right',
    })
  })

  it('refuses a DM or the already-open thread into a plain open', () => {
    expect(openOnRight(null, 'dm', 'right', 'dm', 'work', 'inbox')).toEqual({
      split: null,
      focusId: 'right',
      loadId: null,
    })
    expect(openOnRight(null, 'left', 'left', 'work', 'work', 'inbox')).toEqual({
      split: null,
      focusId: 'left',
      loadId: null,
    })
  })

  it('replaces the right pane when a split is already up', () => {
    expect(openOnRight(split(), 'left', 'other', 'work', 'work', 'inbox')).toEqual({
      split: split({ rightChatId: 'other' }),
      focusId: null,
      loadId: 'other',
    })
  })

  it('focuses a thread that is already in a pane', () => {
    expect(openOnRight(split(), 'left', 'left', 'work', 'work', 'inbox').focusId).toBe('left')
    expect(openOnRight(split(), 'left', 'right', 'work', 'work', 'inbox')).toEqual({
      split: split({ focus: 'right' }),
      focusId: 'right',
      loadId: null,
    })
  })

  it('closing one pane leaves the other on the stage', () => {
    expect(closeSplitPane(split(), 'right')).toEqual({
      split: null,
      focusId: 'left',
      loadId: null,
    })
    expect(closeSplitPane(split(), 'left').focusId).toBe('right')
  })

  it('sidebar navigation replaces only the focused work pane and parks it for a DM', () => {
    expect(navigateSplit(split(), 'next', 'work', 'project')).toEqual({
      split: split({ leftChatId: 'next' }),
      focusId: 'next',
      loadId: null,
    })
    expect(navigateSplit(split({ focus: 'right' }), 'next', 'work', 'project').split).toEqual(
      split({ rightChatId: 'next', focus: 'right' }),
    )
    expect(navigateSplit(split(), 'right', 'work', 'project').focusId).toBe('right')
    expect(navigateSplit(split(), 'dm', 'dm', 'dm')).toEqual({
      split: split(),
      focusId: 'dm',
      loadId: null,
    })
  })

  it('drops a pane whose chat has left the directory', () => {
    expect(dropMissingSplit(split(), new Set(['left', 'right']))).toBeNull()
    expect(dropMissingSplit(split(), new Set(['left']))).toEqual({
      split: null,
      focusId: 'left',
      loadId: null,
    })
    expect(dropMissingSplit(split(), new Set())).toEqual({
      split: null,
      focusId: null,
      loadId: null,
    })
  })

  it('keeps each pane at least 375px and stays off the phone', () => {
    expect(splitAvailable(true, 900)).toBe(false)
    expect(splitAvailable(false, 749)).toBe(false)
    expect(splitAvailable(false, 750)).toBe(true)
    expect(clampSplitRatio(0.05, 800)).toBe(375 / 800)
    expect(clampSplitRatio(0.95, 800)).toBe(1 - 375 / 800)
    expect(focusSplitPane(split(), 'right').focusId).toBe('right')
    expect(isWorkChat('project')).toBe(true)
    expect(isWorkChat('run')).toBe(true)
    expect(isWorkChat('dm')).toBe(false)
  })

  it('pairs a session only with a session and a DM only with a DM, never a room chat', () => {
    expect(splitLane('project', false)).toBe('work')
    expect(splitLane('run', false)).toBe('work')
    expect(splitLane('dm', false)).toBe('dm')
    expect(splitLane('group', false)).toBeNull()
    // A project thread and the sessions it started belong to their room.
    expect(splitLane('project', true)).toBeNull()
    expect(laneOfView('inbox')).toBe('work')
    expect(laneOfView('chats')).toBe('dm')
    // A session beside a DM, or a DM beside a session, is a plain open now.
    expect(openOnRight(null, 'session', 'dm', 'work', 'dm', 'inbox')).toEqual({ split: null, focusId: 'dm', loadId: null })
    expect(openOnRight(split({ view: 'chats', leftChatId: 'dm-a', rightChatId: 'dm-b' }), 'dm-a', 'session', 'dm', 'work', 'chats').split).toBeNull()
    // A project thread on stage takes nothing beside it but its own sessions side.
    expect(openOnRight(null, 'thread', 'session', null, 'work', 'inbox')).toEqual({ split: null, focusId: 'session', loadId: null })
    expect(openOnRight(null, 'session', 'room-session', 'work', null, 'inbox').split).toBeNull()
  })

  it('opens a room with the thread left and its session live on the right', () => {
    expect(roomSplit('thread', 'session')).toEqual({ leftChatId: 'thread', rightChatId: 'session', focus: 'right', view: 'inbox' })
    // Opening the thread or a room session from the Sessions list drops a sessions split.
    expect(navigateSplit(split(), 'thread', null, 'project')).toEqual({ split: null, focusId: 'thread', loadId: null })
  })

  it('drops the drafting side from the occupied sidebar rows', () => {
    expect(occupiedSplitIds(split(), null)).toEqual(['left', 'right'])
    expect(occupiedSplitIds(split(), 'left')).toEqual(['right'])
    expect(occupiedSplitIds(split({ focus: 'right' }), 'right')).toEqual(['left'])
  })

  it('puts a born chat on the side that held the draft', () => {
    expect(replaceSplitPane(split(), 'left', 'born')).toEqual(split({ leftChatId: 'born' }))
    expect(replaceSplitPane(split(), 'right', 'born').rightChatId).toBe('born')
  })

  it('vacates and focuses the settled pane without occupying its sidebar row', () => {
    const emptyLeft = settleSplitChat(split({ focus: 'right' }), 'left', null)!
    expect(emptyLeft).toEqual(split({ leftChatId: null }))
    expect(occupiedSplitIds(emptyLeft, null)).toEqual(['right'])
    expect(focusSplitPane(emptyLeft, 'left').focusId).toBeNull()
    expect(dropMissingSplit(emptyLeft, new Set(['right']))).toBeNull()
    expect(splitResumeIds(null, null, emptyLeft)).toEqual(['right'])
    expect(settleSplitChat(split(), 'left', 'left')).toBeNull()
    expect(settleSplitChat(split(), 'outside', null)).toBeNull()
  })

  it('fills an empty pane with a selected or newly created thread', () => {
    const empty = split({ rightChatId: null, focus: 'right' })
    expect(navigateSplit(empty, 'next', 'work', 'project').split).toEqual(split({ rightChatId: 'next', focus: 'right' }))
    expect(replaceSplitPane(empty, 'right', 'born')).toEqual(split({ rightChatId: 'born', focus: 'right' }))
    expect(navigateSplit(empty, 'left', 'work', 'project').split).toEqual({ ...empty, focus: 'left' })
    expect(openOnRight(empty, null, 'next', null, 'work', 'inbox').split).toEqual(split({ rightChatId: 'next', focus: 'right' }))
  })

  it('keeps two empty slots and closes onto an empty survivor without reviving a chat', () => {
    const emptyLeft = settleSplitChat(split(), 'left', null)!
    const bothEmpty = settleSplitChat(emptyLeft, 'right', null)!
    expect(bothEmpty).toEqual(split({ leftChatId: null, rightChatId: null, focus: 'right' }))
    expect(occupiedSplitIds(bothEmpty, null)).toEqual([])
    expect(dropMissingSplit(bothEmpty, new Set())).toBeNull()
    expect(closeSplitPane(emptyLeft, 'right')).toEqual({ split: null, focusId: null, loadId: null })
    expect(closeSplitPane(emptyLeft, 'left').focusId).toBe('right')
  })

  it('waits to name a born pane until the directory lists it', () => {
    expect(bornSplitChatId('born', 'left', new Set(['left', 'right']))).toBeNull()
    expect(bornSplitChatId('born', 'left', new Set(['left', 'right', 'born']))).toBe('born')
    expect(bornSplitChatId(null, 'born', new Set(['left', 'right', 'born']))).toBe('born')
    expect(dropMissingSplit(replaceSplitPane(split(), 'left', 'born'), new Set(['left', 'right']))).toEqual({
      split: null,
      focusId: 'right',
      loadId: null,
    })
    expect(dropMissingSplit(replaceSplitPane(split(), 'left', 'born'), new Set(['left', 'right']), 'born')).toBeNull()
  })

  it('resumes the focused thread and the other split pane after a reconnect', () => {
    expect(splitResumeIds('left', null, null)).toEqual(['left'])
    expect(splitResumeIds('left', 'pending', split())).toEqual(['pending', 'left', 'right'])
    expect(splitResumeIds('left', null, split())).toEqual(['left', 'right'])
  })

  it('asks for a room thread when the room opens on its session', () => {
    const room = roomSplit('thread', 'session')
    const none = new Set<string>()
    expect(unloadedSplitPanes(room, 'session', () => false, none)).toEqual(['thread'])
    // Once asked, or once held, the thread is not asked for again.
    expect(unloadedSplitPanes(room, 'session', () => false, new Set(['thread']))).toEqual([])
    expect(unloadedSplitPanes(room, 'session', (id) => id === 'thread', none)).toEqual([])
    // The stage's own chat belongs to the open that set it; an empty pane asks nothing.
    expect(unloadedSplitPanes(split({ rightChatId: null }), 'left', () => false, none)).toEqual([])
    expect(unloadedSplitPanes(null, 'left', () => false, none)).toEqual([])
  })
})

describe('New session dropped beside the stage', () => {
  it('opens beside the open thread when nothing is split yet', () => {
    expect(newSessionOnRight(null, 'a')).toEqual({ leftChatId: 'a', rightChatId: null, focus: 'right', view: 'inbox' })
    expect(newSessionOnRight(null, null)).toBeNull()
  })

  it('takes an emptied, focused right pane of a split that has no open thread', () => {
    const split: SplitStage = { leftChatId: 'a', rightChatId: null, focus: 'right', view: 'inbox' }
    expect(newSessionOnRight(split, null)).toEqual(split)
  })

  it('keeps both threads of a full split and only moves focus right', () => {
    expect(newSessionOnRight({ leftChatId: 'a', rightChatId: 'b', focus: 'left', view: 'inbox' }, 'a'))
      .toEqual({ leftChatId: 'a', rightChatId: 'b', focus: 'right', view: 'inbox' })
  })
})

describe('a DM in split view', () => {
  it('opens beside another DM and stays in Agents', () => {
    expect(openOnRight(null, 'dm-a', 'dm-b', 'dm', 'dm', 'chats').split)
      .toEqual({ leftChatId: 'dm-a', rightChatId: 'dm-b', focus: 'left', view: 'chats' })
    // A group on stage is not split; the dragged DM simply opens.
    expect(openOnRight(null, 'group', 'dm-b', null, 'dm', 'chats')).toEqual({ split: null, focusId: 'dm-b', loadId: null })
  })

  it('a DM row replaces the focused pane of a DM split; a group drops it', () => {
    const dms = split({ leftChatId: 'dm-a', rightChatId: 'dm-b', view: 'chats' })
    expect(navigateSplit(dms, 'dm-c', 'dm', 'dm').split).toEqual({ ...dms, leftChatId: 'dm-c' })
    expect(navigateSplit(dms, 'dm-b', 'dm', 'dm').split).toEqual({ ...dms, focus: 'right' })
    expect(navigateSplit(dms, 'group', null, 'group')).toEqual({ split: null, focusId: 'group', loadId: null })
    // A session opens in Sessions and leaves the DM split parked for Agents.
    expect(navigateSplit(dms, 'session', 'work', 'project').split).toBe(dms)
    expect(splitSideOf(dms, 'dm-b')).toBe('right')
    expect(splitSideOf(dms, 'other')).toBeNull()
  })
})

describe('an agent without a DM, and a narrow window', () => {
  it('drops a DM draft into the right pane and keeps the left one', () => {
    expect(newSessionOnRight(null, 'session', 'inbox')).toEqual({ leftChatId: 'session', rightChatId: null, focus: 'right', view: 'inbox' })
    expect(newSessionOnRight(null, 'dm-a', 'chats')).toEqual({ leftChatId: 'dm-a', rightChatId: null, focus: 'right', view: 'chats' })
    const dms = split({ leftChatId: 'dm-a', rightChatId: 'dm-b', view: 'chats' })
    expect(newSessionOnRight(dms, 'dm-a', 'chats')).toEqual({ ...dms, focus: 'right' })
  })

  it('shows a chat only under its own list', () => {
    expect(chatOnStage({ kind: 'project' }, 'inbox')).toBe(true)
    expect(chatOnStage({ kind: 'dm' }, 'chats')).toBe(true)
    expect(chatOnStage({ kind: 'dm' }, 'inbox')).toBe(false)
  })
})

describe('a DM draft dropped into a pane', () => {
  const sessionSplit = split({ leftChatId: 'session', rightChatId: null, focus: 'right' })
  const dmSplit = split({ leftChatId: 'dm-a', rightChatId: null, focus: 'right', view: 'chats' })

  it('keeps its pane through narrowing and widening, and the first send takes it', () => {
    // Narrowing hides the split but changes neither input, so the side survives it and the widening back.
    expect(splitAvailable(false, 700)).toBe(false)
    expect(nextSplitDraftSide('right', 'dm', dmSplit, 'chats')).toBe('right')
    const born = replaceSplitPane(dmSplit, 'right', 'dm-new')
    expect(born).toEqual({ ...dmSplit, rightChatId: 'dm-new', focus: 'right' })
    expect(nextSplitDraftSide('right', null, born, 'chats')).toBeNull()
  })

  it('lets go of the pane once its split is gone or belongs to the other list', () => {
    expect(nextSplitDraftSide('right', 'dm', null, 'chats')).toBeNull()
    expect(nextSplitDraftSide('right', 'dm', sessionSplit, 'chats')).toBeNull()
    // A DM draft started from a list claims no pane of its own.
    expect(nextSplitDraftSide(null, 'dm', dmSplit, 'chats')).toBeNull()
    expect(nextSplitDraftSide(null, 'project', split({ focus: 'right' }), 'inbox')).toBe('right')
    expect(nextSplitDraftSide(null, 'project', dmSplit, 'inbox')).toBeNull()
  })

  it('brings a returning New session draft back to the pane it was parked in, not the focused one', () => {
    const focusedLeft = split({ focus: 'left' })
    expect(nextSplitDraftSide(null, 'project', focusedLeft, 'inbox', 'right')).toBe('right')
    expect(nextSplitDraftSide(null, 'project', focusedLeft, 'inbox')).toBe('left')
    expect(nextSplitDraftSide(null, 'project', dmSplit, 'inbox', 'right')).toBeNull()
  })

  it('keeps the parked pane only while the draft is away from the Sessions stage', () => {
    const focusedLeft = split({ focus: 'left' })
    const parked = parkDraftSide(null, focusedLeft, 'project', 'right', false)
    expect(parked).toBe('right')
    // Left for Plugins or Agents: kept for the way back.
    expect(parkDraftSide(parked, focusedLeft, null, null, false)).toBe('right')
    // Back on the stage, before the side is written again.
    expect(parkDraftSide(parked, focusedLeft, 'project', null, false)).toBe('right')
    // Dismissed by a row in Sessions, or sent and born there: a fresh ⌘N takes the focused pane.
    const ended = parkDraftSide(parked, focusedLeft, null, null, true)
    expect(ended).toBeNull()
    expect(nextSplitDraftSide(null, 'project', focusedLeft, 'inbox', ended)).toBe('left')
    expect(parkDraftSide(parked, null, 'project', 'right', false)).toBeNull()
  })
})
