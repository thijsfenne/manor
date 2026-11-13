import { REASONING_LIMIT, apiPricedInputEquivalent, modelTextOf, type AgentConfig, type AttachedMcpServer, type Driver, type LiveSessionEvent, type LiveSessionInfo, type ProviderUsage, type RuntimeEvent, type Usage, type TurnHandle, type TurnInput } from '@manor/contracts'
import { execFile } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { AsyncQueue } from '../asyncQueue.js'
import { describeCommand } from './commands.js'
import { errorLine } from './toolActivity.js'
import { memoryRoot, resolveMemoryTarget } from '../memoryTarget.js'
import { parseOutboundDraftIntent } from '../outboundDraftIntent.js'
import { gitBinary } from '../gitBinary.js'
import { NOTE_EDIT_AGENT_ID, noteEditParts } from '../noteEdit.js'

const MOCK_COMPACT_MS = 1_500

export interface MockDriverOptions {
  /** Pause between deltas so streaming is actually visible in the UI. */
  deltaDelayMs?: number
  /**
   * The roster as it stands right now, so a scripted chief of staff has somebody real
   * to delegate to. Read per turn, not captured: a persona added while the server runs
   * is delegatable on the very next turn.
   */
  agents?: () => readonly AgentConfig[]
  /** Injectable only so the scripted relay can be proved without opening a port. */
  request?: typeof fetch
  /**
   * Spike-only. "mock lease card computer" or "mock lease card codex-computer" raises
   * the real Mac lease approval card for that connector and stops at consent, so its
   * wording and Allow/Deny can be checked without a desktop host or a real engine.
   * Rejects when the card is denied.
   */
  desktopCard?: (capability: string, connector: string) => Promise<void>
  /** Where the scripted live session reports its row's end and its wake. */
  onLiveSession?: (event: LiveSessionEvent) => void
}

/**
 * "native background 8s: <title>" starts a provider-native background agent the way
 * a Claude persona does, and ends the turn while it runs: the session stays live and
 * asks for a wake after that many seconds. "codex background 8s: <command>" does the
 * same with a shell the way a Codex persona does: the row is announced as background
 * only at the answer, and the wake carries Manor's prompt instead of a held run. Only a
 * turn in a room that wakes takes either.
 */
function nativeBackgroundFor(input: TurnInput): { seconds: number; title: string; codex: boolean } | undefined {
  if (input.live !== true) return undefined
  const match = /\b(native|codex) background (\d+)s:\s*(.+)/i.exec(lastUserLine(input))
  return match === null ? undefined : { seconds: Math.min(Number(match[2]), 600), title: match[3]!.trim(), codex: match[1]!.toLowerCase() === 'codex' }
}

/**
 * The context reading each real provider gives, so the composer's context card has
 * something to show on the spike: Claude reports a fill and the compaction point Manor
 * passed in, Codex reports a fill and its own window, Cursor a fill alone, Grok nothing.
 */
function mockContextReading(driver: AgentConfig['driver']): Pick<Extract<RuntimeEvent, { type: 'result' }>, 'contextTokens' | 'contextWindow' | 'autoCompactTokens'> {
  if (driver === 'claude') return { contextTokens: 138_000, autoCompactTokens: 300_000 }
  if (driver === 'codex') return { contextTokens: 44_000, contextWindow: 258_000 }
  if (driver === 'cursor') return { contextTokens: 61_000 }
  return {}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const LONG_REPLY = Array.from({ length: 240 }, (_, index) =>
  index % 24 === 0 ? `\n\n## Part ${index / 24 + 1}\n\n` : index % 6 === 0 ? `\n- point ${index}, ` : `word ${index} of a long streamed answer, `)

/** "reply of N lines" streams N short lines, four deltas each, for render counts per reply length. */
const linesReply = (lines: number) => Array.from({ length: lines }, (_, line) =>
  [`\n\nLine ${line + 1}, `, 'a few words ', 'of streamed ', 'text.']).flat()

/**
 * "mock diagram" streams two Mermaid blocks a line per delta, slowly, so the half-written fence
 * is on screen for a while, then one that does not parse and must stay code.
 */
const DIAGRAM_REPLY = [
  '\n\nHow a turn travels:\n\n```mermaid\n', 'flowchart LR\n', '  T[User] --> C[Composer]\n', '  C --> S{Server}\n',
  '  S -->|mock| D[Driver]\n', '  D --> R[Reply]\n', '  R --> T\n', '```\n\n', 'And the order of events:\n\n```mermaid\n',
  'sequenceDiagram\n', '  User->>Marlow: Question\n', '  Marlow->>Sage: Ask\n', '  Sage-->>Marlow: Answer\n',
  '  Marlow-->>User: Reply\n', '```\n\n', 'This one is broken on purpose:\n\n```mermaid\n', 'flowchart LR\n  A -->\n', '```\n\n', 'Done.',
]

/** "mock sources" cites pages inline and in a Sources list; `.invalid` never has an icon. */
const SOURCES_REPLY = [
  '\n\nDe vaakste was C. difficile (ca. 13%), daarna E. coli en virussen ',
  '([Columbia-studie](https://www.cuimc.columbia.edu/news/enteric-infections-ibd), [Healio](https://www.healio.com/news/gastroenterology)). ',
  'Antibiotica kunnen een flare uitlokken ([bron](https://pmc.ncbi.nlm.nih.gov/articles/PMC123/)), ',
  'maar een kapotte site ([geen icoon](https://no-icon.invalid/x)) toont de wereldbol. ',
  'Mail [de huisarts](mailto:huisarts@example.nl) of open [het dashboard](http://localhost:5173/x).\n\n',
  'Sources:\n\n', '- [Enteric infections in IBD flares (Columbia)](https://www.cuimc.columbia.edu/news/enteric-infections-ibd)\n',
  '- [Healio, enteric infections and IBD flares](https://www.healio.com/news/gastroenterology)\n',
  '- [PMC, UC flare triggers](https://pmc.ncbi.nlm.nih.gov/articles/PMC123/)\n',
  '- [Missing icon](https://no-icon.invalid/x)\n', '- https://pubmed.ncbi.nlm.nih.gov/123/\n',
]

/** Last thing the human said in the catch-up, so the scripted reply looks responsive. */
/**
 * A built-in's broker URL, read from its stdio flag. Manor now serves its built-ins over
 * HTTP, which drops those flags; the brokers keep their fixed paths on the same origin.
 */
const BROKER_PATHS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  builtin_manor: {
    '--broker-url': '/internal/user-input', '--relay-url': '/internal/agent-relay', '--subagent-url': '/internal/subagent',
    '--deliver-url': '/internal/deliver-file', '--goal-url': '/internal/goal-claims', '--secret-url': '/internal/secret-request',
  },
  builtin_work: { '--broker-url': '/internal/work-tool' },
  builtin_browser: { '--broker-url': '/internal/browser-tool' },
}

function brokerFlag(attachment: AttachedMcpServer | undefined, flag: string): string | undefined {
  if (attachment === undefined) return undefined
  const at = attachment.server.args.indexOf(flag)
  if (at !== -1) return attachment.server.args[at + 1]
  const brokerPath = BROKER_PATHS[attachment.server.id]?.[flag]
  const served = attachment.server.url
  return brokerPath === undefined || served === undefined ? undefined : new URL(brokerPath, served).toString()
}

const NOTE_FILLER = /\b(eigenlijk|best wel|een beetje|gewoon|heel erg|dus|nu echt|actually|basically|really|just)\s+/gi

/** One line of a note with its filler words dropped, the edit the mock can show a diff of. */
const tightened = (line: string) => line.replace(NOTE_FILLER, '')

/**
 * A Knowledge note edit with no model behind it: filler words go, so the spike shows a
 * real diff, and text without any gains a visible mark instead of coming back unchanged.
 * "slow turn" in the instruction holds the answer long enough to see Working and to Stop.
 */
function mockNoteEdit(input: TurnInput, queue: AsyncQueue<RuntimeEvent>): TurnHandle {
  const { instruction, selection, note } = noteEditParts(lastUserLine(input))
  const source = selection ?? note ?? ''
  const edited = source.split('\n').map(tightened).join('\n')
  const text = edited !== source ? edited : selection !== undefined ? `${source.trimEnd()} (reworked)` : `${source.trimEnd()}\n\nReworked by the mock driver.\n`
  const timer = setTimeout(() => {
    queue.push({ type: 'result', text })
    queue.close()
  }, /\bslow turn\b/i.test(instruction) ? 15_000 : MOCK_COMPACT_MS)
  return {
    events: queue,
    stop() {
      clearTimeout(timer)
      queue.close()
    },
  }
}

function lastUserLine(input: TurnInput): string {
  for (let index = input.catchUp.length - 1; index >= 0; index -= 1) {
    const event = input.catchUp[index]
    if (event?.type === 'user_message') return modelTextOf(event)
  }
  return '(nothing yet)'
}

/**
 * The session this turn continues, or the one it mints. Under `MANOR_DRIVER=mock` the
 * persona still names the provider she would run on, so a provider switch mints a
 * separate session for each provider, the way the real CLIs do.
 */
function sessionIdFor(input: TurnInput): string {
  const { agent } = input
  return input.sessionId ?? `mock-${input.threadId}-${agent.id}${agent.driver === 'mock' ? '' : `-${agent.driver}`}`
}

/**
 * What a resumed session was handed, said back in the reply: the only visible proof
 * on the spike of which provider session continued and where its catch-up started.
 */
function resumedLine(input: TurnInput): string {
  const missed = input.catchUp.flatMap((event) =>
    event.type === 'user_message' ? [`"${modelTextOf(event).slice(0, 60)}"`]
      : event.type === 'agent_message' ? [`${event.agentId}'s reply`]
        : [])
  return `Resumed ${input.sessionId} and caught up on what I missed: ${missed.join(', ')}. `
}

