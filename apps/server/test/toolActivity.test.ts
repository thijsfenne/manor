import { describe, expect, it } from 'vitest'
import { ToolUseEventSchema, ToolResultEventSchema, type RuntimeEvent, type ThreadEvent } from '@manor/contracts'
import { StreamParser } from '../src/drivers/claudeDriver.js'
import { CodexStreamParser } from '../src/drivers/codexDriver.js'
import { CursorStreamParser } from '../src/drivers/cursorDriver.js'
import { SUBAGENT_TEXT_MAX } from '@manor/contracts'
import { describeTool, describeMcpTool, errorLine, errorText, redactToolActivity, subagentOutput } from '../src/drivers/toolActivity.js'
import { describeCommand } from '../src/drivers/commands.js'
import { createTurnStream } from '../src/turnStream.js'
import { smith } from './helpers.js'
import { emptyThread, rowsOf } from '@manor/client-runtime/state'
import { currentLabel, settledLabel, workSummary } from '@manor/client-runtime/turn-labels'

const label = (activity: ReturnType<typeof describeTool>) => settledLabel({
  kind: 'tool', key: 'call', status: 'done', startedAt: 1, ...activity,
})

const notification = (method: string, item: object) => JSON.stringify({ method, params: { item } })

const mcpFrames = (server: string, tool: string, args: object) => [
  {
    provider: 'Claude',
    parser: new StreamParser(),
    frame: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: `mcp__${server}__${tool}`, input: args }] } },
  },
  {
    provider: 'Grok gateway',
    parser: new StreamParser(false),
    frame: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'use_tool', input: { tool_name: `${server}__${tool}`, tool_input: args } }] } },
  },
  {
    provider: 'Codex',
    parser: new CodexStreamParser(),
    frame: { method: 'item/started', params: { item: { type: 'mcpToolCall', id: 'call', server, tool, arguments: args } } },
  },
  {
    provider: 'Cursor',
    parser: new CursorStreamParser('test'),
    // McpArgs in the installed Cursor CLI uses protobuf JSON scalar values.
    frame: { type: 'tool_call', subtype: 'started', call_id: 'call', tool_call: { mcpToolCall: { args: { serverIdentifier: server, toolName: tool, args } } } },
  },
]

