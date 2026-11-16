import type { ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CURRENT_CHECKOUT, type Chat, type Project } from '@manor/contracts'
import { ChatPanelRegion } from '../src/components/ChatPanelRegion'
import { RepoFilesPanel } from '../src/components/RepoFilesPanel'
import { ProjectMemoryPanel } from '../src/components/ProjectMemoryPanel'
import { KnowledgePanel } from '../src/components/knowledge/KnowledgePanel'
import { BrowserPanel } from '../src/components/BrowserPanel'
import { emptyWorkspace, repoListingKey } from '../src/state'
import { RIGHT_PANEL_MOTION_MS } from '../src/useRightPanel'
import { BROWSER_EXPANDED_KEY, expandPanel } from '../src/useFilesPanel'

vi.mock('../src/components/RepoFilesPanel', () => ({ RepoFilesPanel: () => null }))
vi.mock('../src/components/ProjectMemoryPanel', () => ({ ProjectMemoryPanel: () => null }))
vi.mock('../src/components/knowledge/KnowledgePanel', () => ({ KnowledgePanel: () => null }))
vi.mock('../src/components/BrowserPanel', () => ({ BrowserPanel: () => null }))

type Layout = ComponentProps<typeof ChatPanelRegion>['layout']

let view: ReactTestRenderer
beforeEach(() => {
  vi.useFakeTimers()
  const events = new EventTarget()
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: vi.fn() },
    setTimeout, clearTimeout,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  })
})
afterEach(() => {
  act(() => view?.unmount())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const chat = (id: string): Chat => ({
  id, projectId: 'project', title: id, kind: 'project', routineId: null,
  parentChatId: null, sideModel: null, sideEffort: null,
  memberIds: [], agentIds: [], createdAt: 1, lastMessageAt: 1,
  lastMessagePreview: null, settledAt: null, archivedAt: null, checkout: CURRENT_CHECKOUT,
})
const left = chat('left')
const right = chat('right')
const read = vi.fn(() => true)
const save = vi.fn(() => true)
const props = (chat: Chat): ComponentProps<typeof ChatPanelRegion> => ({
  chat,
  manor: {
    status: 'live',
    workspace: {
      ...emptyWorkspace,
      projects: [{ id: 'project', repoPaths: ['/repo'] } as Project],
      repoFiles: {
        [repoListingKey('project', 'left')]: { files: ['left.md'] },
        [repoListingKey('project', 'right')]: { files: ['right.md'] },
      },
    },
    readRepoFile: read, writeRepoFile: save,
    browserActivity: {}, externalBrowser: null,
  } as unknown as ComponentProps<typeof ChatPanelRegion>['manor'],
  layout: [['files']], availableWidth: 600, overlayResizable: true, phone: false, focused: chat.id === 'left',
  instant: false, ownsBrowserView: true, browserBridge: undefined, selectedFile: `${chat.id}.md`,
  setSelectedFiles: vi.fn(), selectedNote: null, setSelectedNotes: vi.fn(), pageContextCount: 0, onAddPageContext: vi.fn(),
  onQuoteNote: vi.fn(), onAddNoteToSideChat: vi.fn(),
  onClose: vi.fn(), onFloat: vi.fn(),
  onOpenChat: vi.fn(), onRevealMessage: vi.fn(), onOpenRoutine: vi.fn(), onOpenRoutines: vi.fn(),
  onDialogChange: vi.fn(), onEditGroup: vi.fn(),
  diffScope: { kind: 'session' }, onDiffScope: vi.fn(), onToggleDiff: vi.fn(), onOpenFile: vi.fn(),
  subagentPath: [], onOpenSubagent: vi.fn(),
})

it('keeps both file panels and their data across focus, with writes and Save scoped to the owner', async () => {
  const a = props(left)
  const b = props(right)
  await act(async () => { view = create(<><ChatPanelRegion {...a} /><ChatPanelRegion {...b} /></>) })
  const before = view.root.findAllByType(RepoFilesPanel)
  expect(before.map((panel) => panel.props.files)).toEqual([['left.md'], ['right.md']])
  act(() => {
    before[0]!.props.onSave('left.md', 'left edit', 'rev-a')
    before[1]!.props.onSave('right.md', 'right edit', 'rev-b')
  })
  expect(save).toHaveBeenCalledWith('project', 'left.md', 'left edit', 'rev-a', 'left')
  expect(save).toHaveBeenCalledWith('project', 'right.md', 'right edit', 'rev-b', 'right')
  act(() => view.update(<><ChatPanelRegion {...a} focused={false} /><ChatPanelRegion {...b} focused /></>))
  const after = view.root.findAllByType(RepoFilesPanel)
  expect(after[0]).toBe(before[0])
  expect(after[1]).toBe(before[1])
  expect(after.map((panel) => panel.props.shortcutsActive)).toEqual([false, true])
  expect(after.map((panel) => panel.props.selectedPath)).toEqual(['left.md', 'right.md'])
})

it('closes one panel through its own lingering animation while the other stays mounted', () => {
  const a = { ...props(left), layout: [['memory' as const]] }
  const b = props(right)
  act(() => { view = create(<><ChatPanelRegion {...a} /><ChatPanelRegion {...b} /></>) })
  const other = view.root.findByType(RepoFilesPanel)
  act(() => view.update(<><ChatPanelRegion {...a} layout={[]} /><ChatPanelRegion {...b} /></>))
  expect(view.root.findByType(ProjectMemoryPanel).props.revealed).toBe(false)
  expect(view.root.findByType(RepoFilesPanel)).toBe(other)
  act(() => { vi.advanceTimersByTime(RIGHT_PANEL_MOTION_MS) })
  expect(view.root.findAllByType(ProjectMemoryPanel)).toHaveLength(0)
  expect(view.root.findByType(RepoFilesPanel)).toBe(other)
})

it('preserves the file width while a pane moves between docking and overlay', () => {
  const a = props(left)
  act(() => { view = create(<ChatPanelRegion {...a} availableWidth={1100} />) })
  const panel = view.root.findByType(RepoFilesPanel)
  const width = panel.props.width
  expect(panel.props.overlay).toBe(false)
  expect(panel.props.compact).toBe(false)
  for (const [availableWidth, compact] of [[800, true], [584, true], [583, true], [300, true], [1100, false]] as const) {
    act(() => view.update(<ChatPanelRegion {...a} availableWidth={availableWidth} />))
    expect(view.root.findByType(RepoFilesPanel)).toBe(panel)
    expect(panel.props.width).toBe(width)
    expect(panel.props.overlay).toBe(availableWidth < width + 375)
    expect(panel.props.compact).toBe(compact)
  }
})

it('uses the chosen panel width to enter the single-column files layout', () => {
  const a = props(left)
  act(() => { view = create(<ChatPanelRegion {...a} availableWidth={1100} />) })
  const panel = view.root.findByType(RepoFilesPanel)

  act(() => panel.props.resizeProps.onKeyDown({ key: 'End', preventDefault: vi.fn() }))

  // The shared floor is the browser's phone-width page, the tightest any panel allows.
  expect(panel.props.width).toBe(399)
  expect(panel.props.compact).toBe(true)
  // At that floor the header actions still fit on one row.
  expect(panel.props.compactActions).toBe(false)
})

it('resizes an overlaying files panel against its split pane instead of the hidden chat floor', () => {
  const a = props(left)
  act(() => { view = create(<ChatPanelRegion {...a} />) })
  const panel = view.root.findByType(RepoFilesPanel)
  expect(panel.props.overlay).toBe(true)
  expect(view.root.findByProps({ 'data-chat-panel-region': '' }).props.style).toEqual({ '--region-width': '225px' })
  expect(panel.props.width).toBe(570)

  act(() => panel.props.resizeProps.onKeyDown({ key: 'ArrowLeft', preventDefault: vi.fn() }))

  expect(panel.props.width).toBe(586)
})

it('lets a panel forced over chat by pinned navigation resize back to the chat floor', () => {
  const a = { ...props(left), availableWidth: 800, overlayResizable: false }
  act(() => { view = create(<ChatPanelRegion {...a} />) })
  const panel = view.root.findByType(RepoFilesPanel)
  expect(panel.props.overlay).toBe(true)
  expect(view.root.findByProps({ 'data-chat-panel-region': '' }).props.style).toEqual({ '--region-width': '425px' })

  act(() => panel.props.resizeProps.onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn() }))

  expect(panel.props.width).toBe(425)
  expect(panel.props.overlay).toBe(false)
})

