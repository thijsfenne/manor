import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, Project } from '@manor/contracts'

// The bar's groups are portal targets; inline here, so a header can be read where it lands.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: ReactNode) => node,
}))

const { TopBar, TopBarSlotContext } = await import('../src/components/TopBar')
const { WorkspaceHeader } = await import('../src/components/WorkspaceHeader')
const { Transcript } = await import('../src/components/Transcript')

const bar = (patch: Partial<Parameters<typeof TopBar>[0]> = {}) => (
  <TopBar
    leadWidth={46 + 288}
    railWidth={46}
    animate
    split={null}
    status="live"
    covered={false}
    sidebar={{ collapsed: false, onToggle: () => {} }}
    history={{ canBack: true, canForward: false, onBack: () => {}, onForward: () => {} }}
    onSearch={() => {}}
    slotRefs={{ left: () => {}, right: () => {} }}
    {...patch}
  />
)

const slot = (html: string, side: 'left' | 'right') => {
  const start = html.indexOf(`data-top-bar-slot="${side}"`)
  if (start === -1) return null
  const next = html.indexOf('data-top-bar-slot=', start + 1)
  return html.slice(start, next === -1 ? undefined : next)
}

const project = { id: 'manor', name: 'Manor', repoPaths: [], icon: 'home', color: '#4fc3e8' } as unknown as Project
const iris = { id: 'iris', name: 'Iris', role: 'Design critic', color: '#c084fc', allowedTools: [] } as unknown as AgentConfig

