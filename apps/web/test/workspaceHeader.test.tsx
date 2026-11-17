import type { AgentConfig, Project } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkspaceHeader } from '../src/components/WorkspaceHeader'
import { homeRoom } from '../src/state'

const smith = {
  id: 'smith',
  name: 'Smith',
  role: 'Development and architecture',
  color: '#f59e0b',
  avatar: 'https://example.com/smith.webp',
  allowedTools: [],
} as unknown as AgentConfig

describe('the workspace header', () => {
  it('renders a DM as the recipient avatar, name and inbox role badge', () => {
    const html = renderToStaticMarkup(
      <WorkspaceHeader
        title="Smith"
        persona={smith}
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
      />,
    )

    expect(html).toContain('smith.webp')
    expect(html).toContain('Smith')
    expect(html).toContain('Development and architecture')
    expect(html).toContain('bg-role-badge')
    expect(html).toContain('aria-label="Enlarge Smith avatar"')
    expect(html).toContain('cursor-zoom-in')
  })

  // A DM has no agents panel, so the face in the header is the one way to her form.
  it('makes the DM recipient a handle on her Agent settings', () => {
    const html = renderToStaticMarkup(
      <WorkspaceHeader
        title="Smith"
        persona={smith}
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
        onEditPersona={() => {}}
      />,
    )

    expect(html).toContain('aria-label="Agent settings for Smith"')
    expect(html).toContain('Development and architecture')
    // One act on one target: the zoom would need a second handle in the same 36px.
    expect(html).not.toContain('cursor-zoom-in')
  })

  it('shows only name and role for a DM, sharing the room evenly', () => {
    const html = renderToStaticMarkup(
      <WorkspaceHeader
        title="Smith"
        persona={smith}
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
      />,
    )

    expect(html).toContain('Development and architecture')
    // The composer owns the DM's runtime; the header repeats none of it.
    expect(html).not.toContain('text-meta text-dim')
    // Name and role grow evenly up to their own width: a short one is never cut, two long ones split the room.
    expect(html).toContain('auto-cols-[minmax(0,max-content)] grid-flow-col')
  })

  it('keeps an ordinary chat title unchanged', () => {
    const html = renderToStaticMarkup(
      <WorkspaceHeader
        title="Release crew"
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
      />,
    )

    expect(html).toContain('Release crew')
    expect(html).not.toContain('Development and architecture')
  })

  it('uses the sidebar control as a phone back button and keeps a trailing action', () => {
    const html = renderToStaticMarkup(
      <WorkspaceHeader
        title="Release crew"
        status="live"
        sidebarCollapsed
        phoneBack
        trailing={<button type="button">Agents</button>}
        onToggleSidebar={() => {}}
      />,
    )

    expect(html).toContain('aria-label="Back to Sessions"')
    expect(html).toContain('>Agents<')
    expect(html).not.toContain('aria-label="Show sidebar"')
  })

  it('keeps a section control directly after its title', () => {
    const html = renderToStaticMarkup(
      <WorkspaceHeader
        title="Plugins"
        section="plugins"
        accessory={<span>Connectors and Skills</span>}
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
      />,
    )

    expect(html.indexOf('>Plugins<')).toBeLessThan(html.indexOf('>Connectors and Skills<'))
    // The row already has gap-2 (8px), so ml-1 makes the total title offset 12px.
    expect(html).toContain('ml-1 flex-none')
  })

  it('draws a persona without a picture as her own blobatar', () => {
    const html = renderToStaticMarkup(
      <WorkspaceHeader
        title="Smith"
        persona={{ ...smith, avatar: undefined }}
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
      />,
    )

    // A generated face is not a picture: there is nothing to enlarge.
    expect(html).toContain('data-avatar="blobatar"')
    expect(html).not.toContain('aria-label="Enlarge Smith avatar"')
  })

  it.each([false, true])('puts the project badge after the title with sidebarCollapsed=%s', (sidebarCollapsed) => {
    const project = {
      id: 'knowledge',
      name: 'Knowledge work',
      repoPaths: ['/Users/sam/notes'],
      icon: 'brain',
      color: '#fb7185',
    } as Project
    const html = renderToStaticMarkup(
      <WorkspaceHeader
        title="New chat"
        project={project}
        status="live"
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => {}}
        onEditProject={() => {}}
      />,
    )

    expect(html).toContain('>Knowledge work<')
    expect(html).not.toContain('>notes<')
    expect(html.indexOf('>New chat<')).toBeLessThan(html.indexOf('>Knowledge work<'))
    expect(html).not.toContain('>/</span>')
    expect(html).toContain('color-mix(in srgb, #fb7185 16%, transparent)')
    expect(html).toContain('aria-label="Edit project"')
  })

  it('wears no project badge for a Session without a project', () => {
    const html = renderToStaticMarkup(
      <WorkspaceHeader title="New chat" project={homeRoom(['/notes'])} status="live" sidebarCollapsed={false} onToggleSidebar={() => {}} onEditProject={() => {}} />,
    )

    expect(html).toContain('>New chat<')
    expect(html).not.toContain('No project')
    expect(html).not.toContain('/notes')
    expect(html).not.toContain('aria-label="Edit project"')
  })
})