it('keeps each panel mounted in its own place while neighbours come and go', () => {
  const a = { ...props(left), availableWidth: 2_400 }
  act(() => { view = create(<ChatPanelRegion {...a} />) })
  const files = view.root.findByType(RepoFilesPanel)
  expect(files.props.resizeProps.hidden).toBeUndefined()

  // A second panel stacks under the first: the same mounted Files, now a tile.
  act(() => view.update(<ChatPanelRegion {...a} layout={[['files', 'memory']]} />))
  expect(view.root.findByType(RepoFilesPanel)).toBe(files)
  const tiles = view.root.findByProps({ 'data-panel-tiles': '' })
  expect(tiles.props.style.gridTemplateColumns).toBe('570px')
  expect(files.props.resizeProps.hidden).toBe(true)
  const memory = view.root.findByType(ProjectMemoryPanel)

  // Files closes, memory moves up into the whole column without remounting.
  act(() => view.update(<ChatPanelRegion {...a} layout={[['memory'], ['files']]} />))
  expect(view.root.findByType(ProjectMemoryPanel)).toBe(memory)
  expect(view.root.findByType(RepoFilesPanel)).toBe(files)
  // Memory now leads, so the first column wears memory's own width in this chat.
  expect(view.root.findByProps({ 'data-chat-panel-region': '' }).props.style).toEqual({ '--region-width': '1002px' })

  act(() => view.update(<ChatPanelRegion {...a} layout={[['memory']]} />))
  expect(view.root.findByType(ProjectMemoryPanel)).toBe(memory)
  expect(view.root.findAllByType(RepoFilesPanel)).toHaveLength(0)
})