/** Everything said in this catch-up, for the scripted delegation trigger. */
function catchUpText(input: TurnInput): string {
  return input.catchUp
    .map((event) => (event.type === 'user_message' ? modelTextOf(event) : event.type === 'agent_message' ? event.text : ''))
    .join('\n')
}

interface MockConsultation {
  target: AgentConfig
  brokerUrl: string
  capability: string
  text: string
  /** "silently" skips the sentence a persona writes before the call, the way a model sometimes does. */
  silent: boolean
}

/** A deliberate dev-only phrase that exercises the real relay broker end to end. */
function consultationFor(input: TurnInput, roster: readonly AgentConfig[]): MockConsultation | undefined {
  const message = [...input.catchUp].reverse().find((event) => event.type === 'user_message')
  if (message?.type !== 'user_message' || message.source === 'agent_relay') return undefined
  const words = message.text.toLocaleLowerCase()
  const target = roster.find((candidate) => {
    if (candidate.id === input.agent.id) return false
    const names = [candidate.id, candidate.name].map((value) => value.toLocaleLowerCase())
    return names.some((name) => words.includes(`ask ${name}`) || words.includes(`consult ${name}`))
  })
  if (target === undefined) return undefined
  const attachment = input.mcpServers?.find(
    ({ server, disabledTools }) =>
      server.id === 'builtin_manor' &&
      server.tools.includes('message_agent') &&
      !disabledTools.includes('message_agent'),
  )
  if (attachment === undefined) return undefined
  const brokerUrl = brokerFlag(attachment, '--relay-url')
  const capability = attachment.runtimeEnv?.MANOR_USER_INPUT_CAPABILITY
  if (brokerUrl === undefined || capability === undefined) return undefined
  return {
    target,
    brokerUrl,
    capability,
    text: `Give ${input.agent.name} a concise answer to this question from the user: ${message.text}`.slice(0, 8_000),
    silent: words.includes('silently'),
  }
}

interface MockDelegation {
  brokerUrl: string
  capability: string
  model: string
  effort: string
  task: string
  /** "background subagent …" starts the child and ends the turn; its end wakes the persona. */
  wait: boolean
  /** "review subagent …" marks the child as a code reviewer. */
  review: boolean
}

const DELEGATION = /\b(background\s+)?(review\s+)?subagent\s+(\S+)\s+(low|medium|high|xhigh|max):\s*([\s\S]+)/i

/**
 * "subagent gpt-6.1-sol high: <task>" runs the real delegate broker end to end, so a
 * child thread, its sidebar row and its result can be checked without a provider. A
 * task that itself starts with that form makes the child delegate once more, which
 * Settings must allow. "review subagent …" starts it as a code reviewer. Several lines
 * in that form start one child each, in order, so parallel children and their one
 * wake can be checked.
 */
function delegationsFor(input: TurnInput): MockDelegation[] {
  const message = [...input.catchUp].reverse().find((event) => event.type === 'user_message')
  if (message?.type !== 'user_message' || (message.source !== undefined && message.source !== 'subagent_task')) return []
  const attachment = input.mcpServers?.find(({ server }) => server.id === 'builtin_manor' && server.tools.includes('delegate_task'))
  if (attachment === undefined) return []
  const brokerUrl = brokerFlag(attachment, '--subagent-url')
  const capability = attachment.runtimeEnv?.MANOR_USER_INPUT_CAPABILITY
  if (brokerUrl === undefined || capability === undefined) return []
  const lines = message.text.split('\n').filter((line) => DELEGATION.test(line))
  return (lines.length > 1 ? lines : [message.text]).flatMap((text) => {
    const match = DELEGATION.exec(text)
    return match === null ? [] : [{
      brokerUrl, capability, model: match[3]!, effort: match[4]!.toLowerCase(), task: match[5]!.trim(), wait: match[1] === undefined, review: match[2] !== undefined,
    }]
  })
}

/** The connector a "mock lease card <connector>" message names, with this turn's capability. */
function leaseCardFor(input: TurnInput): { connector: string; capability: string } | undefined {
  const match = /\bmock lease card (codex-computer|computer)\b/i.exec(lastUserLine(input))
  const capability = input.mcpServers?.find(({ server }) => server.id === 'builtin_manor')
    ?.runtimeEnv?.MANOR_USER_INPUT_CAPABILITY
  return match === null || capability === undefined ? undefined : { connector: match[1]!.toLowerCase(), capability }
}

/**
 * Spike-only. "mock fill login" (or "mock fill login as <username>") calls the real
 * browser broker's browser_fill_login with this turn's browser capability, the way
 * the browser MCP does, and answers with what the agent would hear back.
 */
function loginFillFor(input: TurnInput, request: typeof fetch): MockWorkStep | undefined {
  const match = /\bmock fill login(?: as (\S+))?/i.exec(lastUserLine(input))
  const attachment = input.mcpServers?.find(({ server }) => server.id === 'builtin_browser')
  const brokerUrl = brokerFlag(attachment, '--broker-url')
  const capability = attachment?.runtimeEnv?.MANOR_BROWSER_BROKER_CAPABILITY
  if (match === null || brokerUrl === undefined || capability === undefined) return undefined
  return {
    tool: 'browser_fill_login',
    run: async (signal) => {
      const response = await request(brokerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-manor-browser-capability': capability },
        body: JSON.stringify({ tool: 'browser_fill_login', arguments: match[1] === undefined ? {} : { username: match[1] } }),
        signal,
      })
      const payload = await response.json() as { result?: unknown; error?: string }
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return `browser_fill_login answered \`${JSON.stringify(payload.result)}\``
    },
  }
}

interface MockWorkStep {
  tool: string
  /** A file the step writes, named first so Manor attributes it to this turn in a shared checkout. */
  writes?: string
  /** A plan published before the step and never ticked further: the first done, the next in progress. */
  plan?: string[]
  run: (signal: AbortSignal) => Promise<string>
  /** A second tool call after this one; its answer is the turn's reply. */
  next?: MockWorkStep
}

const MOCK_RESULT_FILE = 'mock-result.md'
/** The code file "mock code edit" writes, so the review gate and a reopen can be proved. */
const MOCK_CODE_FILE = 'mock-result.ts'

async function mockGit(cwd: string, args: string[]): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  await promisify(execFile)(gitBinary(), ['-c', 'user.name=Mock', '-c', 'user.email=mock@manor.invalid', ...args], { cwd, env })
}

/**
 * Spike-only. A turn reading "mock memory: <line>" records an edit adding that line to
 * the persona's notes in the memory folder the server resolves, so the memory mark
 * can be proved, together with "Ask Sage" in the same message as well. Nothing is
 * written: the mark is built from the recorded edit, so a run on the real HOME never
 * touches the user's memory. Without a local checkout there is no memory and no edit.
 */
function mockMemoryEdit(input: TurnInput): Extract<RuntimeEvent, { type: 'tool_use' }> | undefined {
  // Only the user's own message: a relayed question or answer quoting it writes nothing.
  const message = [...input.catchUp].reverse().find((event) => event.type === 'user_message')
  if (message?.type !== 'user_message' || message.source !== undefined) return undefined
  const line = /\bmock memory:\s*([^\n]+)/i.exec(message.text)?.[1]?.trim()
  const root = memoryRoot(resolveMemoryTarget(process.env, homedir()))
  if (line === undefined || root === undefined) return undefined
  const file = path.join(root, 'memory', 'agents', `${input.agent.id}.md`)
  return {
    type: 'tool_use', toolCallId: 'mock-memory', tool: 'Edit', detail: path.basename(file), targets: [file],
    edits: [{ path: file, before: '', after: `- ${line}\n` }],
  }
}

/**
 * Spike-only Work script, so a Session's result card can be proved without a provider.
 * In a chat, "mock start work <Persona> [with <Persona>] [in <Project>] [key <key>] [on <provider>/<model>/<effort> for <reason>]: <task>"
 * proposes the task through the real work broker, the `with` persona as supporting and the `on` clause as a project
 * thread's proposed runtime; repeating a key in a later turn revises that proposal. In the Session the goal owner reading "mock goal: <result> |
 * <limitation>" writes `mock-result.md` into the first linked folder and reports through
 * the real goal broker; "shots: <path>,<path>" after it names screenshots for the card, "steps: A / B / C" a plan it leaves open
 * and "commit: <subject> // <body>" the commit message Confirm commits a worktree Session with.
 * "mock report: …" reports the same way without writing the file, a result with nothing
 * to commit; "choices: <title> = <option> / <option>*; …" after either adds the choices
 * it leaves open, a trailing * on the recommended option.
 * In a worktree Session Manor commits that file itself at Confirm and merges it. A commit
 * request that does reach the lead (a shared checkout, a commit Git refused, or Retry)
 * commits that file on the Session's branch and skips a commit already made, unless the
 * goal text said "hold", which leaves the commit undone so a blocked completion shows,
 * or "slow", which waits eight seconds before the commit so its state can be seen. Any turn
 * reading "mock edit: <line>" appends that line to `mock-result.md`, a file change
 * after the result is published; "mock code edit: <line>" appends it to `mock-result.ts`
 * instead, a code change. Argus reading "mock review passed" in a turn that holds
 * `review_passed` calls it, the way a clean review ends. "mock deliver: <absolute path>"
 * hands that file over through the real `deliver_file` broker; a trailing "phone"
 * asks for the phone viewport. "attach <name>,<name>" before the colon of "mock start
 * work" passes `attachments`, `images` standing for the turn's own pictures.
 */