describe('the top bar groups', () => {
  it('lays one group over the whole stage outside a split', () => {
    const html = renderToStaticMarkup(bar({ status: 'offline' }))

    expect(slot(html, 'left')).toContain('flex:1 1 0%')
    expect(slot(html, 'right')).toBeNull()
    // The connection is app-wide, so it sits in the only group, before its controls.
    expect(slot(html, 'left')).toContain('>Offline<')
  })

  it('gives each split pane a group on the pane\'s own basis, with the line on the border', () => {
    const html = renderToStaticMarkup(bar({ split: { ratio: 0.6, animate: true }, status: 'connecting' }))
    const left = slot(html, 'left')
    const right = slot(html, 'right')

    expect(left).toContain('flex:0 1 60%')
    expect(right).toContain('flex:0 1 40%')
    // The divider is the right group's own left edge, which is where the pane border is.
    expect(right).toContain('before:left-0')
    expect(right).toContain('before:w-px')
    // One connection state for the window, in the last group only.
    expect(left).not.toContain('Connecting…')
    expect(right).toContain('>Connecting…<')
  })

  it('eases the groups only between two ratios, never as a split opens or while it is dragged', () => {
    const rightClass = (renderer: ReactTestRenderer) => String(renderer.root.findByProps({ 'data-top-bar-slot': 'right' }).props.className)
    // The panes mount at their final basis, so the doors must not travel as the split appears.
    const opening = renderToStaticMarkup(bar({ split: { ratio: 0.6, animate: true } }))
    expect(slot(opening, 'left')).not.toContain('flex-basis_280ms')
    expect(slot(opening, 'right')).not.toContain('flex-basis_280ms')

    let renderer!: ReactTestRenderer
    act(() => { renderer = create(bar({ split: { ratio: 0.6, animate: true } })) })
    act(() => { renderer.update(bar({ split: { ratio: 0.5, animate: true } })) })
    // Once open, the bar follows a ratio change on the same curve as the panes.
    expect(rightClass(renderer)).toContain('flex-basis_280ms_var(--ease-arrive)')

    act(() => { renderer.update(bar({ split: { ratio: 0.5, animate: false } })) })
    expect(rightClass(renderer)).not.toContain('flex-basis_280ms')
    act(() => renderer.unmount())
  })

  it('drops what acts on the stage while Settings covers it', () => {
    const html = renderToStaticMarkup(bar({ covered: true }))

    expect(html.match(/inert=""/g)).toHaveLength(2)
    expect(html).toContain('invisible')
  })

  it('puts a pane header in its own group, muted while that pane is not focused', () => {
    const header = (focused: boolean) => renderToStaticMarkup(
      <TopBarSlotContext.Provider value={{ element: {} as HTMLElement, focused }}>
        <WorkspaceHeader
          title="Vector logos"
          project={project}
          status="live"
          sidebarCollapsed={false}
          onEditProject={() => {}}
          trailing={<button type="button" aria-label="Close pane" />}
        />
      </TopBarSlotContext.Provider>,
    )

    const focused = header(true)
    // No header of its own in the pane: the bar is the only header.
    expect(focused).not.toContain('<header')
    expect(focused).toContain('aria-label="Edit project"')
    expect(focused.indexOf('>Vector logos<')).toBeLessThan(focused.indexOf('>Manor<'))
    expect(focused.indexOf('>Vector logos<')).toBeLessThan(focused.indexOf('aria-label="Close pane"'))
    expect(focused).toMatch(/text-text">Vector logos</)
    expect(header(false)).toMatch(/text-muted">Vector logos</)
  })

  it('clears the first message only under a header kept in its pane', () => {
    const column = (slot: { element: HTMLElement; focused: boolean } | null) => renderToStaticMarkup(
      <TopBarSlotContext.Provider value={slot}>
        <Transcript rows={[]} agents={[]} skills={[]} hasSnapshot />
      </TopBarSlotContext.Provider>,
    )

    // In the bar, the header sits above the pane and the thread starts near its top.
    expect(column({ element: {} as HTMLElement, focused: true })).toContain(' pt-8 ')
    expect(column({ element: {} as HTMLElement, focused: true })).not.toContain('pt-[76px]')
    // The phone and the Browser session column float theirs over the thread.
    expect(column(null)).toContain('pt-[76px]')
  })

  it('draws a DM without a project as one 20px persona button and no slash', () => {
    const html = renderToStaticMarkup(
      <TopBarSlotContext.Provider value={{ element: {} as HTMLElement, focused: true }}>
        <WorkspaceHeader title="Iris" persona={iris} status="live" sidebarCollapsed={false} onEditPersona={() => {}} />
      </TopBarSlotContext.Provider>,
    )

    expect(html).toContain('aria-label="Edit Iris"')
    expect(html).toContain('Design critic')
    expect(html).toContain('width:20px')
    expect(html).not.toContain('>/<')
  })
})

describe('the lead controls and full screen', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = undefined
    vi.unstubAllGlobals()
  })

  const lead = (root: ReactTestInstance) =>
    root.find((node) => typeof node.type === 'string' && node.props['data-lead-controls'] !== undefined)
  const firstGroup = (root: ReactTestInstance) =>
    root.find((node) => typeof node.type === 'string' && node.props['data-top-bar-slot'] === 'left')
  const leadLine = (root: ReactTestInstance) =>
    root.find((node) => typeof node.type === 'string' && node.props['data-lead-line'] !== undefined)
  const spacerWidth = (root: ReactTestInstance) =>
    root.findAll((node) => node.type === 'div' && node.props['aria-hidden'] === 'true')[0]?.props.style.width

  it('sits after the traffic lights in a window and moves over the rail in full screen', () => {
    let report: (fullscreen: boolean) => void = () => {}
    vi.stubGlobal('window', {
      manorDesktop: {
        platform: 'darwin',
        onFullscreen: (listener: (fullscreen: boolean) => void) => {
          report = listener
          return () => {}
        },
      },
    })
    act(() => {
      renderer = create(bar({ sidebar: { collapsed: true, onToggle: () => {} }, leadWidth: 46 }))
    })
    const root = renderer!.root

    expect(lead(root).props['data-lead-controls']).toBe('lights')
    expect(root.findAll((node) => node.props['data-traffic-lights'] !== undefined)).toHaveLength(1)
    // A folded sidebar: the breadcrumb sits close after the lights and the four
    // controls, with the hairline between them.
    expect(firstGroup(root).props.style.paddingLeft).toContain('calc(calc(84px / var(--desktop-zoom, 1)) + 128px) + 12px - 46px')
    expect(leadLine(root).props.style.left).toContain('calc(calc(84px / var(--desktop-zoom, 1)) + 128px) + 2px - 46px')

    act(() => report(true))
    expect(lead(root).props['data-lead-controls']).toBe('bare')
    expect(root.findAll((node) => node.props['data-traffic-lights'] !== undefined)).toHaveLength(0)
    // The first control centres on the 46px rail, and the breadcrumb follows it there.
    expect(lead(root).props.style.paddingLeft).toBe(7)
    expect(firstGroup(root).props.style.paddingLeft).toContain('calc(135px + 12px - 46px)')
    expect(leadLine(root).props.style.left).toContain('calc(135px + 2px - 46px)')

    act(() => report(false))
    expect(lead(root).props['data-lead-controls']).toBe('lights')
  })

  it('leaves the stage edge where it was when full screen changes', () => {
    let report: (fullscreen: boolean) => void = () => {}
    vi.stubGlobal('window', {
      manorDesktop: { platform: 'darwin', onFullscreen: (listener: (fullscreen: boolean) => void) => { report = listener; return () => {} } },
    })
    act(() => {
      renderer = create(bar())
    })
    const root = renderer!.root
    const before = { lead: spacerWidth(root), inset: firstGroup(root).props.style.paddingLeft }
    act(() => report(true))

    expect(spacerWidth(root)).toBe(46 + 288)
    expect(spacerWidth(root)).toBe(before.lead)
    // With the sidebar pinned the controls never reach the stage, so the inset is its floor
    // and the hairline stands on the sidebar's seam.
    expect(before.inset).toMatch(/^max\(16px, /)
    expect(firstGroup(root).props.style.paddingLeft).toMatch(/^max\(16px, /)
    expect(leadLine(root).props.style.left).toMatch(/^max\(0px, .* - 334px\)\)$/)
    // Hidden where no page header has landed in the group.
    expect(leadLine(root).props.className).toContain('peer-empty:hidden')
  })

  it('uses the full-screen arrangement in a plain browser tab', () => {
    act(() => {
      renderer = create(bar())
    })

    expect(lead(renderer!.root).props['data-lead-controls']).toBe('bare')
  })

  it('keeps the sidebar handle in place but inert where the page has no sidebar', () => {
    act(() => {
      renderer = create(bar({ sidebar: { collapsed: true } }))
    })
    const toggle = renderer!.root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Show sidebar')

    expect(toggle.props.disabled).toBe(true)
    expect(toggle.props.title).toBe('This page has no sidebar')
  })
})