it('squeezes columns to keep the chat floor, then floats them', () => {
  const a = { ...props(left), layout: [['files'], ['memory']] as ComponentProps<typeof ChatPanelRegion>['layout'] }
  act(() => { view = create(<ChatPanelRegion {...a} availableWidth={1_200} />) })
  const region = () => view.root.findByProps({ 'data-chat-panel-region': '' }).props.style
  const tiles = () => view.root.findByProps({ 'data-panel-tiles': '' }).props
  // 1200 - 375 leaves 825, shared in proportion to Files' 570 and memory's 432.
  expect(tiles().style.gridTemplateColumns).toBe('469px 355px')
  expect(region()).toEqual({ '--region-width': '824px' })
  expect(view.root.findByType(RepoFilesPanel).props.width).toBe(469)
  expect(view.root.findByType(RepoFilesPanel).props.compact).toBe(true)

  act(() => view.update(<ChatPanelRegion {...a} availableWidth={900} />))
  expect(tiles().className).toContain('dock-panel-reveal')
  expect(tiles().style.gridTemplateColumns).toBe('507px 384px')
  expect(region()).toEqual({ '--region-width': '525px' })
})

it('gives the window shortcuts to the one editor last worked in', async () => {
  const a = { ...props(left), availableWidth: 2_400, layout: [['files', 'knowledge']] as Layout }
  await act(async () => { view = create(<ChatPanelRegion {...a} />) })
  const keys = () => [
    view.root.findByType(RepoFilesPanel).props.shortcutsActive,
    view.root.findByType(KnowledgePanel).props.dock.shortcutsActive,
  ]
  const [files, knowledge] = view.root.findAll((node) => node.type === 'div' && node.props.onPointerDownCapture !== undefined)
  expect(keys()).toEqual([true, false])
  act(() => knowledge!.props.onPointerDownCapture())
  expect(keys()).toEqual([false, true])
  act(() => files!.props.onFocusCapture())
  expect(keys()).toEqual([true, false])
  act(() => view.update(<ChatPanelRegion {...a} focused={false} />))
  expect(keys()).toEqual([false, false])
})