function workScriptFor(input: TurnInput, request: typeof fetch): MockWorkStep | undefined {
  const line = lastUserLine(input)
  const proposal = /\bmock start work (\S+)(?: with (\S+))?(?: in (.+?))?(?: key ([\w-]+))?(?: on (\w+)\/([\w.-]+)\/(\w+) for ([^:]+?))?(?: attach (\S+))?:\s*([\s\S]+)/i.exec(line)
  const work = input.mcpServers?.find(({ server }) => server.id === 'builtin_work')
  if (proposal !== null && work !== undefined) {
    const brokerUrl = brokerFlag(work, '--broker-url')
    const capability = work.runtimeEnv?.MANOR_WORK_BROKER_CAPABILITY
    if (brokerUrl === undefined || capability === undefined) return undefined
    const task = proposal[10]!.trim()
    // "attach a.html,images": names as given, `images` for this turn's pictures on disk.
    const attachments = proposal[9]?.split(',').flatMap((name) => name === 'images' ? [...input.imagePaths ?? []] : [name])
    return {
      tool: 'mcp__work__start_work',
      run: async (signal) => {
        const response = await request(brokerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-manor-work-capability': capability },
          body: JSON.stringify({
            assignmentKey: proposal[4] ?? `mock-${Date.now()}`, project: proposal[3]?.trim() ?? 'Manor',
            title: task.split(/[.:\n]/)[0]!.slice(0, 60), task,
            // "mock start work nobody: …" names no executor, as a thread on an install without Session personas does.
            ...(proposal[1]!.toLowerCase() === 'nobody' ? {} : { firstExecutor: proposal[1]! }),
            ...(proposal[2] === undefined ? {} : { supportingPersonas: [proposal[2]] }),
            ...(proposal[5] === undefined ? {} : { provider: proposal[5], model: proposal[6], effort: proposal[7], runtimeReason: proposal[8]!.trim() }),
            ...(attachments === undefined ? {} : { attachments }),
          }),
          signal,
        })
        const body = await response.json().catch(() => undefined) as { error?: string } | undefined
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        return 'Proposed it as a Session. Accept the card to start.'
      },
    }
  }
  const folder = input.repoPaths[0]
  const goal = /\bmock (goal|report):\s*([^|\n]+)(?:\|\s*([^\n]+))?/i.exec(line)
  const manor = input.mcpServers?.find(({ server }) => server.id === 'builtin_manor' && server.tools.includes('goal_reached'))
  if (goal !== null && manor !== undefined && folder !== undefined) {
    const goalUrl = brokerFlag(manor, '--goal-url')
    const capability = manor.runtimeEnv?.MANOR_USER_INPUT_CAPABILITY
    if (goalUrl === undefined || capability === undefined) return undefined
    // "shots: <path>,<path>" anywhere after the result names screenshots for the card.
    const shots = /\bshots:\s*(\S+(?:\s*,\s*\S+)*)/i.exec(line)?.[1]?.split(/\s*,\s*/)
    // "steps: A / B / C" publishes a plan the lead leaves open, the way a long turn forgets to tick it.
    const plan = /\bsteps:\s*(.+?)(?=\b(?:shots|choices|commit|points):|$)/i.exec(line)?.[1]?.split('/').map((step) => step.trim()).filter(Boolean)
    // "points: A / B / C" hands the card its result lines.
    const points = /\bpoints:\s*(.+?)(?=\b(?:shots|choices|commit|steps):|$)/i.exec(line)?.[1]?.split('/').map((point) => point.trim()).filter(Boolean)
    const message = /\bcommit:\s*(.+?)(?=\b(?:shots|choices|steps|points):|$)/i.exec(line)?.[1]?.split('//').map((part) => part.trim())
    const commit = message?.[0] ? { subject: message[0], ...(message[1] ? { body: message[1] } : {}) } : undefined
    const choices = /\bchoices:\s*(.+?)(?=\b(?:shots|commit|points):|$)/i.exec(line)?.[1]?.split(';').flatMap((entry) => {
      const [title, options] = entry.split('=').map((part) => part.trim())
      if (!title || !options) return []
      const listed = options.split('/').map((option) => option.trim()).filter(Boolean)
      const recommended = listed.find((option) => option.endsWith('*'))?.slice(0, -1).trim()
      return [{ title, options: listed.map((option) => option.replace(/\*$/, '').trim()), ...(recommended === undefined ? {} : { recommended }) }]
    })
    const writesFile = goal[1]!.toLowerCase() === 'goal'
    const result = goal[2]!.replace(/\b(shots|choices|steps|commit|points):.*$/i, '').trim()
    // "learn: <preference>" after the limitation reports a learning to the project thread.
    const rest = goal[3]?.replace(/\b(shots|choices|steps|commit|points):.*$/i, '')
    const learned = /\blearn:\s*(.+)$/i.exec(rest ?? '')
    const limitations = rest?.replace(/\blearn:\s*.+$/i, '').trim()
    return {
      tool: 'mcp__manor__goal_reached',
      ...(writesFile ? { writes: path.join(folder, MOCK_RESULT_FILE) } : {}),
      ...(plan === undefined ? {} : { plan }),
      run: async (signal) => {
        if (writesFile) await writeFile(path.join(folder, MOCK_RESULT_FILE), `${line}\n`)
        const response = await request(goalUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-manor-user-input-capability': capability },
          body: JSON.stringify({
            claims: [{ claim: result, level: 'reproduced', ref: MOCK_RESULT_FILE }],
            report: {
              result,
              ...(limitations === undefined || limitations === '' ? {} : { limitations }),
              ...(learned === null ? {} : { learnings: [{ kind: 'preference', text: learned[1]!.trim(), quote: learned[1]!.trim() }] }),
              ...(choices === undefined || choices.length === 0 ? {} : { choices }),
              ...(points === undefined || points.length === 0 ? {} : { points }),
              ...(commit === undefined ? {} : { commit }),
            },
            ...(shots === undefined ? {} : { screenshots: shots }),
          }),
          signal,
        })
        const body = await response.json().catch(() => undefined) as { error?: string } | undefined
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        return `Done: ${result}`
      },
    }
  }
  const delivery = /\bmock deliver:\s*(\/\S+)(\s+phone)?/i.exec(line)
  const deliverer = input.mcpServers?.find(({ server }) => server.id === 'builtin_manor' && server.tools.includes('deliver_file'))
  if (delivery !== null && deliverer !== undefined) {
    const deliverUrl = brokerFlag(deliverer, '--deliver-url')
    const capability = deliverer.runtimeEnv?.MANOR_USER_INPUT_CAPABILITY
    if (deliverUrl === undefined || capability === undefined) return undefined
    return {
      tool: 'mcp__manor__deliver_file',
      run: async (signal) => {
        const response = await request(deliverUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-manor-user-input-capability': capability },
          body: JSON.stringify({ path: delivery[1], ...(delivery[2] === undefined ? {} : { viewport: 'phone' }) }),
          signal,
        })
        const body = await response.json().catch(() => undefined) as { error?: string; note?: string } | undefined
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        return body?.note ?? 'Delivered.'
      },
    }
  }
  if (/\bmock review passed\b/i.test(line) && input.mcpServers?.some(({ server }) =>
    server.id === 'builtin_manor' && server.tools.includes('review_passed'))) {
    return { tool: 'mcp__manor__review_passed', run: async () => 'No findings, the current diff passes.' }
  }
  const edit = /\bmock (code )?edit:\s*([^\n]+)/i.exec(line)
  if (edit !== null && folder !== undefined) {
    const file = edit[1] === undefined ? MOCK_RESULT_FILE : MOCK_CODE_FILE
    return {
      tool: 'Bash',
      writes: path.join(folder, file),
      run: async () => {
        await appendFile(path.join(folder, file), `${edit[2]!.trim()}\n`)
        return 'Edited the result file.'
      },
    }
  }
  // Retry posts the same request under the same Confirm, after a line of its own.
  if (/^\[Manor\] The user (?:confirmed the ready result|pressed Retry)/.test(line) && folder !== undefined) {
    return {
      tool: 'Bash',
      run: async () => {
        const written = await readFile(path.join(folder, MOCK_RESULT_FILE), 'utf8').catch(() => '')
        if (written === '' || /\bhold\b/i.test(written)) return 'Holding the commit, as the goal asked.'
        if (/\bslow\b/i.test(written)) await sleep(8_000)
        const files = [MOCK_RESULT_FILE, ...await readFile(path.join(folder, MOCK_CODE_FILE)).then(() => [MOCK_CODE_FILE], () => [])]
        await mockGit(folder, ['add', '--', ...files])
        // A retried request finds the commit from its first attempt already made.
        const staged = await mockGit(folder, ['diff', '--cached', '--quiet', '--', ...files]).then(() => false, () => true)
        if (staged) await mockGit(folder, ['commit', '-m', 'Mock result', '--', ...files])
        // Manor rebases and merges an approved branch itself once this turn ends.
        return 'Committed the result.'
      },
    }
  }
  return undefined
}

/** One `--name value` pair from the built-in Manor server holding `tool`, with this turn's capability. */
function manorEndpoint(input: TurnInput, tool: string, option: string): { url: string; capability: string } | undefined {
  const manor = input.mcpServers?.find(({ server }) => server.id === 'builtin_manor' && server.tools.includes(tool))
  const url = brokerFlag(manor, option)
  const capability = manor?.runtimeEnv?.MANOR_USER_INPUT_CAPABILITY
  return url === undefined || capability === undefined ? undefined : { url, capability }
}

