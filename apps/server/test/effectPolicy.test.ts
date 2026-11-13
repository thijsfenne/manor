import type { McpServerConfig } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { browserEffect, connectorEffect, humanOnlyWrite } from '../src/effectPolicy.js'

const server = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'mcp_1',
  name: 'gmail',
  command: '/bin/true',
  args: [],
  envKeys: [],
  description: '',
  writes: true,
  effectPolicy: 'confirm_writes',
  tools: ['get_message', 'send_message'],
  readOnlyTools: ['get_message'],
  schemaChars: 0,
  ...overrides,
})

describe('connectorEffect', () => {
  it('exempts Executor documentation, but never its execution or resume gateway', () => {
    const executor = server({ name: 'executor', tools: ['skills', 'list-artifacts', 'execute', 'resume'] })
    expect(connectorEffect(executor, 'skills')).toBe('read')
    expect(connectorEffect(executor, 'list-artifacts')).toBe('read')
    expect(connectorEffect(executor, 'execute')).toBe('confirm_write')
    expect(connectorEffect(executor, 'resume', { action: 'accept' })).toBe('confirm_write')
  })
  it('lets only Manor-reviewed reads pass', () => {
    expect(connectorEffect(server(), 'get_message')).toBe('read')
    expect(connectorEffect(server(), 'send_message')).toBe('confirm_write')
    expect(connectorEffect(server(), 'new_unknown_tool')).toBe('confirm_write')
  })

  it('ignores read-only claims outside the Manor-owned exact allowlist', () => {
    expect(connectorEffect(server({ readOnlyTools: ['get_message', 'send_message'] }), 'send_message'))
      .toBe('confirm_write')
    expect(connectorEffect(server({
      name: 'unreviewed',
      tools: ['apparently_safe'],
      readOnlyTools: ['apparently_safe'],
    }), 'apparently_safe')).toBe('confirm_write')
  })

  it('lets an explicitly trusted connector write without approval', () => {
    expect(connectorEffect(server({ effectPolicy: 'trusted' }), 'send_message')).toBe('trusted_write')
  })

  it('lets reviewed Gmail reads pass and combines mixed batches by their strongest effect', () => {
    const composio = server({
      name: 'composio',
      tools: ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_MULTI_EXECUTE_TOOL', 'GMAIL_FETCH_EMAILS'],
      readOnlyTools: [],
    })
    expect(connectorEffect(composio, 'COMPOSIO_SEARCH_TOOLS')).toBe('read')
    expect(connectorEffect(composio, 'GMAIL_FETCH_EMAILS')).toBe('read')
    expect(connectorEffect(composio, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [
        { tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} },
        { tool_slug: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', arguments: {} },
      ],
    })).toBe('read')
    expect(connectorEffect(composio, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ tool_slug: 'LINEAR_CREATE_ISSUE', arguments: {} }],
    })).toBe('trusted_write')
    expect(connectorEffect(composio, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [
        { tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} },
        { tool_slug: 'LINEAR_CREATE_ISSUE', arguments: {} },
      ],
    })).toBe('trusted_write')
    expect(connectorEffect(composio, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [
        { tool_slug: 'LINEAR_CREATE_ISSUE', arguments: {} },
        { tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} },
      ],
    })).toBe('confirm_write')
  })

  it('lets Google Calendar reads pass so unattended routines can read the agenda, never its writes', () => {
    const composio = server({ name: 'composio', tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'], readOnlyTools: [] })
    const batch = (...slugs: string[]) =>
      connectorEffect(composio, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: slugs.map((tool_slug) => ({ tool_slug })) })
    expect(batch('GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_LIST_CALENDARS')).toBe('read')
    expect(batch('GOOGLECALENDAR_CREATE_EVENT')).toBe('confirm_write')
    expect(batch('GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_DELETE_EVENT')).toBe('confirm_write')
  })

  it('keeps Gmail sends, mutations and merely read-sounding unknowns behind approval', () => {
    const composio = server({
      name: 'composio',
      tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'],
      readOnlyTools: [],
    })
    for (const tool_slug of ['GMAIL_SEND_EMAIL', 'GMAIL_ADD_LABEL_TO_EMAIL', 'GMAIL_GET_OR_CREATE_LABEL']) {
      expect(connectorEffect(composio, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
        tools: [{ tool_slug, arguments: {} }],
      })).toBe('confirm_write')
    }
  })

  it('fails closed for malformed, empty and unprobed Composio actions', () => {
    const composio = server({
      name: 'composio',
      tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'],
      readOnlyTools: [],
    })
    expect(connectorEffect(composio, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [] })).toBe('confirm_write')
    expect(connectorEffect(composio, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ tool_slug: 'LINEAR_CREATE_ISSUE' }, {}],
    })).toBe('confirm_write')
    expect(connectorEffect(composio, 'LINEAR_CREATE_ISSUE')).toBe('confirm_write')
  })
})

describe('browserEffect', () => {
  it('guards page interaction and leaves observation alone', () => {
    expect(browserEffect('browser_snapshot')).toBe('read')
    expect(browserEffect('browser_type')).toBe('confirm_write')
    expect(browserEffect('browser_click')).toBe('confirm_write')
  })
  it('lets iCloud calendar reads pass and keeps create_event behind a human even on a trusted row', () => {
    const calendar = server({
      name: 'icloud-calendar',
      effectPolicy: 'trusted',
      tools: ['list_calendars', 'list_events', 'find_free_time', 'create_event'],
    })
    expect(connectorEffect(calendar, 'list_events')).toBe('read')
    expect(connectorEffect(calendar, 'find_free_time')).toBe('read')
    expect(connectorEffect(calendar, 'create_event')).toBe('confirm_write')
  })
  it('lets Apple Reminders reads and create pass, and keeps complete and delete behind a human on any row', () => {
    const tools = ['list_reminder_lists', 'list_reminders', 'create_reminder', 'complete_reminder', 'delete_reminder']
    for (const effectPolicy of ['confirm_writes', 'trusted'] as const) {
      const reminders = server({ name: 'apple-reminders', effectPolicy, tools })
      expect(connectorEffect(reminders, 'list_reminders')).toBe('read')
      expect(connectorEffect(reminders, 'create_reminder')).toBe('trusted_write')
      expect(humanOnlyWrite('apple-reminders', 'create_reminder')).toBe(false)
      for (const tool of ['complete_reminder', 'delete_reminder']) {
        expect(connectorEffect(reminders, tool)).toBe('confirm_write')
        expect(humanOnlyWrite('apple-reminders', tool)).toBe(true)
      }
    }
    // Only a probed tool of the real connector is exempt, and an unprobed one never falls back to row trust.
    for (const effectPolicy of ['confirm_writes', 'trusted'] as const) {
      expect(connectorEffect(server({ name: 'apple-reminders', effectPolicy, tools: ['list_reminders'] }), 'create_reminder'))
        .toBe('confirm_write')
    }
    expect(connectorEffect(server({ tools: ['create_reminder'] }), 'create_reminder')).toBe('confirm_write')
  })
})
