import { isRecord, option, type McpToolServer } from './stdio.js'
import { WorkToolInputSchema, WORK_TOOL_NAME } from '../workTool.js'

const tool = {
  name: WORK_TOOL_NAME,
  description:
    'Propose one project Work assignment; Accept creates its thread in the mode the user chooses. Call once per separate assignment when the user requests a split or forwards work with @work. ' +
    'Use this instead of an in-Chat @mention when they name another persona as implementer. ' +
    'Write a short title, a one-sentence summary of the goal, and a mode-neutral task written as a brief (outcome, done, constraints, stop points). For an explicit handoff, do not research the codebase first; for a code change the Chat surfaced, investigate only enough to brief it. ' +
    'Put persona assignments only in firstExecutor and supportingPersonas, never in task. Single uses the chosen model; Multiple starts the proposed executor. Do not put Accept, navigation or persona-start instructions in task. You remain the author. ' +
    'Supporting personas are a starting team, not automatic participants. ' +
    'When screenshots or a mockup from this conversation carry the design, attach them with attachments; the Session sees only the task and what you attach. ' +
    'To revise a proposal, call again with the same assignmentKey: while the earlier one still awaits Accept, the new call replaces it as the next version (v2, v3) and the user sees only the newest card, so never ask them to reject the old one. After they accepted or rejected it, the same key starts a new proposal.',
  inputSchema: {
    type: 'object',
    properties: {
      assignmentKey: { type: 'string', minLength: 1, maxLength: 100, description: 'Stable short key for this assignment, e.g. quote-replies. Use distinct keys for separate assignments from the same source turn; reuse the exact key on every retry and revision, even if title or briefing changes. A revision replaces the pending proposal with that key.' },
      project: { type: 'string', description: 'Stable project id or exact visible project name. From a project thread the Session always lands in that thread\'s own project.' },
      title: { type: 'string', description: 'Short Work title.' },
      task: { type: 'string', minLength: 1, maxLength: 40000, description: 'Self-contained brief independent of executor or mode, scaled to the work: the whole requested outcome with decisions already made and no added scope; done in observable terms (the result and the checks that matter); constraints that change the work, with assumptions marked as assumptions; and stop points only for a blocking decision or an unauthorized irreversible action. A single-pass task stays a few lines. Self-contained means what to do: for background that lives in a memory card or document, name its absolute path with a one-line gist instead of pasting it. No persona assignments, Accept steps or instructions to start/confirm a persona. For handoff tests, verify the accepted session mode. Do not research the repo for an explicit handoff.' },
      summary: { type: 'string', minLength: 1, maxLength: 300, description: 'One plain sentence naming the goal, shown on the proposal card before Accept. No paths, ids or persona names.' },
      firstExecutor: { type: 'string', description: 'Stable persona id or exact visible name of the proposed first executor for Multiple. Must be yourself or a Session persona on your mention allowlist. If you stay in chat, name any Session persona; your own allowlist does not apply. Omit for legacy lead routing.' },
      supportingPersonas: {
        type: 'array', items: { type: 'string' }, maxItems: 8,
        description: 'Optional stable persona ids or exact visible names on the lead\'s current mention allowlist (yours, unless you stay in chat and firstExecutor leads).',
      },
      provider: { type: 'string', enum: ['claude', 'codex', 'grok', 'cursor'], description: 'Project thread only: the provider of the Single runtime this card opens on. Give provider, model, effort and runtimeReason together, or none for the workspace default.' },
      model: { type: 'string', description: 'Project thread only: model id from that provider\'s catalog, e.g. claude-sonnet-5-5, claude-opus-5-5, gpt-6.1-sol, gpt-6-luna. An unknown id is refused with the valid list.' },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Project thread only: reasoning effort for that model.' },
      runtimeReason: { type: 'string', minLength: 1, maxLength: 120, description: 'Project thread only: one short clause shown on the card after the runtime, e.g. "small UI change" or "Claude 5h window at 18%".' },
      attachments: {
        type: 'array', items: { type: 'string', minLength: 1, maxLength: 1000 }, maxItems: 8,
        description: 'Images and files from this conversation the Session needs to see, such as the screenshots the user sent and the HTML mockup you delivered when they carry the design. Name an image by the path Manor gave you under attachments/ (e.g. /…/attachments/<id>-0.png), a file the user attached or you delivered with deliver_file by its name or delivered path. The Session receives them as attachments on its kickoff; the card lists them before Accept. At most 8 together; PNG, JPEG or WebP images up to 1.5 MB, and text files (HTML, Markdown, CSV, JSON) up to 200 KB. PDFs, Word files and other binaries cannot go along. Do not attach files the task does not depend on.',
      },
    },
    required: ['assignmentKey', 'project', 'title', 'task'],
    additionalProperties: false,
  },
} as const

export function workMcpServer(argv: readonly string[]): McpToolServer {
  const brokerUrl = option('--broker-url', argv)
  return {
    name: 'manor-work',
    tools: [tool],
    failureMessage: 'The session handoff failed.',
    instructions: 'For an explicit request to carry work out in a named project, call start_work in this turn with a mode-neutral task brief: the requested outcome, done in observable terms, constraints, and real stop points. When the assignment has dependent steps, several deliverables, or may outlast one session, first confirm your restatement of the user\'s goals and the problem they are solving through ask_user, confirming option first, then call start_work in the same turn with their correction folded in, asking for the correction first when they only say it is not quite right; if they decline, do not call it. Keep persona assignment out of task; use firstExecutor and supportingPersonas. For an explicit handoff, do not research the repo for the kickoff. A bug fix or code change the Chat surfaced is never edited in the Chat; investigate only enough to brief it, then call start_work. Set firstExecutor to the initial implementer; put other team members in supportingPersonas. One source turn may propose several Work assignments: call once per assignment with distinct stable assignmentKey values and self-contained tasks. Retry each assignment with its original key. @work is a destination, never a persona. Forward new or previously discussed assignments using relevant chat context. Infer the project from that context; ask only when ambiguous. Accept composes the kickoff and starts the chosen Single model or Multiple executor. The task runs after Accept; never ask it to accept again or verify a predetermined persona.',
    async callTool(rawName, arguments_, capability) {
      const parsed = WorkToolInputSchema.safeParse(arguments_)
      if (rawName !== WORK_TOOL_NAME || !parsed.success) throw new Error('start_work received invalid fields.')
      const response = await fetch(brokerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-manor-work-capability': capability },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(15_000),
      })
      const payload: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : `Session broker returned HTTP ${response.status}.`)
      return [{ type: 'text', text: JSON.stringify(isRecord(payload) ? payload.result : undefined) }]
    },
  }
}