async function postManor(request: typeof fetch, endpoint: { url: string; capability: string }, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await request(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-manor-user-input-capability': endpoint.capability },
    body: JSON.stringify(body),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
  return payload
}

/**
 * The preferences body a project turn was handed, one bullet per line: the turn's
 * `preferences` block when the file changed since the session started, else the copy
 * in the persona. The mock keeps no provider history, so it reads both every turn.
 */
function injectedPreferences(input: TurnInput): string[] {
  const handed = input.volatileBlocks?.find((block) => block.key === 'preferences')?.text ?? input.agent.character
  const at = handed.search(/\[Manor\] (Current preferences\.md|Project preferences) for /)
  if (at === -1) return []
  const block = handed.slice(at).split('\n\n[Manor]')[0] ?? ''
  return block.split('\n').flatMap((line) => /^\s*-\s+(.*\S)/.exec(line)?.[1] ?? [])
}

/**
 * Spike-only project thread script (2026-10-10). "mock ask: <question> | <a> | <b>" asks
 * through the real ask broker, so a thread-started session's question lands in the
 * thread. "mock preference: <line>" in a thread turn writes preferences.md through the
 * real tool ("mock note: <line>" writes notes.md, "&&" joins lines); "mock replace preference: <old> => <new>" and "mock remove preference: <old>"
 * change or drop a line the same way. A question wake answers itself when an option appears in a preferences
 * line, and leaves the card otherwise. A brief wake proposes its session through the
 * real work broker. "mock report <Project>: <text>" in a DM reports a preference.
 * "mock status: <line>" in a thread-started Session writes its notes.md line through the
 * real `set_session_status`.
 * "mock send to <Session title or id>: <message>" in a thread turn the user started sends
 * the message on to that Session through the real `send_to_session`.
 */
/**
 * Spike-only secret card script. "mock secret command" asks through the real broker for
 * a value that a real command echoes, so a run shows Manor hiding it from the output;
 * "mock secret browser" fills the open page, and a trailing "posted" asks the way Codex
 * and Cursor do.
 */
function secretScriptFor(input: TurnInput, request: typeof fetch): MockWorkStep | undefined {
  const match = /\bmock secret (command|browser)( posted)?/i.exec(lastUserLine(input))
  const asker = manorEndpoint(input, 'request_secret', '--secret-url')
  if (match === null || asker === undefined) return undefined
  const target = match[1]!.toLowerCase()
  return {
    tool: 'mcp__manor__request_secret',
    run: async (signal) => {
      const payload = await postManor(request, asker, {
        label: target === 'command' ? 'Mock API token' : 'Mock site password',
        reason: 'The mock turn needs this to carry on.',
        target,
        ...(target === 'command' ? { command: 'printf "token is %s\\n" "$MOCK_TOKEN"', env: 'MOCK_TOKEN' } : {}),
        ...(match[2] === undefined ? {} : { deferred: true }),
      }, signal)
      return String(payload.result)
    },
  }
}

/**
 * Spike-only connect card script. "mock connect <toolkit> <alias>" posts a Composio
 * sign-in to the real card as COMPOSIO_MANAGE_CONNECTIONS would; "mock login <row>"
 * posts an MCP login. A name containing "fail" fails after the mock delay.
 */
function connectScriptFor(input: TurnInput, request: typeof fetch): MockWorkStep | undefined {
  const match = /\bmock (connect|login) ([\w-]+)(?: (personal|work))?/i.exec(lastUserLine(input))
  const asker = manorEndpoint(input, 'ask_user', '--broker-url')
  if (match === null || asker === undefined) return undefined
  const oauth = match[1]!.toLowerCase() === 'login'
  return {
    tool: oauth ? `mcp__${match[2]}__login` : 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS',
    run: async (signal) => {
      const url = new URL('/internal/mock-connect', asker.url).href
      const payload = await postManor(request, { url, capability: asker.capability }, {
        kind: oauth ? 'mcp_oauth' : 'composio', app: match[2], ...(match[3] === undefined ? {} : { alias: match[3] }),
      }, signal)
      const outcome = (payload.outcome ?? {}) as { status?: string; reason?: string }
      if (outcome.status === 'connected') return `${match[2]} is connected now.`
      if (outcome.status === 'failed') return `The ${match[2]} sign-in failed: ${outcome.reason ?? 'unknown'}`
      return `The card for ${match[2]} is waiting for you in the chat.`
    },
  }
}

/**
 * Spike-only: a draft line goes through the real prepare endpoint, as
 * prepare_outbound_draft would, so the connection check and its connect card run. Without
 * the endpoint (unit tests) the plain reply below still emits the draft as a stream event.
 */
function draftScriptFor(input: TurnInput, request: typeof fetch): MockWorkStep | undefined {
  const draft = parseOutboundDraftIntent(lastUserLine(input))
  const endpoint = manorEndpoint(input, 'prepare_outbound_draft', '--draft-url')
  if (draft === undefined || endpoint === undefined) return undefined
  return {
    tool: 'mcp__manor__prepare_outbound_draft',
    run: async (signal) => {
      const payload = await postManor(request, endpoint, draft, signal)
      return typeof payload.note === 'string' && payload.draftId === undefined
        ? payload.note
        : draft.channel === 'gmail' ? 'Here is the mail. Check it and send it when it reads right.' : 'Here is the Slack message.'
    },
  }
}

/**
 * A new agent's interview: whenever the turn holds `write_instructions`, the mock asks
 * three questions through the real ask broker, then writes instructions from the form and
 * the answers it got. A skipped answer ("Skipped. …") adds nothing, so skipping them all
 * leaves instructions built from the name and the job alone.
 */
function interviewScriptFor(input: TurnInput, request: typeof fetch): MockWorkStep | undefined {
  const asker = manorEndpoint(input, 'ask_user', '--broker-url')
  const writer = manorEndpoint(input, 'write_instructions', '--instructions-url')
  if (asker === undefined || writer === undefined) return undefined
  const { name, description } = input.agent
  const questions = [
    { id: 'focus', header: 'Focus', question: `What should ${name} help with most?`, options: [{ label: 'Planning my week' }, { label: 'Thinking through decisions' }, { label: 'Drafting messages' }] },
    { id: 'tone', header: 'Tone', question: 'How should answers sound?', options: [{ label: 'Short and direct' }, { label: 'Warm and explanatory' }, { label: 'Formal' }] },
    { id: 'never', header: 'Limits', question: `What should ${name} never do?`, options: [{ label: 'Send anything without asking' }, { label: 'Guess when unsure' }, { label: 'Use jargon' }] },
  ]
  const kept: string[] = []
  return {
    tool: 'mcp__manor__ask_user',
    run: async (signal) => {
      const payload = await postManor(request, asker, { questions }, signal)
      const answers = (payload.answers ?? {}) as Record<string, unknown>
      for (const { id, header } of questions) {
        const answer = Array.isArray(answers[id]) ? (answers[id] as unknown[]).join(', ') : String(answers[id] ?? '')
        if (answer !== '' && !answer.startsWith('Skipped')) kept.push(`- ${header}: ${answer}`)
      }
      return 'Answered.'
    },
    next: {
      tool: 'mcp__manor__write_instructions',
      run: async (signal) => {
        const job = description.trim()
        const instructions = [
          `# ${name}`,
          '',
          `You are ${name}.${job === '' ? '' : ` You help with this: ${job}`}`,
          ...(kept.length === 0 ? [] : ['', '## What the user asked for', ...kept]),
        ].join('\n')
        await postManor(request, writer, { instructions }, signal)
        return kept.length === questions.length
          ? 'My instructions are set. I left nothing out.'
          : 'My instructions are set. I left out what you skipped and built that part on the form.'
      },
    },
  }
}

function projectScriptFor(input: TurnInput, request: typeof fetch): MockWorkStep | undefined {
  const text = lastUserLine(input)
  const ask = /\bmock ask:\s*([^|\n]+)\|([^\n]+)/i.exec(text)
  const asker = manorEndpoint(input, 'ask_user', '--broker-url')
  if (ask !== null && asker !== undefined) {
    const options = ask[2]!.split('|').map((label) => label.trim()).filter(Boolean).slice(0, 4)
    return {
      tool: 'mcp__manor__ask_user',
      run: async (signal) => {
        const payload = await postManor(request, asker, {
          questions: [{ id: 'choice', question: ask[1]!.trim(), options: options.map((label) => ({ label })) }],
        }, signal)
        const answers = (payload.answers ?? {}) as Record<string, unknown>
        return `Going with ${JSON.stringify(answers.choice ?? 'nothing')}.`
      },
    }
  }
  const preference = /\bmock (preference|note):\s*([^\n]+)/i.exec(text)
  const change = /\bmock (replace|remove) preference:\s*([^\n]+)/i.exec(text)
  const writer = manorEndpoint(input, 'update_project_file', '--project-url')
  if ((preference !== null || change !== null) && writer !== undefined) {
    const [old, line] = change?.[2]!.split('=>').map((part) => part.trim()) ?? []
    // "mock preference: <a> && <b>" writes both lines in one turn.
    const writes = change === null
      ? preference![2]!.split('&&').map((entry) => ({ lineAction: 'add', line: entry.trim() }))
      : [change[1]!.toLowerCase() === 'replace' ? { lineAction: 'replace', old, line } : { lineAction: 'remove', old }]
    const file = preference?.[1]!.toLowerCase() === 'note' ? 'notes.md' : 'preferences.md'
    return {
      tool: 'mcp__manor__update_project_file',
      run: async (signal) => {
        for (const body of writes) await postManor(request, writer, { action: 'write', file, ...body }, signal)
        return file === 'notes.md' ? 'Noted.' : 'Saved that preference.'
      },
    }
  }
  const question = /^\[Manor\] The session .+\(requestId (\S+)\):\n(.+)$/m.exec(text)
  const answerer = manorEndpoint(input, 'answer_session_question', '--project-url')
  if (question !== null && answerer !== undefined) {
    const asked = JSON.parse(question[2]!) as { id: string; options: string[] }[]
    const lines = injectedPreferences(input)
    const picks = asked.map((entry) => {
      const option = entry.options.find((label) => lines.some((line) => line.toLowerCase().includes(label.toLowerCase())))
      return option === undefined ? undefined : { id: entry.id, option, line: lines.find((line) => line.toLowerCase().includes(option.toLowerCase()))! }
    })
    if (picks.every((pick) => pick !== undefined) && picks.length > 0) {
      return {
        tool: 'mcp__manor__answer_session_question',
        run: async (signal) => {
          await postManor(request, answerer, {
            action: 'answer', requestId: question[1],
            answers: Object.fromEntries(picks.map((pick) => [pick!.id, pick!.option])),
            preference: picks[0]!.line,
          }, signal)
          return `Answered from preferences.md: ${picks.map((pick) => pick!.option).join(', ')}.`
        },
      }
    }
  }
  const brief = /handed this brief over from a DM[\s\S]*assignmentKey (brief-\S+),[\s\S]*\nTitle: ([^\n]+)\n(?:First executor: ([^\n]+)\n)?(?:Attachments: [^\n]+\n)?Task:\n([\s\S]+)$/.exec(text)
  const work = input.mcpServers?.find(({ server }) => server.id === 'builtin_work')
  if (brief !== null && work !== undefined) {
    const brokerUrl = brokerFlag(work, '--broker-url')
    const capability = work.runtimeEnv?.MANOR_WORK_BROKER_CAPABILITY
    if (brokerUrl === undefined || capability === undefined) return undefined
    return {
      tool: 'mcp__work__start_work',
      run: async (signal) => {
        const response = await request(brokerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-manor-work-capability': capability },
          body: JSON.stringify({
            assignmentKey: brief[1], project: input.agent.character.match(/project thread for ([^:]+):/)?.[1] ?? 'Manor',
            title: brief[2]!.trim(), task: brief[4]!.trim(), ...(brief[3] === undefined ? {} : { firstExecutor: brief[3].trim() }),
          }),
          signal,
        })
        const body = await response.json().catch(() => undefined) as { error?: string } | undefined
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        return 'Started the session for that brief.'
      },
    }
  }
  const forward = /\bmock send to ([^:\n]+):\s*([^\n]+)/i.exec(text)
  const forwarder = manorEndpoint(input, 'send_to_session', '--project-url')
  if (forward !== null && forwarder !== undefined) {
    return {
      tool: 'mcp__manor__send_to_session',
      run: async (signal) => {
        const payload = await postManor(request, forwarder, { action: 'forward', session: forward[1]!.trim(), message: forward[2]!.trim() }, signal)
        // The note's first sentence is the receipt; the rest is guidance for a real model.
        return typeof payload.note === 'string' ? payload.note.split(' as the user')[0]! + '.' : 'Sent.'
      },
    }
  }
  const status = /\bmock status:\s*([^\n]+)/i.exec(text)
  const statusUrl = manorEndpoint(input, 'set_session_status', '--project-url')
  if (status !== null && statusUrl !== undefined) {
    return {
      tool: 'mcp__manor__set_session_status',
      run: async (signal) => {
        const payload = await postManor(request, statusUrl, { action: 'status', status: status[1]!.trim() }, signal)
        return typeof payload.note === 'string' ? payload.note : 'Saved.'
      },
    }
  }
  const report = /\bmock report ([^:]+):\s*([^\n]+)/i.exec(text)
  const reporter = manorEndpoint(input, 'report_to_project', '--project-url')
  if (report !== null && reporter !== undefined) {
    return {
      tool: 'mcp__manor__report_to_project',
      run: async (signal) => {
        const payload = await postManor(request, reporter, { action: 'report', project: report[1]!.trim(), kind: 'preference', text: report[2]!.trim(), quote: report[2]!.trim() }, signal)
        return typeof payload.note === 'string' ? payload.note : 'Reported.'
      },
    }
  }
  return undefined
}