describe('provider tool subjects', () => {
  it.each(mcpFrames('skills', 'read_skill', { skillId: 'code-review', path: 'references/standards.md' }))(
    '$provider preserves skill identity through the wire and shared transcript', async ({ parser, frame }) => {
      const events = parser.handle(JSON.stringify(frame))
      const use = events.find((event) => event.type === 'tool_use')!
      expect(use).toMatchObject({ tool: 'mcp__skills__read_skill', subject: 'skill code-review / references/standards.md' })
      const persisted: ThreadEvent[] = []
      const stream = createTurnStream({
        chatId: 'chat', turnId: 'turn', agent: smith, liveMessages: new Map(), emit: () => {},
        append: async (draft) => {
          const event = { ...draft, id: `event-${persisted.length}`, ts: persisted.length + 1 }
          if (event.type === 'tool_use') persisted.push(ToolUseEventSchema.parse(event))
          else if (event.type === 'tool_result') persisted.push(ToolResultEventSchema.parse(event))
        },
      })
      await stream.consume({
        events: (async function* () {
          yield use
          yield { type: 'tool_result', toolCallId: 'call', outcome: 'error' } satisfies RuntimeEvent
          yield { type: 'result', text: '' } satisfies RuntimeEvent
        })(),
        stop() {},
      }, 'test')
      const turn = rowsOf({ ...emptyThread, events: persisted }).find((row) => row.kind === 'turn')!
      expect(turn.kind).toBe('turn')
      if (turn.kind !== 'turn') throw new Error('missing turn')
      const step = turn.activities.find((activity) => activity.kind === 'tool')!
      expect(step.kind).toBe('tool')
      if (step.kind !== 'tool') throw new Error('missing step')
      expect(step.status).toBe('error')
      expect(currentLabel(step)).toBe('Reading skill code-review / references/standards.md')
      expect(settledLabel(step)).toBe('Read skill code-review / references/standards.md')
      expect(workSummary([step]).label).toBe('Tool had an issue')
    },
  )

  it.each(mcpFrames('browser', 'browser_navigate', { url: 'https://user:password@example.com/docs?token=secret#part' }))(
    '$provider uses the same browser destination without URL credentials', ({ parser, frame }) => {
      const use = parser.handle(JSON.stringify(frame)).find((event) => event.type === 'tool_use')!
      expect(use.type).toBe('tool_use')
      if (use.type !== 'tool_use') throw new Error('missing tool')
      expect(label(use)).toBe('Opened example.com/docs')
      expect(JSON.stringify(use)).not.toMatch(/password|secret|token|#part/)
    },
  )

  it('keeps native and shell search subjects equivalent without losing targets', () => {
    const input = { pattern: 'read_skill', path: 'apps/server' }
    for (const activity of [describeTool('Grep', input), describeTool('Search', input), describeTool('grep_search', input), describeCommand('rg read_skill apps/server')]) {
      expect(label(activity)).toBe('Searched for “read_skill” in apps/server')
      expect(activity.targets).toEqual(['apps/server'])
    }
  })

  it('names what a scheduled task is and when, for every driver shape', () => {
    const input = { name: 'Tea', runAt: '2026-09-28T10:00', action: 'remind' }
    const expected = { tool: 'mcp__routines__routine_save', subject: '“Tea”, 2026-09-28 10:00' }
    expect(describeTool('mcp__routines__routine_save', input)).toEqual(expected)
    expect(describeMcpTool('routines', 'routine_save', input)).toEqual(expected)
    expect(describeTool('mcp__routines__routine_save', { routineId: 'r1', enabled: false })).toEqual({ tool: 'mcp__routines__routine_save' })
    // A paused task given a new moment without `enabled` stays paused; the subject still names the moment.
    expect(describeTool('mcp__routines__routine_save', { routineId: 'r1', runAt: '2026-09-29T08:00' }))
      .toEqual({ tool: 'mcp__routines__routine_save', subject: '2026-09-29 08:00' })
  })

  it.each(['Read', 'read_file'])('keeps %s paths and line ranges without treating skill offsets as lines', (tool) => {
    const path = `/workspace/${'folder/'.repeat(25)}notes.md`
    const read = describeTool(tool, { path, offset: 40, limit: 51 })
    expect(read.targets).toEqual([path])
    expect(label(read)).toBe('Read notes.md, lines 40–90')
    expect(label(describeTool('Read', { path: '/skills/pdf/SKILL.md', offset: 1, limit: 4 }))).toBe('Read pdf/SKILL.md, lines 1–4')
    expect(label(describeTool('skills__read_skill', { skillId: 'pdf', path: 'SKILL.md', offset: 40 }))).toBe('Read skill pdf / SKILL.md')
  })

  it('labels a delegated task with its brief instead of the tool name', () => {
    expect(label(describeTool('Task', { description: 'Find reportBackNudge', prompt: 'Search turnRunner' }))).toBe('Find reportBackNudge')
    expect(label(describeTool('spawn_subagent', { prompt: 'Check the lease path' }))).toBe('Check the lease path')
    expect(label(describeTool('Agent', { task: 'Review the fold rules' }))).toBe('Review the fold rules')
    expect(label(describeTool('Task', {}))).toBe('Used Task')
    expect(new CursorStreamParser('test').handle(JSON.stringify({
      type: 'tool_call', subtype: 'started', call_id: 'call',
      tool_call: { taskToolCall: { args: { description: 'Find reportBackNudge', prompt: 'Search turnRunner' } } },
    })).find((event) => event.type === 'tool_use')).toMatchObject({
      tool: 'Task', subject: 'Find reportBackNudge',
    })
  })

  it('keeps a subagent brief and only the model its launch named', () => {
    expect(describeTool('Agent', { description: 'Review the fold', prompt: 'Read turnTrace.ts. Then report.', model: 'sonnet' }).subagent)
      .toEqual({ title: 'Review the fold', prompt: 'Read turnTrace.ts. Then report.', model: 'sonnet' })
    expect(describeTool('spawn_subagent', { prompt: '# Check the lease path. Then stop.\nMore', model: 'inherit' }).subagent)
      .toEqual({ title: 'Check the lease path.', prompt: '# Check the lease path. Then stop.\nMore' })
    expect(describeTool('Agent', { prompt: '  Keep my indent.\n' }).subagent?.prompt).toBe('  Keep my indent.\n')
    expect(describeTool('Agent', { prompt: 'x'.repeat(SUBAGENT_TEXT_MAX + 1) }).subagent?.prompt).toHaveLength(SUBAGENT_TEXT_MAX + 1)
    expect(subagentOutput([{ type: 'text', text: 'Async agent launched successfully.' }])).toBeUndefined()
    expect(redactToolActivity({ tool: 'Agent', subagent: { title: 'secret', prompt: 'secret', model: 'secret', effort: 'secret' }, output: 'secret' }, (value) => value.replaceAll('secret', '[redacted]')))
      .toEqual({ tool: 'Agent', subagent: { title: '[redacted]', prompt: '[redacted]', model: '[redacted]', effort: '[redacted]' }, output: '[redacted]' })
  })

  it('does not leak arbitrary inputs or invent missing subjects', () => {
    expect(describeMcpTool('unknown', 'call', { token: 'secret', body: 'private' })).toEqual({ tool: 'mcp__unknown__call' })
    expect(label(describeMcpTool('skills', 'read_skill', {}))).toBe('Read skill')
    expect(label(describeTool('mcp__browser__browser_type', { text: 'secret', selector: '#password' }))).toBe('Entered text')
    expect(label(describeTool('WebFetch', { url: 'https://example.com/docs?token=secret' }))).toBe('Read example.com/docs')
    expect(describeTool('WebFetch', { url: 'file:///private' })).toEqual({ tool: 'WebFetch' })
    expect(redactToolActivity({ tool: 'Search', subject: 'secret', detail: 'secret' }, (value) => value.replaceAll('secret', '[redacted]'))).toEqual({ tool: 'Search', subject: '[redacted]', detail: '[redacted]' })
    expect(redactToolActivity(describeTool('WebSearch', { query: 'x'.repeat(1000) }), (value) => value).subject?.length).toBeLessThanOrEqual(500)
  })

  it('redacts command, targets and both edit sides before a tool event leaves the driver', () => {
    const activity = {
      tool: 'Shell', detail: 'secret', subject: 'secret', command: 'run secret',
      targets: ['/tmp/secret'], edits: [{ path: '/tmp/secret', before: 'old secret', after: 'new secret' }],
    }
    expect(redactToolActivity(activity, (value) => value.replaceAll('secret', '[redacted]'))).toEqual({
      tool: 'Shell', detail: '[redacted]', subject: '[redacted]', command: 'run [redacted]',
      targets: ['/tmp/[redacted]'], edits: [{ path: '/tmp/[redacted]', before: 'old [redacted]', after: 'new [redacted]' }],
    })
  })

  it('keeps a missing-start MCP completion useful and preserves its failure', () => {
    const parser = new CodexStreamParser()
    const events = parser.handle(notification('item/completed', { type: 'mcpToolCall', id: 'call', server: 'skills', tool: 'read_skill', arguments: { skillId: 'pdf', path: 'SKILL.md' }, status: 'failed', error: { message: 'unavailable' } }))
    expect(events).toEqual([
      { type: 'tool_use', toolCallId: 'call', tool: 'mcp__skills__read_skill', subject: 'skill pdf / SKILL.md' },
      { type: 'tool_result', toolCallId: 'call', outcome: 'error', tool: 'mcp__skills__read_skill', subject: 'skill pdf / SKILL.md', error: 'unavailable' },
    ])
  })

  it.each(['completed', 'failed'])('enriches one MCP row when arguments arrive late, including %s calls', (status) => {
    const parser = new CodexStreamParser()
    const item = { type: 'mcpToolCall', id: 'call', server: 'skills', tool: 'read_skill' }
    const started = parser.handle(notification('item/started', item))
    const completed = parser.handle(notification('item/completed', {
      ...item, status, error: status === 'failed' ? { message: 'unavailable' } : null,
      arguments: { skillId: 'pdf', path: 'SKILL.md' },
    }))
    expect(started).toEqual([{ type: 'tool_use', toolCallId: 'call', tool: 'mcp__skills__read_skill', subject: 'skill' }])
    expect(completed).toEqual([{
      type: 'tool_result', toolCallId: 'call', outcome: status === 'failed' ? 'error' : 'success',
      tool: 'mcp__skills__read_skill', subject: 'skill pdf / SKILL.md',
      ...(status === 'failed' ? { error: 'unavailable' } : {}),
    }])
    const events = [...started, ...completed].map((event, index) => {
      const envelope = { ...event, id: String(index), ts: index, agentId: 'smith', turnId: 'turn' }
      return event.type === 'tool_use' ? ToolUseEventSchema.parse(envelope) : ToolResultEventSchema.parse(envelope)
    })
    const turn = rowsOf({ ...emptyThread, events }).find((row) => row.kind === 'turn')!
    if (turn.kind !== 'turn') throw new Error('missing turn')
    expect(turn.activities).toHaveLength(1)
    expect(workSummary(turn.activities).label).toBe(status === 'failed' ? 'Tool had an issue' : 'Read skill pdf / SKILL.md')
  })

  it('does not replace an existing MCP subject when completion omits arguments', () => {
    const parser = new CodexStreamParser()
    const item = { type: 'mcpToolCall', id: 'call', server: 'skills', tool: 'read_skill' }
    parser.handle(notification('item/started', { ...item, arguments: { skillId: 'pdf', path: 'SKILL.md' } }))
    expect(parser.handle(notification('item/completed', { ...item, status: 'completed', error: null }))).toEqual([
      { type: 'tool_result', toolCallId: 'call', outcome: 'success', tool: 'mcp__skills__read_skill' },
    ])
  })

  it('shows Codex web searches live and enriches the same row at completion', () => {
    const parser = new CodexStreamParser()
    const started = parser.handle(notification('item/started', { type: 'webSearch', id: 'web' }))
    const completed = parser.handle(notification('item/completed', { type: 'webSearch', id: 'web', query: 'release notes' }))
    expect(started).toEqual([{ type: 'tool_use', toolCallId: 'web', tool: 'WebSearch' }])
    expect(completed).toEqual([{ type: 'tool_result', toolCallId: 'web', tool: 'WebSearch', outcome: 'success', subject: 'web for “release notes”' }])
    const events = [...started, ...completed].map((event, index) => {
      const envelope = { ...event, id: String(index), ts: index, agentId: 'smith', turnId: 'turn' }
      return event.type === 'tool_use' ? ToolUseEventSchema.parse(envelope) : ToolResultEventSchema.parse(envelope)
    })
    const turn = rowsOf({ ...emptyThread, events }).find((row) => row.kind === 'turn')!
    if (turn.kind !== 'turn') throw new Error('missing turn')
    expect(turn.activities).toHaveLength(1)
    expect(workSummary(turn.activities).label).toBe('Searched web for “release notes”')
  })

  it('distinguishes Codex page reads and find actions from web queries', () => {
    const parser = new CodexStreamParser()
    parser.handle(notification('item/started', { type: 'webSearch', id: 'web', query: '' }))
    expect(parser.handle(notification('item/completed', {
      type: 'webSearch', id: 'web', query: '', action: { type: 'openPage', url: 'https://example.com/docs?token=secret' },
    }))).toEqual([{ type: 'tool_result', toolCallId: 'web', tool: 'WebFetch', outcome: 'success', subject: 'example.com/docs' }])
    expect(label(describeTool('WebSearch', { action: { type: 'findInPage', pattern: 'release', url: 'https://example.com/docs' } }))).toBe('Searched for “release” in https://example.com/docs')
  })

  it('does not label a mixed daily-log read and command as a memory write', () => {
    expect(label(describeCommand('cat memory/daily/today.md && pnpm test'))).toBe('Read a file and ran tests')
  })

  it('keeps old calls and concurrent personas with the same provider call id separate', () => {
    const calls = ['smith', 'sage'].map((agentId, ts) => ToolUseEventSchema.parse({
      type: 'tool_use', id: agentId, ts, agentId, turnId: agentId, toolCallId: 'call', tool: 'Read',
      ...(agentId === 'smith' ? { subject: 'notes.md, lines 1–5' } : { targets: ['legacy.md'] }),
    }))
    const result = ToolResultEventSchema.parse({ type: 'tool_result', id: 'result', ts: 3, agentId: 'smith', turnId: 'smith', toolCallId: 'call', outcome: 'error', subject: 'notes.md, lines 2–6' })
    const turns = rowsOf({ ...emptyThread, events: [...calls, result] }).filter((row) => row.kind === 'turn')
    const steps = turns.flatMap((turn) => turn.activities.filter((activity) => activity.kind === 'tool'))
    expect(steps.map(settledLabel)).toEqual(['Read notes.md, lines 2–6', 'Read legacy.md'])
    expect(steps.map((step) => step.status)).toEqual(['error', 'done'])
  })
})

describe('failed tool error excerpt', () => {
  const redactSecret = (value: string) => value.replaceAll('secret', '[redacted]')

  const line = (content: unknown) => { const output = errorText(content); return output === undefined ? undefined : errorLine(output) }

  it('takes the first usable line from strings, content blocks and message objects', () => {
    expect(line('not found')).toBe('not found')
    expect(line([{ type: 'image', text: 'skip' }, { type: 'text', text: '\n  Permission   denied \nsecond' }])).toBe('Permission denied')
    expect(line({ message: 'boom' })).toBe('boom')
    expect(line({ error: 'bad' })).toBe('bad')
    expect(line('\u001b[31mred\u001b[0m failure\nnext')).toBe('red failure')
    expect(line('\n\n  \nfirst\nsecond')).toBe('first')
  })

  it('skips a bare exit code and prefers the line that names the failure', () => {
    expect(line('Exit code 1\n> vitest run\nError: Cannot find module x')).toBe('Error: Cannot find module x')
    expect(line('Exit code 2\nsomething else happened')).toBe('something else happened')
    expect(line('Exit code 1')).toBe('Exit code 1')
    expect(line('Exit code 1\n> vitest run test/errors.test.ts\nError: Cannot find module x')).toBe('Error: Cannot find module x')
  })

  it('redacts the whole output before picking a line, so a multiline secret stays matched', () => {
    const redactBlock = (value: string) => value.replaceAll('BEGIN\n  secret\nEND', '[redacted]')
    expect(redactToolActivity({ tool: 'Shell', error: errorText('Error: BEGIN\n  secret\nEND')! }, redactBlock).error).toBe('Error: [redacted]')
  })

  it('redacts a secret that spans lines or ends in a newline before any whitespace rewrite', () => {
    const redactBlock = (value: string) => value.replaceAll('key\n', '[redacted]')
    expect(redactToolActivity({ tool: 'Shell', error: errorText('Error: key\n')! }, redactBlock).error).toBe('Error: [redacted]')
    const subject = describeCommand('make deploy', undefined, 'Deploy with key\n now').subject!
    expect(redactToolActivity({ tool: 'Shell', subject }, redactBlock).subject).toBe('Deploy with [redacted] now')
  })

  it('gives Grok gateway calls the same prefixed name as every other driver', () => {
    expect(describeTool('use_tool', { tool_name: 'manor__goal_reached', tool_input: {} }).tool).toBe('mcp__manor__goal_reached')
  })

  it('keeps the reason a Cursor background command failed with', () => {
    const cursor = new CursorStreamParser('test')
    const shell = { args: { command: 'pnpm dev' }, result: { success: { isBackground: true, shellId: 7 } } }
    cursor.handle(JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: 'bg', tool_call: { shellToolCall: shell } }))
    expect(cursor.handle(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: '7', status: 'error', detail: 'exit_code=1' })))
      .toMatchObject([{ type: 'tool_result', toolCallId: 'bg', outcome: 'error', error: 'exit_code=1' }])
  })

  it('keeps the reason a Claude background command failed with', () => {
    const parser = new StreamParser(true, true)
    const line = (value: object) => JSON.stringify(value)
    parser.handle(line({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'call-b', name: 'Bash', input: { command: 'pnpm build', run_in_background: true } }] } }))
    parser.handle(line({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'call-b', description: 'pnpm build', is_backgrounded: true, task_type: 'local_bash' }))
    expect(parser.handle(line({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'call-b', status: 'failed', summary: 'Error: build failed' })))
      .toContainEqual({ type: 'tool_result', toolCallId: 'call-b', outcome: 'error', error: 'Error: build failed' })
  })

  it('redacts a multiline search pattern before its label is flattened', () => {
    const redactBlock = (value: string) => value.replaceAll('one\ntwo', '[redacted]')
    expect(redactToolActivity(describeCommand("rg 'one\ntwo' src"), redactBlock).subject).not.toMatch(/one|two/)
  })

  it('clips command and detail only after redaction', () => {
    const { command, detail } = describeCommand(`echo ${'z'.repeat(1_100)} secret ${'z'.repeat(1_100)}`)
    const safe = redactToolActivity({ tool: 'Shell', command: command!, detail: detail! }, redactSecret)
    expect(safe.command).toContain('\n...\n')
    expect(`${safe.detail}${safe.command}`).not.toContain('sec')
    const tail = redactToolActivity({ tool: 'Shell', detail: `${'q'.repeat(496)} secret` }, redactSecret).detail!
    expect(tail).not.toContain('sec')
  })

  it('clips a long reason to 200 characters only after redaction', () => {
    const clipped = redactToolActivity({ tool: 'Shell', error: 'x'.repeat(500) }, redactSecret).error!
    expect(clipped).toHaveLength(200)
    expect(clipped.endsWith('…')).toBe(true)
    const straddling = redactToolActivity({ tool: 'Shell', error: `${'x'.repeat(196)} secret` }, redactSecret).error!
    expect(straddling).not.toContain('sec')
    const subject = redactToolActivity({ tool: 'Shell', subject: `${'y'.repeat(496)} secret` }, redactSecret).subject!
    expect(subject).not.toContain('sec')
    expect(subject.length).toBeLessThanOrEqual(500)
  })

  it('reads a Cursor failure nested under the tool kind', () => {
    const events = new CursorStreamParser('test').handle(JSON.stringify({
      type: 'tool_call', subtype: 'completed', call_id: 'call',
      tool_call: { shellToolCall: { args: { command: 'pnpm test' }, result: { error: { message: 'Error: 3 tests failed' } } } },
    }))
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ outcome: 'error', error: 'Error: 3 tests failed' })
  })

  it.each([undefined, null, '', '  \n ', [], [{ type: 'image' }], {}, 42])('returns undefined for %j', (value) => {
    expect(errorText(value)).toBeUndefined()
  })

  it('redacts the error before it leaves the driver', () => {
    expect(redactToolActivity({ tool: 'Shell', error: 'token secret rejected' }, redactSecret)).toEqual({ tool: 'Shell', error: 'token [redacted] rejected' })
  })

  it('carries a Claude is_error result, and only on failure', () => {
    const user = (isError: boolean) => JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'call', is_error: isError, content: [{ type: 'text', text: 'ENOENT: no such file\nat read' }] },
    ] } })
    expect(new StreamParser().handle(user(true))).toEqual([{ type: 'tool_result', toolCallId: 'call', outcome: 'error', error: 'ENOENT: no such file\nat read' }])
    expect(new StreamParser().handle(user(false))).toEqual([{ type: 'tool_result', toolCallId: 'call', outcome: 'success' }])
  })

  it('carries a failed Codex command\'s output, recorded as its reason line', () => {
    const parser = new CodexStreamParser()
    const events = parser.handle(notification('item/completed', { type: 'commandExecution', id: 'call', command: 'ls nope', status: 'failed', exitCode: 2, aggregatedOutput: 'ls: nope: No such file\n' }))
    const result = events.at(-1)!
    expect(result).toMatchObject({ type: 'tool_result', outcome: 'error' })
    if (result.type !== 'tool_result') throw new Error('missing result')
    expect(redactToolActivity(result, (value) => value).error).toBe('ls: nope: No such file')
  })
})

