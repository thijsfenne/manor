import type { McpHostStatus, McpServerConfig } from '@manor/contracts'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { McpServerDialog } from '../src/components/agents/McpServerDialog'
import { serverDraftOf } from '../src/components/agents/useMcpDialog'

vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }))
vi.mock('../src/components/Modal', () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}))

const server: McpServerConfig = {
  id: 'mcp_gmail',
  name: 'gmail',
  command: 'npx',
  args: ['-y', '@shinzolabs/gmail-mcp'],
  envKeys: ['CLIENT_ID', 'REFRESH_TOKEN'],
  description: 'Read emails and draft concepts',
  writes: true,
  effectPolicy: 'confirm_writes',
  tools: Array.from({ length: 64 }, (_, index) => `tool_${index + 1}`),
  readOnlyTools: [],
  schemaChars: 31_429,
}

const hostStatus: McpHostStatus = {
  serverId: server.id,
  env: [
    { key: 'CLIENT_ID', present: true },
    { key: 'REFRESH_TOKEN', present: false },
  ],
  check: {
    checkedAt: '2026-08-14T08:30:00.000Z',
    result: 'verified',
    tool: 'get_profile',
  },
}

const render = () =>
  renderToStaticMarkup(
    <McpServerDialog
      initial={serverDraftOf(server)}
      saved={server}
      holders={['Sage', 'Smith']}
      hostStatus={hostStatus}
      notice={null}
      pending={null}
      onSave={() => true}
      onVerify={() => true}
      onDelete={() => true}
      onDismissNotice={() => undefined}
      onClose={() => undefined}
    />,
  )

describe('McpServerDialog', () => {
  it('leads with cost and keeps the wall of tool names collapsed', () => {
    const html = render()
    expect(html.indexOf('64 tools')).toBeLessThan(html.indexOf('Name'))
    // No provider loads schemas up front, so the per-turn figure is the listed names
    // and the full schema size is only the ceiling once they are fetched.
    expect(html).toContain('about 640 tokens per turn as listed names (none on Codex), up to 13.2k once every schema is loaded')
    expect(html).toContain('attached to Sage, Smith')
    expect(html).toContain('<details')
    expect(html).toContain('Show tool names')
  })

  it('renders env names as separate rows with machine status, never as a value-shaped field', () => {
    const html = render()
    expect(html).toContain('value="CLIENT_ID"')
    expect(html).toContain('found on this machine')
    expect(html).toContain('value="REFRESH_TOKEN"')
    expect(html).toContain('not set')
    expect(html).not.toContain('Variable NAMES, not values')
  })

  it('shows a real verification action and names the tool that proved it', () => {
    const html = render()
    expect(html).toContain('Test connection')
    expect(html).toContain('get_profile')
    expect(html).toContain('Last verified')
  })

  it('makes connector trust explicit and keeps outward connectors guarded', () => {
    const html = render()
    expect(html).toContain('Trust this connector’s writes')
    expect(html).toContain('Leave this off for mail')
    expect(serverDraftOf(server).effectPolicy).toBe('confirm_writes')
  })

  it('offers a URL field for HTTP servers', () => {
    const html = renderToStaticMarkup(
      <McpServerDialog
        initial={serverDraftOf({ ...server, command: '', url: 'http://127.0.0.1:3845/mcp' })}
        saved={{ ...server, command: '', url: 'http://127.0.0.1:3845/mcp' }}
        hostStatus={{ serverId: server.id, env: [], check: null }}
        notice={null}
        pending={null}
        onSave={() => true}
        onVerify={() => true}
        onDelete={() => true}
        onDismissNotice={() => undefined}
        onClose={() => undefined}
      />,
    )
    expect(html).toContain('http://127.0.0.1:3845/mcp')
    expect(html).toContain('Streamable HTTP endpoint')
  })

  it.each([true, false])('adopts the fresh session URL after verification (initially unavailable: %s)', (unavailable) => {
    const stale = {
      ...server,
      command: '',
      url: 'https://backend.composio.dev/tool_router/trs_stale/mcp',
      unavailable: unavailable ? 'Composio could not connect. Try reconnecting.' : undefined,
    }
    const onSave = vi.fn(() => true)
    const props = {
      initial: serverDraftOf(stale),
      saved: stale,
      hostStatus: { serverId: stale.id, env: [], check: null } satisfies McpHostStatus,
      notice: null,
      pending: null,
      onSave,
      onVerify: () => true,
      onDelete: () => true,
      onDismissNotice: () => undefined,
      onClose: () => undefined,
    } as const

    let tree!: ReturnType<typeof create>
    act(() => { tree = create(<McpServerDialog {...props} />) })
    const button = (label: string) => tree.root.findAllByType('button').find((node) => node.children.includes(label))!
    expect(button(unavailable ? 'Reconnect' : 'Test connection').props.disabled).toBe(false)
    expect(button('Save').props.disabled).toBe(unavailable)
    const description = tree.root.findAllByType('input').find((node) => node.props.value === stale.description)!
    act(() => description.props.onChange({ target: { value: 'Edited while testing' } }))
    act(() => button(unavailable ? 'Reconnect' : 'Test connection').props.onClick())

    const recovered = { ...stale, url: 'https://backend.composio.dev/tool_router/trs_fresh/mcp', unavailable: undefined }
    act(() => tree.update(<McpServerDialog {...props} saved={recovered} />))
    expect(button('Save').props.disabled).toBe(false)
    act(() => button('Save').props.onClick())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Edited while testing',
      url: recovered.url,
    }))
    act(() => tree.unmount())
  })

  it('keeps the ordinary test label for an available connector', () => {
    const html = renderToStaticMarkup(
      <McpServerDialog
        initial={serverDraftOf(server)}
        saved={server}
        hostStatus={hostStatus}
        notice={null}
        pending="verify"
        onSave={() => true}
        onVerify={() => true}
        onDelete={() => true}
        onDismissNotice={() => undefined}
        onClose={() => undefined}
      />,
    )
    expect(html).toContain('Testing…')
    expect(html).not.toContain('Reconnecting…')
  })
})