async function delegate(delegation: MockDelegation, request: typeof fetch, signal: AbortSignal): Promise<string> {
  const response = await request(delegation.brokerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-manor-user-input-capability': delegation.capability },
    body: JSON.stringify({ action: 'delegate_task', task: delegation.task, model: delegation.model, effort: delegation.effort, wait: delegation.wait, ...(delegation.review ? { review: true } : {}) }),
    signal,
  })
  const body = await response.json() as { report?: { status?: string; result?: string; reason?: string; title?: string }; error?: string }
  if (!response.ok) return `The subagent was refused: ${body.error ?? `HTTP ${response.status}`}`
  if (!delegation.wait) return `Started \u201c${body.report?.title ?? delegation.task}\u201d in the background. I will pick it up when it ends.`
  return body.report?.status === 'done'
    ? `The subagent on ${delegation.model} answered: ${body.report.result ?? ''}`
    : `The subagent ended ${body.report?.status ?? 'unknown'}${body.report?.reason === undefined ? '' : `: ${body.report.reason}`}`
}

async function consult(
  consultation: MockConsultation,
  request: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const response = await request(consultation.brokerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-manor-user-input-capability': consultation.capability,
    },
    body: JSON.stringify({ to: consultation.target.id, text: consultation.text }),
    signal,
  })
  const body: unknown = await response.json()
  if (!response.ok || typeof body !== 'object' || body === null || typeof (body as { reply?: unknown }).reply !== 'string') {
    throw new Error(`mock agent message failed with HTTP ${response.status}`)
  }
  return (body as { reply: string }).reply
}

/**
 * Scripted stand-in for a real provider CLI. All UI work runs against this: it
 * exercises deltas, a tool_use, usage accounting and session ids without touching
 * the user's weekly cap. A persona with tools gets a tool_use in its script, one
 * without does not, so the toolbelt difference is visible in the UI too.
 *
 * A persona that may summon someone has one extra scripted behaviour: asked to
 * "delegate", it replies by @mentioning the first agent on its own allowlist,
 * which is what makes the whole delegation path exercisable without a real model.
 * Keyed on the allowlist rather than `isCos` since 2026-08-13, when delegation
 * moved off the chief-of-staff flag: an `isCos` script would produce a mention the
 * orchestrator drops, so the path it exists to demonstrate would never run. A
 * persona with an empty allowlist keeps the old script exactly.
 *
 * "Ask Sage" or "consult Sage" also invokes the real turn-scoped relay broker when
 * Sage is in the live roster and the turn carries `message_agent`. Relayed prompts
 * never trigger that script, so the mock can exercise a standing pair without
 * recursively consulting itself.
 */