it('gives the chat its room back without motion when a panel goes full screen', async () => {
  await act(async () => { view = create(<ChatPanelRegion {...props(left)} availableWidth={2_400} />) })
  const region = () => view.root.findByProps({ 'data-chat-panel-region': '' }).props
  expect(region().className).toContain('transition-[width]')

  act(() => view.root.findByType(RepoFilesPanel).props.onToggleExpanded())
  expect(region().style).toEqual({ '--region-width': '0px' })
  expect(region().className).not.toContain('transition')
  act(() => view.root.findByType(RepoFilesPanel).props.onToggleExpanded())
  expect(region().className).not.toContain('transition')
})

it('lets an expanded tile cover the whole stage, the desktop page stepping out beneath it', async () => {
  const a = { ...props(left), availableWidth: 900, layout: [['browser'], ['knowledge']] as Layout }
  await act(async () => { view = create(<ChatPanelRegion {...a} />) })
  const tiles = () => view.root.findByProps({ 'data-panel-tiles': '' }).props
  const knowledge = view.root.findByType(KnowledgePanel)
  expect(tiles().className).toContain('dock-panel-reveal')
  expect(view.root.findByType(BrowserPanel).props.pageVisible).toBe(true)

  act(() => knowledge.props.dock.onToggleExpanded())
  // No longer a positioned row, so the expand fills the stage rather than the row.
  expect(tiles().className).not.toContain('dock-panel-reveal')
  expect(view.root.findByType(BrowserPanel).props.pageVisible).toBe(false)
  expect(view.root.findByType(KnowledgePanel)).toBe(knowledge)
  const cellClasses = view.root.findAll((node) => node.type === 'div' && node.props.onPointerDownCapture !== undefined).map((cell) => cell.props.className)
  expect(cellClasses.map((name) => name.includes('invisible'))).toEqual([true, false])

  act(() => knowledge.props.dock.onToggleExpanded())
  expect(tiles().className).toContain('dock-panel-reveal')
  expect(view.root.findByType(BrowserPanel).props.pageVisible).toBe(true)
})

it('hands the editor shortcuts to an expanded editor, and to neither under an expanded Browser', async () => {
  const a = { ...props(left), availableWidth: 2_400, layout: [['files', 'knowledge'], ['browser']] as Layout }
  await act(async () => { view = create(<ChatPanelRegion {...a} />) })
  const keys = () => [
    view.root.findByType(RepoFilesPanel).props.shortcutsActive,
    view.root.findByType(KnowledgePanel).props.dock.shortcutsActive,
  ]
  expect(keys()).toEqual([true, false])
  // Knowledge expanded covers Files, so it holds the keys without being clicked first.
  act(() => view.root.findByType(KnowledgePanel).props.dock.onToggleExpanded())
  expect(keys()).toEqual([false, true])
  act(() => view.root.findByType(KnowledgePanel).props.dock.onToggleExpanded())
  act(() => view.root.findByType(BrowserPanel).props.onToggleExpanded())
  expect(keys()).toEqual([false, false])
  act(() => view.root.findByType(BrowserPanel).props.onToggleExpanded())
  expect(keys()).toEqual([true, false])
})

it('expands only the asking chat\'s Browser over the stage, also beside a split pane', async () => {
  await act(async () => {
    view = create(<><ChatPanelRegion {...props(left)} layout={[['browser']]} /><ChatPanelRegion {...props(right)} layout={[['browser']]} /></>)
  })
  const expanded = () => view.root.findAllByType(BrowserPanel).map((panel) => panel.props.expanded)
  expect(expanded()).toEqual([false, false])
  act(() => expandPanel('manor:files-expanded', 'left'))
  expect(expanded()).toEqual([false, false])
  act(() => expandPanel(BROWSER_EXPANDED_KEY, 'left'))
  expect(expanded()).toEqual([true, false])
})