describe('report after tools', () => {
  const report = async (events: RuntimeEvent[]) => createTurnStream({
    chatId: 'chat', turnId: 'turn', agent: smith, liveMessages: new Map(), emit: () => {}, append: async () => {},
  }).consume({ events: (async function* () { yield* events })(), stop() {} }, 'test')

  it.each([
    {
      name: 'a Codex row promoted to background work after the report needs no new one',
      first: { background: undefined }, between: [], reported: true,
    },
    {
      name: 'a helper resumed under its old call id after the report needs a new one',
      first: { background: true as const },
      between: [{ type: 'tool_result', toolCallId: 'call', outcome: 'success', output: 'First pass' } satisfies RuntimeEvent],
      reported: false,
    },
  ])('$name', async ({ first, between, reported }) => {
    const outcome = await report([
      { type: 'tool_use', tool: 'Agent', toolCallId: 'call', ...first },
      ...between,
      { type: 'message', messageId: 'report', text: 'The first pass is done.' },
      { type: 'tool_use', tool: 'Agent', toolCallId: 'call', background: true },
      ...(reported ? [] : [{ type: 'tool_result', toolCallId: 'call', outcome: 'success', output: 'Second pass' } satisfies RuntimeEvent]),
      { type: 'result', text: '' },
    ])
    expect(outcome).toMatchObject({ usedTools: true, reportedAfterTools: reported })
  })
})

it('names background work a provider could not keep in one note at the turn end', async () => {
  const notes: [string, string][] = []
  const stream = (unconfirmed: boolean) => createTurnStream({
    chatId: 'chat', turnId: 'turn', agent: smith, liveMessages: new Map(), emit: () => {},
    append: async (draft) => { if (draft.type === 'system_note') notes.push([draft.kind, draft.text]) },
  }).consume({ events: (async function* () {
    yield { type: 'result', text: 'Watching it.' } satisfies RuntimeEvent
    yield { type: 'background_stopped', titles: ['Watch the build log'], ...(unconfirmed ? { unconfirmed: true } : {}) } satisfies RuntimeEvent
  })(), stop() {} }, 'test')
  await stream(false)
  await stream(true)
  expect(notes).toEqual([
    ['info', `${smith.name}'s turn ended, so Manor stopped any background work still running from it: \u201cWatch the build log\u201d.`],
    ['error', `${smith.name}'s turn ended. Manor tried to stop background work still running from it but could not confirm it stopped: \u201cWatch the build log\u201d.`],
  ])
})