export function createMockDriver(options: MockDriverOptions = {}): Driver {
  /** Scripted live sessions by thread and persona, with the timer that ends their work. */
  const live = new Map<string, { info: LiveSessionInfo; timer: NodeJS.Timeout; threadId: string; agentId: string }>()
  const liveKey = (threadId: string, agentId: string) => `${threadId}\u0000${agentId}`
  let launches = 0
  return {
    liveSession: (threadId, agentId) => live.get(liveKey(threadId, agentId))?.info,
    busyLiveThreads: () => [...live.values()].filter((session) => session.info.running.length > 0).map((session) => session.threadId),
    closeLiveSession(threadId, agentId) {
      const stopped: string[] = []
      for (const [key, session] of [...live]) {
        if (session.threadId !== threadId || (agentId !== undefined && session.agentId !== agentId)) continue
        live.delete(key)
        clearTimeout(session.timer)
        for (const item of session.info.running) {
          stopped.push(item.title)
          options.onLiveSession?.({ type: 'row', threadId, agentId: session.agentId, event: { type: 'tool_result', toolCallId: item.toolCallId, outcome: 'stopped' } })
        }
        options.onLiveSession?.({ type: 'closed', threadId, agentId: session.agentId })
      }
      return stopped
    },
    // Slow enough to see the shimmer and to Stop, and nothing for a mock session to shrink.
    compactSession() {
      const queue = new AsyncQueue<RuntimeEvent>()
      const timer = setTimeout(() => {
        queue.push({ type: 'result', text: '' })
        queue.close()
      }, MOCK_COMPACT_MS)
      return {
        events: queue,
        stop() {
          clearTimeout(timer)
          queue.close()
        },
      }
    },
    startTurn(input: TurnInput): TurnHandle {
      const queue = new AsyncQueue<RuntimeEvent>()
      const { agent } = input
      if (agent.id === NOTE_EDIT_AGENT_ID) return mockNoteEdit(input, queue)
      // The persona's next turn takes its live session over; with nothing left running it ends there.
      const attached = input.live === true ? live.get(liveKey(input.threadId, agent.id)) : undefined
      if (attached !== undefined && attached.info.running.length === 0) {
        live.delete(liveKey(input.threadId, agent.id))
        options.onLiveSession?.({ type: 'closed', threadId: input.threadId, agentId: agent.id })
      }
      const native = nativeBackgroundFor(input)
      // A delegated task or a consulted agent saying "slowly" streams for about fifteen
      // seconds, so the spike can show a running child, or a reply still to follow.
      const slowChild = input.catchUp.some((event) =>
        event.type === 'user_message' &&
        (event.source === 'subagent_task' || event.source === 'agent_relay') &&
        /\bslowly\b/i.test(event.text))
      // A delegated task saying "for N seconds" answers after roughly that long, so
      // parallel children can end apart on the spike.
      const childSeconds = input.catchUp.flatMap((event) => event.type === 'user_message' && event.source === 'subagent_task'
        ? [Number(/\bfor (\d{1,3}) seconds\b/i.exec(event.text)?.[1] ?? Number.NaN)] : []).find((seconds) => !Number.isNaN(seconds))
      // "slow turn" in a message stretches the plain reply to about a minute, so the
      // spike can show a long turn's working label, a Stop or a restart mid-turn.
      const delay = childSeconds !== undefined ? childSeconds * 250 : slowChild ? 3_000
        : /\bslow turn\b/i.test(lastUserLine(input)) ? 15_000
        // Slow enough to catch a half-written fence on screen.
        : /\bmock diagram\b/i.test(lastUserLine(input)) ? 700 : options.deltaDelayMs ?? 40
      let stopped = false
      const controller = new AbortController()

      const roster = options.agents?.() ?? []
      const allowlist = agent.mentionAllowlist ?? []
      const asked = allowlist.length > 0 && catchUpText(input).toLowerCase().includes('delegate')
      const delegateTo = asked
        ? roster.find((candidate) => candidate.id !== agent.id && allowlist.includes(candidate.id))
        : undefined
      const consultation = consultationFor(input, roster)
      const delegations = delegationsFor(input)
      const leaseCard = options.desktopCard === undefined ? undefined : leaseCardFor(input)
      // A scripted line inside a delegated task is the child's to run, not its parent's.
      const workStep = delegations.length > 0 ? undefined : interviewScriptFor(input, options.request ?? fetch) ??
        workScriptFor(input, options.request ?? fetch) ??
        projectScriptFor(input, options.request ?? fetch) ??
        connectScriptFor(input, options.request ?? fetch) ??
        draftScriptFor(input, options.request ?? fetch) ??
        secretScriptFor(input, options.request ?? fetch) ??
        loginFillFor(input, options.request ?? fetch)

      void (async () => {
        const messageId = 'message_1'
        // Reasoning before the first tool call, so the mock exercises the same
        // interleaving a real provider produces rather than a tidier one.
        queue.push({
          type: 'reasoning',
          // Sliced like the real drivers: this line quotes the user's message, and a
          // pasted document would otherwise push it past the durable cap.
          text: `The question is about "${lastUserLine(input)}". Checking the notes first, then answering directly rather than guessing.`.slice(
            0,
            REASONING_LIMIT,
          ),
        })
        // A delegated task saying "mock crash" ends in an error, so the spike can show a failed child.
        if (input.catchUp.some((event) => event.type === 'user_message' && event.source === 'subagent_task' && /\bmock crash\b/i.test(event.text))) {
          queue.push({ type: 'error', message: 'The provider dropped the connection.' })
          queue.close()
          return
        }
        const memoryEdit = mockMemoryEdit(input)
        if (memoryEdit !== undefined) {
          queue.push(memoryEdit)
          queue.push({ type: 'tool_result', toolCallId: 'mock-memory', outcome: 'success' })
        }
        let consulted: string | undefined
        if (workStep !== undefined) {
          if (workStep.plan !== undefined) {
            queue.push({ type: 'todo_update', todos: workStep.plan.map((text, at) => ({
              text, status: at === 0 ? 'completed' as const : at === 1 ? 'in_progress' as const : 'pending' as const,
            })) })
          }
          if (workStep.writes !== undefined) {
            const name = path.basename(workStep.writes)
            queue.push({
              type: 'tool_use', toolCallId: 'mock-write', tool: 'Edit', detail: name, targets: [workStep.writes],
              edits: [{ path: workStep.writes, before: '', after: `${lastUserLine(input)}\n` }],
            })
            queue.push({ type: 'tool_result', toolCallId: 'mock-write', outcome: 'success' })
          }
          let answer = ''
          for (let step: MockWorkStep | undefined = workStep, at = 0; step !== undefined; step = step.next, at += 1) {
            const toolCallId = at === 0 ? 'mock-work' : `mock-work-${at}`
            queue.push({ type: 'tool_use', toolCallId, tool: step.tool })
            let outcome: 'success' | 'error' = 'success'
            try {
              answer = await step.run(controller.signal)
            } catch (error: unknown) {
              outcome = 'error'
              answer = `The scripted step failed: ${error instanceof Error ? error.message : 'unknown error'}`
            }
            if (stopped) return
            queue.push({ type: 'tool_result', toolCallId, outcome })
            if (outcome === 'error') break
          }
          queue.push({ type: 'message', messageId, text: answer })
          queue.push({
            type: 'result',
            text: answer,
            usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.0012 },
            ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
            sessionId: sessionIdFor(input),
          })
          queue.close()
          return
        }
        if (leaseCard !== undefined) {
          let answer: string
          try {
            await options.desktopCard!(leaseCard.capability, leaseCard.connector)
            answer = `Allowed: ${leaseCard.connector} may use the Mac for the rest of this turn. Nothing ran, this mock stops at consent.`
          } catch (error: unknown) {
            answer = `Not allowed: ${error instanceof Error ? error.message : 'unknown error'}`
          }
          if (stopped) return
          queue.push({ type: 'message', messageId, text: answer })
          queue.push({
            type: 'result',
            text: answer,
            usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.0012 },
            ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
            sessionId: sessionIdFor(input),
          })
          queue.close()
          return
        }
        if (delegations.length > 0) {
          const answers: string[] = []
          for (const delegation of delegations) {
            try {
              answers.push(await delegate(delegation, options.request ?? fetch, controller.signal))
            } catch (error: unknown) {
              answers.push(`The subagent call failed: ${error instanceof Error ? error.message : 'unknown error'}`)
            }
            if (stopped) return
          }
          const answer = answers.join('\n')
          if (stopped) return
          // A slow child keeps working after its own subagent ends, so the spike can show
          // a finished grandchild leave while the turn that started it still runs.
          if (slowChild) await sleep(delay * 4)
          if (stopped) return
          queue.push({ type: 'message', messageId, text: answer })
          queue.push({
            type: 'result',
            text: answer,
            usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.0012 },
            ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
            sessionId: sessionIdFor(input),
          })
          queue.close()
          return
        }
        // "mock context loop" runs a tool loop whose every request reports its prompt
        // size, so the spike can watch the composer's ring climb mid-turn. "with
        // compaction" compacts the session partway, the way Claude's CLI does on its own.
        const contextLoop = /\bmock context loop( with compaction)?\b/i.exec(lastUserLine(input))
        if (contextLoop !== null) {
          const { contextWindow, autoCompactTokens } = mockContextReading(agent.driver)
          const window = {
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }),
          }
          const readings: (number | 'compact')[] = contextLoop[1] === undefined
            ? [90_000, 130_000, 170_000, 210_000, 250_000]
            : [90_000, 170_000, 250_000, 'compact', 52_000, 61_000]
          let last = 0
          for (const [at, reading] of readings.entries()) {
            if (reading === 'compact') {
              queue.push({ type: 'compaction', phase: 'start' })
              await sleep(delay * 100)
              if (stopped) return
              last = 38_000
              queue.push({ type: 'compaction', phase: 'end', contextTokens: last })
              await sleep(delay * 25)
              continue
            }
            const toolCallId = `mock-context-${input.threadId}-${at}`
            queue.push({ type: 'tool_use', toolCallId, tool: 'Read', detail: 'notes.md', targets: ['notes.md'] })
            await sleep(delay * 25)
            if (stopped) return
            queue.push({ type: 'tool_result', toolCallId, outcome: 'success' })
            last = reading
            queue.push({ type: 'context', contextTokens: reading, ...window })
            await sleep(delay * 25)
            if (stopped) return
          }
          const answer = `Read ${readings.filter((reading) => reading !== 'compact').length} times.`
          queue.push({ type: 'message', messageId, text: answer })
          queue.push({
            type: 'result',
            text: answer,
            usage: mockUsage(agent, 45),
            ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
            ...mockContextReading(agent.driver),
            contextTokens: last,
            ...(contextLoop[1] === undefined ? {} : { compacted: true as const }),
            sessionId: sessionIdFor(input),
          })
          queue.close()
          return
        }
        // "mock plan: A | B | C" publishes a plan and works through it a step at a time,
        // with reasoning and a read and an edit per step, so the spike can show the tasks
        // card staying in view while activity streams under it. "mock messy plan: …" sends
        // what agents get wrong: the next step in progress beside the current one, and no
        // final plan before the turn ends. "mock plan with compaction: …" compacts the
        // session for a while after the second step's read, then reads once more, so the
        // spike can show the plan pausing and resuming around Compacting. "A | B | C -> A | B2 | D | C"
        // revises the plan once the first step is done, holding a while on either side, so
        // the spike can show the card before and after an insight changed the list.
        const planned = /\bmock (messy )?plan( with compaction)?:\s*([^\n]+)/i.exec(lastUserLine(input))
        const tasksOf = (list: string | undefined) => list?.split('|').map((task) => task.trim()).filter(Boolean)
        const [firstPlan, revisedPlan] = planned?.[3]?.split('->') ?? []
        let plan = tasksOf(firstPlan)
        const revision = tasksOf(revisedPlan)
        const messy = planned?.[1] !== undefined
        const compactAt = planned?.[2] === undefined || plan === undefined ? -1 : Math.min(1, plan.length - 1)
        if (plan !== undefined && plan.length > 0) {
          const snapshot = (doing: number) => ({
            type: 'todo_update' as const,
            todos: (plan ?? []).map((text, at) => ({
              text,
              status: at < doing ? 'completed' as const : at === doing || (messy && at === doing + 1) ? 'in_progress' as const : 'pending' as const,
            })),
          })
          for (let at = 0; at < plan.length; at++) {
            const task = plan[at]!
            queue.push(snapshot(at))
            queue.push({ type: 'reasoning', text: `Working on "${task}". Reading the code that owns it first.` })
            const toolCallId = `mock-plan-${input.threadId}-${at}`
            queue.push({ type: 'tool_use', toolCallId, tool: 'Read', detail: 'notes.md', targets: ['notes.md'] })
            await sleep(delay * 40)
            if (stopped) return
            queue.push({ type: 'tool_result', toolCallId, outcome: 'success' })
            if (at === compactAt) {
              queue.push({ type: 'compaction', phase: 'start' })
              await sleep(delay * 200)
              if (stopped) return
              queue.push({ type: 'compaction', phase: 'end', contextTokens: 38_000 })
              queue.push({ type: 'tool_use', toolCallId: `${toolCallId}-after`, tool: 'Read', detail: 'notes.md', targets: ['notes.md'] })
              await sleep(delay * 200)
              if (stopped) return
              queue.push({ type: 'tool_result', toolCallId: `${toolCallId}-after`, outcome: 'success' })
            }
            queue.push({ type: 'reasoning', text: `"${task}" holds up. Moving on.` })
            await sleep(delay * 20)
            if (stopped) return
            if (at === 0 && revision !== undefined && revision.length > 0) {
              await sleep(delay * 200)
              if (stopped) return
              plan = revision
              queue.push({ type: 'reasoning', text: 'That changes the work. Revising the plan.' })
              queue.push(snapshot(1))
              await sleep(delay * 200)
              if (stopped) return
            }
          }
          if (!messy) queue.push(snapshot(plan.length))
          const answer = `Worked through ${plan.length} tasks.`
          queue.push({ type: 'message', messageId, text: answer })
          queue.push({
            type: 'result',
            text: answer,
            usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.0012 },
            ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
            sessionId: sessionIdFor(input),
          })
          queue.close()
          return
        }
        // "native helper" runs a provider's own subagent inside the turn for about twelve
        // seconds, the way Codex's spawn_agent or Claude's Task does, so the spike can show
        // its sidebar row and card without the delegate broker. The answer follows it.
        if (/\bnative helper\b/i.test(lastUserLine(input))) {
          const toolCallId = `mock-native-${input.threadId}-${Date.now()}`
          queue.push({
            type: 'tool_use', toolCallId, tool: 'spawn_subagent', subject: 'Check the sidebar row',
            subagent: { title: 'Check the sidebar row', prompt: 'Check the sidebar row. Report what it shows.' },
          })
          await sleep(12_000)
          if (stopped) return
          queue.push({ type: 'tool_result', toolCallId, outcome: 'success', output: 'The row shows a mark, a title and a spinner.' })
        }
        // "background helpers" answers at once and then waits on two helper agents and a
        // command it left running, the way a Claude turn waits on `run_in_background` work,
        // so the spike can show the rows staying open and the wait counting down. Once the
        // figure reports, it resumes the way SendMessage resumes an agent: its own row runs again.
        if (/\bbackground helpers\b/i.test(lastUserLine(input))) {
          const id = (name: string) => `mock-bg-${name}-${input.threadId}-${Date.now()}`
          const figure = id('figure')
          const receipt = id('receipt')
          const shell = id('shell')
          queue.push({ type: 'tool_use', toolCallId: figure, tool: 'Agent', subject: 'Build the trust figure', background: true,
            subagent: { title: 'Build the trust figure', prompt: 'Build the trust figure.' } })
          queue.push({ type: 'tool_use', toolCallId: receipt, tool: 'Agent', subject: 'Check the receipt', background: true,
            subagent: { title: 'Check the receipt', prompt: 'Check the receipt.' } })
          queue.push({ type: 'tool_use', toolCallId: shell, tool: 'Bash', command: 'pnpm build', detail: 'pnpm build', background: true })
          queue.push({ type: 'message', messageId, text: 'Started two helpers and a build in the background. I will report back.' })
          const resumed: RuntimeEvent = { type: 'tool_use', toolCallId: figure, tool: 'Agent', subject: 'Build the trust figure', background: true,
            subagent: { title: 'Build the trust figure', prompt: 'Label the axes too.' } }
          const steps: [number, RuntimeEvent, number, number][] = [
            [8_000, { type: 'tool_result', toolCallId: figure, outcome: 'success', output: 'The figure is drawn.' }, 1, 1],
            [4_000, resumed, 2, 1],
            [6_000, { type: 'tool_result', toolCallId: shell, outcome: 'success' }, 2, 0],
            [6_000, { type: 'tool_result', toolCallId: receipt, outcome: 'success', output: 'The receipt adds up.' }, 1, 0],
            [6_000, { type: 'tool_result', toolCallId: figure, outcome: 'success', output: 'The figure is drawn, axes labelled.' }, 0, 0],
          ]
          queue.push({ type: 'background_wait', agents: 2, commands: 1 })
          for (const [wait, step, agents, commands] of steps) {
            await sleep(wait)
            if (stopped) return
            queue.push(step)
            queue.push({ type: 'background_wait', agents, commands })
          }
          const answer = 'All three reported back: the figure is drawn with labelled axes and the receipt adds up.'
          queue.push({ type: 'message', messageId: 'message_2', text: answer })
          queue.push({
            type: 'result',
            text: answer,
            usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.0012 },
            ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
            sessionId: sessionIdFor(input),
          })
          queue.close()
          return
        }
        // "mock trace" runs one realistic stretch of mixed work between two sentences, so the
        // spike shows grouped reads and searches, described and bare commands, a failure
        // with its reason and a polled helper, without any real CLI.
        if (/\bmock trace\b/i.test(lastUserLine(input))) {
          const at = `${input.threadId}-${Date.now()}`
          queue.push({ type: 'message', messageId: `${messageId}-trace`, text: 'Ik draai de review-probe en kijk naar de capping.' })
          const steps: [Extract<RuntimeEvent, { type: 'tool_use' }>, 'success' | 'error', string?][] = [
            [{ type: 'tool_use', toolCallId: `t1-${at}`, tool: 'Read', detail: 'apps/server/src/drivers/codexDriver.ts', targets: ['apps/server/src/drivers/codexDriver.ts'] }, 'success'],
            [{ type: 'tool_use', toolCallId: `t2-${at}`, tool: 'Read', detail: 'apps/server/src/drivers/edits.ts', targets: ['apps/server/src/drivers/edits.ts'] }, 'success'],
            [{ type: 'tool_use', toolCallId: `t3-${at}`, tool: 'Read', detail: 'apps/server/src/workCompletion.ts', targets: ['apps/server/src/workCompletion.ts'], subject: 'workCompletion.ts, lines 350–365' }, 'success'],
            [{ type: 'tool_use', toolCallId: `t4-${at}`, tool: 'Grep', subject: '“fileChange|editsFromCodex” in drivers', targets: ['apps/server/src/drivers'] }, 'success'],
            [{ type: 'tool_use', toolCallId: `t5-${at}`, tool: 'Grep', subject: '“editsFromApplyPatch” in src', targets: ['apps/server/src'] }, 'success'],
            [{ type: 'tool_use', toolCallId: `t6-${at}`, ...describeCommand('pnpm exec vitest run --config vitest.review.config.ts test/.review/capped.test.ts', undefined, 'Run the capped-targets probe') }, 'error', 'Exit code 1\n> vitest run\nError: Cannot find module test/.review/capped.test.ts'],
            [{ type: 'tool_use', toolCallId: `t7-${at}`, ...describeCommand('cd /Users/me/Manor && pnpm exec vitest run test/workCompletion.test.ts 2>&1 | tail -30') }, 'success'],
            [{ type: 'tool_use', toolCallId: `t8-${at}`, ...describeCommand("python3 - <<'PY'\nfrom pathlib import Path\nprint(len(Path('a').read_text()))\nPY") }, 'success'],
            [{ type: 'tool_use', toolCallId: `t8b-${at}`, ...describeCommand(`sqlite3 -readonly $DB "select json_extract(payload,'$.type') from events where chat_id = 'c1' order by ts desc limit 20"`) }, 'success'],
            [{ type: 'tool_use', toolCallId: `t8c-${at}`, ...describeCommand(`sqlite3 -readonly $DB "select count(*) from events where json_extract(payload,'$.type') = 'tool_use'"`) }, 'success'],
            [{ type: 'tool_use', toolCallId: `t8d-${at}`, ...describeCommand('pnpm test | tail -20 && git status --short') }, 'success'],
            [{ type: 'tool_use', toolCallId: `t9-${at}`, tool: 'mcp__manor__task_result' }, 'success'],
            [{ type: 'tool_use', toolCallId: `t10-${at}`, tool: 'mcp__manor__task_result' }, 'success'],
            [{ type: 'tool_use', toolCallId: `t11-${at}`, tool: 'mcp__manor__task_result' }, 'success'],
          ]
          for (const [use, outcome, error] of steps) {
            if (stopped) return
            queue.push(use)
            await sleep(delay)
            queue.push({ type: 'tool_result', toolCallId: use.toolCallId!, outcome, ...(error === undefined ? {} : { error: errorLine(error) }) })
          }
          const answer = 'De probe stond nog niet op disk; de workCompletion-tests zijn groen.'
          queue.push({ type: 'message', messageId, text: answer })
          queue.push({
            type: 'result',
            text: answer,
            usage: { inputTokens: 120, outputTokens: 16, costUsd: 0.0012 },
            ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
            sessionId: sessionIdFor(input),
          })
          queue.close()
          return
        }
        // "monitor at turn end" starts a monitor and answers, the way a Grok turn does
        // with work its provider cannot keep, so the spike shows the stopped-work note.
        if (/\bmonitor at turn end\b/i.test(lastUserLine(input))) {
          const toolCallId = `mock-monitor-${input.threadId}-${Date.now()}`
          queue.push({ type: 'tool_use', toolCallId, tool: 'monitor', detail: 'Watch the build log' })
          queue.push({ type: 'tool_result', toolCallId, outcome: 'success' })
          const answer = 'Watching the build log.'
          queue.push({ type: 'message', messageId, text: answer })
          queue.push({
            type: 'result',
            text: answer,
            usage: { inputTokens: 120, outputTokens: 8, costUsd: 0.0012 },
            ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
            sessionId: sessionIdFor(input),
          })
          queue.push({ type: 'background_stopped', titles: ['Watch the build log'] })
          queue.close()
          return
        }
        if (consultation !== undefined) {
          // The acknowledgment goes first: Manor ends a DM turn the moment the call is accepted.
          const acknowledgment = consultation.silent ? '' : `Asking ${consultation.target.name}; their reply follows.`
          if (!consultation.silent) queue.push({ type: 'message', messageId: `${messageId}-ask`, text: acknowledgment })
          queue.push({
            type: 'tool_use',
            toolCallId: 'mock-relay',
            tool: 'message_agent',
            detail: consultation.target.name,
          })
          try {
            await consult(consultation, options.request ?? fetch, controller.signal)
            if (stopped) return
            queue.push({ type: 'tool_result', toolCallId: 'mock-relay', outcome: 'success' })
            queue.push({
              type: 'result',
              text: acknowledgment,
              usage: { inputTokens: 120, outputTokens: 8, costUsd: 0.0012 },
              ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
              sessionId: sessionIdFor(input),
            })
            queue.close()
            return
          } catch {
            if (stopped) return
            queue.push({ type: 'tool_result', toolCallId: 'mock-relay', outcome: 'error' })
            consulted = `I could not get an answer from ${consultation.target.name}, so I am continuing without it.`
          }
        }
        if (native !== undefined) {
          launches += 1
          const toolCallId = `mock-native-${launches}`
          const launch: Extract<RuntimeEvent, { type: 'tool_use' }> = native.codex
            ? { type: 'tool_use', toolCallId, tool: 'Bash', command: native.title, detail: native.title }
            : {
                type: 'tool_use', toolCallId, tool: 'Agent', subject: native.title, agentType: 'general-purpose', background: true,
                subagent: { title: native.title, prompt: native.title },
              }
          queue.push(launch)
          await sleep(delay)
          if (stopped) return
          const answer = `Started \u201c${native.title}\u201d in the background; I will pick it up when it reports back.`
          queue.push({ type: 'message', messageId, text: answer })
          if (native.codex) queue.push({ ...launch, background: true })
          const key = liveKey(input.threadId, agent.id)
          // The runtime the turn ran as, the way a real driver reports its own, so a Single
          // session's pin to the live session names a provider it accepts.
          const info: LiveSessionInfo = {
            driver: agent.driver, sessionId: sessionIdFor(input),
            model: agent.model, effort: agent.effort,
            running: [{ toolCallId, title: native.title, kind: native.codex ? 'command' : 'agent' }], wakeHeld: false,
          }
          const timer = setTimeout(() => {
            const session = live.get(key)
            if (session === undefined) return
            session.info.running = []
            session.info.wakeHeld = !native.codex
            options.onLiveSession?.({ type: 'row', threadId: input.threadId, agentId: agent.id,
              event: { type: 'tool_result', toolCallId, outcome: 'success', output: `${native.title}: nothing surprising.` } })
            options.onLiveSession?.({ type: 'wake', threadId: input.threadId, agentId: agent.id,
              ended: [{ toolCallId, title: native.title, state: 'done' }] })
          }, native.seconds * 1_000)
          timer.unref?.()
          live.set(key, { info, timer, threadId: input.threadId, agentId: agent.id })
          queue.push({
            type: 'result', text: answer, usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.0012 },
            ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
            sessionId: info.sessionId,
          })
          queue.close()
          return
        }
        // A wake: say what came back instead of quoting Manor's wake prompt as the user.
        const wake = [...input.catchUp].reverse().find((event) => event.type === 'user_message')
        const woken = wake?.type === 'user_message' && wake.source === 'background_wake' ? wake.wakeItems ?? [] : undefined
        // A Session question no preference answers: the thread's advice is a pick and its reason.
        const asked = /^\[Manor\] The session .+\(requestId \S+\):\n(.+)$/m.exec(lastUserLine(input))?.[1]
        const pick = asked === undefined ? undefined : (JSON.parse(asked) as { options: string[] }[])[0]?.options[0]
        const deltas = pick !== undefined ? [
          `Ik zou kiezen voor \u201c${pick}\u201d: `,
          'de kaart van een beurt vertelt wat die beurt deed, en het eindtotaal telt al live.',
        ] : woken !== undefined ? [
          `${agent.name} here. `,
          `Back from the background: ${woken.map((item) => `\u201c${item.title}\u201d ${item.state === 'done' ? 'finished' : item.state}`).join(', ')}. `,
          'That was the last piece, so this one is done.',
        ] : [
          `${agent.name} here. `,
          `You said: "${lastUserLine(input)}". `,
          input.isFullCatchUp ? 'Caught up on the whole thread. '
            : input.sessionId === undefined ? 'Caught up on what I missed. ' : resumedLine(input),
          // The only visible proof that the linked folders reached the driver, since no
          // real CLI runs here. Absent entirely for a project without any.
          ...(input.repoPaths.length === 0 ? [] : [`The project folders are ${input.repoPaths.join(', ')}. `]),
          consulted ?? (delegateTo === undefined
            ? agent.allowedTools.length > 0
              ? 'I had a quick look at the scratch dir and there is nothing surprising in it.'
              : 'No tools needed for this one, so here is my read on it.'
            : `@${delegateTo.name} please take this one.`),
          // "long reply" streams a few hundred markdown deltas, for measuring render cost per frame.
          ...(woken === undefined && /\blong reply\b/i.test(lastUserLine(input)) ? LONG_REPLY : []),
          ...(woken === undefined ? linesReply(Math.min(200, Number(/\breply of (\d{1,3}) lines\b/i.exec(lastUserLine(input))?.[1] ?? 0))) : []),
          ...(woken === undefined && /\bmock diagram\b/i.test(lastUserLine(input)) ? DIAGRAM_REPLY : []),
          ...(woken === undefined && /\bmock sources\b/i.test(lastUserLine(input)) ? SOURCES_REPLY : []),
        ]
        for (const [index, text] of deltas.entries()) {
          if (stopped) return
          await sleep(delay)
          if (stopped) return
          queue.push({ type: 'delta', messageId, text })
          if (index === 1 && agent.allowedTools.length > 0) {
            queue.push({
              type: 'tool_use',
              toolCallId: 'mock-read',
              tool: 'Read',
              detail: 'notes.md',
              targets: ['notes.md'],
            })
          }
          if (index === 2 && agent.allowedTools.length > 0) {
            queue.push({ type: 'tool_result', toolCallId: 'mock-read', outcome: 'success' })
            queue.push({
              type: 'tool_use',
              toolCallId: 'mock-edit',
              tool: 'Edit',
              detail: 'notes.md',
              targets: ['notes.md'],
              edits: [
                {
                  path: 'notes.md',
                  before: '# Notes\n\nOpen questions:\n- who owns the intake form\n',
                  after: '# Notes\n\nOpen questions:\n- who owns the intake form\n- when does the pilot start\n',
                },
              ],
            })
            queue.push({ type: 'tool_result', toolCallId: 'mock-edit', outcome: 'success' })
          }
        }
        if (stopped) return
        const draft = parseOutboundDraftIntent(lastUserLine(input))
        if (draft !== undefined) {
          queue.push({
            type: 'outbound_draft',
            draftId: `mock-${input.threadId}-${agent.id}`,
            ...draft,
          })
        }
        queue.push({ type: 'message', messageId, text: deltas.join('') })
        queue.push({
          type: 'result',
          text: deltas.join(''),
          usage: mockUsage(agent, 45),
          // This driver IS the provider here, so the agent it was handed (pin already
          // merged) is what it reports. Without it, UI work on `MANOR_DRIVER=mock`
          // would never see the label a real turn carries.
          ...(agent.model === undefined ? {} : { reportedModel: agent.model }),
          ...mockContextReading(agent.driver),
          sessionId: sessionIdFor(input),
        })
        queue.close()
      })()

      return {
        events: queue,
        stop() {
          stopped = true
          controller.abort()
          queue.close()
        },
      }
    },
  }
}