it('resizes the columns and each column\'s split from the handles between them', async () => {
  const a = { ...props(left), availableWidth: 2_400, layout: [['files', 'memory'], ['knowledge']] as Layout }
  await act(async () => { view = create(<ChatPanelRegion {...a} />) })
  const columns = () => view.root.findByProps({ 'data-panel-tiles': '' }).props.style.gridTemplateColumns
  const handle = (label: string) => view.root.find((node) => node.type === 'div' && node.props.role === 'separator' && node.props['aria-label'] === label)
  const key = (label: string, name: string) => act(() => handle(label).props.onKeyDown({
    key: name, preventDefault: vi.fn(), currentTarget: { parentElement: { getBoundingClientRect: () => ({ height: 800 }) } },
  }))
  const heights = () => view.root.findAll((node) => node.type === 'div' && node.props.onPointerDownCapture !== undefined)
    .map((cell) => cell.props.style.height)
  expect(columns()).toBe('570px 570px')
  expect(heights()).toEqual(['calc(50% + 4px)', 'calc(50% + 4px)', undefined])

  key('Resize panel columns', 'ArrowRight')
  expect(columns()).toBe('586px 554px')
  key('Resize panels', 'ArrowLeft')
  expect(columns()).toBe('602px 554px')
  key('Resize stacked panels', 'ArrowDown')
  expect(heights()).toEqual(['calc(52% + 4px)', 'calc(48% + 4px)', undefined])

  // Reset, the second column starts again from what it holds: Knowledge's default.
  act(() => handle('Resize panel columns').props.onDoubleClick())
  expect(columns()).toBe('602px 570px')
  act(() => handle('Resize stacked panels').props.onDoubleClick())
  expect(heights()).toEqual(['calc(50% + 4px)', 'calc(50% + 4px)', undefined])
})

it('clamps a remembered split to a shorter column, draws and drags from there, and keeps the memory', async () => {
  let resized: ((entries: { contentRect: { height: number } }[]) => void) | undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: typeof resized) { resized = callback }
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => (key === 'manor:right-tiles:left' ? JSON.stringify({ second: null, splits: [0.75, 0.5] }) : null), setItem: vi.fn() },
    setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })
  const a = { ...props(left), availableWidth: 2_400, layout: [['files', 'memory'], ['knowledge']] as Layout }
  await act(async () => {
    view = create(<ChatPanelRegion {...a} />, { createNodeMock: (node) => (node.props['data-panel-tiles'] === '' ? {} : null) })
  })
  const heights = () => view.root.findAll((node) => node.type === 'div' && node.props.onPointerDownCapture !== undefined)
    .map((cell) => cell.props.style.height)
  const split = () => view.root.find((node) => node.type === 'div' && node.props.role === 'separator' && node.props['aria-label'] === 'Resize stacked panels')
  const height = (column: number) => act(() => resized?.([{ contentRect: { height: column } }]))
  expect(heights()).toEqual(['calc(75% + 4px)', 'calc(25% + 4px)', undefined])

  // 400px tall, the bottom panel keeps its 160px floor, and the handle sits on the drawn split.
  height(400)
  expect(heights()).toEqual(['calc(60% + 4px)', 'calc(40% + 4px)', undefined])
  expect(split().props.style.top).toBe('calc(60% - 4px)')
  // Room again, the remembered split comes back.
  height(1_000)
  expect(heights()).toEqual(['calc(75% + 4px)', 'calc(25% + 4px)', undefined])

  // A drag in the short column starts from what is drawn: one step up from 60%, not from 75%.
  height(400)
  act(() => split().props.onKeyDown({
    key: 'ArrowUp', preventDefault: vi.fn(), currentTarget: { parentElement: { getBoundingClientRect: () => ({ height: 400 }) } },
  }))
  expect(parseFloat(heights()[0]!.slice('calc('.length))).toBeCloseTo(56)
})