/**
 * A fixed subscription reading for `MANOR_DRIVER=mock`, so the Usage view's Limits tab
 * has windows to draw on the isolated spike. Every number here is made up and the
 * spike shows nothing else, so it cannot be mistaken for a real account.
 */
export function mockProviderUsage(provider: 'claude' | 'codex', now: number): ProviderUsage {
  const hour = 60 * 60_000
  const window = (label: string, minutes: number, usedPercent: number, resetsIn: number) => ({
    label, minutes, usedPercent, resetsAt: now + resetsIn, startsAt: now + resetsIn - minutes * 60_000,
  })
  return provider === 'claude'
    ? {
        provider, status: 'ok', plan: 'max', fetchedAt: now,
        windows: [
          window('5-hour limit', 300, 62, 2 * hour + 13 * 60_000),
          window('Weekly', 10_080, 31, 3 * 24 * hour + 4 * hour),
        ],
      }
    : {
        provider, status: 'ok', plan: 'plus', fetchedAt: now,
        windows: [
          window('5-hour limit', 300, 8, 4 * hour + 20 * 60_000),
          window('Weekly', 10_080, 71, 2 * 24 * hour + 6 * hour),
        ],
      }
}

/**
 * A plain mock reply's usage, shaped like its persona's real provider so the Usage view
 * shows both cost paths on the spike: Claude prices its own turn and splits its cache,
 * Codex splits its cache and reports no price.
 */
function mockUsage(agent: AgentConfig, outputTokens: number): Usage {
  const codex = agent.driver === 'codex'
  const parts = { freshInputTokens: codex ? 24 : 18, cacheWrite5mTokens: codex ? 0 : 6, cacheWrite1hTokens: 0, cacheReadTokens: 96 }
  return {
    inputTokens: 120,
    outputTokens,
    ...(codex ? {} : { costUsd: 0.0012 }),
    breakdown: { ...parts, apiPricedInputEquivalent: apiPricedInputEquivalent(parts) },
  }
}
