import { z } from 'zod'
import { MAIL_LABELS, MAIL_REASON_MAX, MailLabelSchema, type AttachedMcpServer, type MailLabel } from '@manor/contracts'
import type { McpToolServer } from './stdio.js'

export const MAIL_TRIAGE_MCP_ID = 'builtin_mail_triage'
export const MAIL_TRIAGE_MCP_NAME = 'mail_triage'
export const MAIL_TRIAGE_TOOL = 'mail_set_label'
/** Carries the run's capability to the MCP HTTP host; the only value the CLI is handed. */
export const MAIL_TRIAGE_CAPABILITY_ENV = 'MANOR_MAIL_TRIAGE_CAPABILITY'

const SetLabelInputSchema = z.object({
  id: z.string().min(1).max(40),
  label: MailLabelSchema,
  reason: z.string().trim().min(1).max(MAIL_REASON_MAX * 2),
})

/**
 * The triage run's only tool, mounted on the MCP HTTP host for one run. Served in
 * process and never spawned, so the turn's whole toolset is this one endpoint.
 */
export function mailTriageAttachment(capability: string): AttachedMcpServer {
  return {
    server: {
      id: MAIL_TRIAGE_MCP_ID,
      name: MAIL_TRIAGE_MCP_NAME,
      command: '',
      args: [],
      envKeys: [],
      description: 'Sets a triage label on one mail of this run.',
      // Writes only Manor's own label, never the mailbox. False keeps Cursor in Ask mode
      // instead of the Agent mode that brings its shell along.
      writes: false,
      effectPolicy: 'trusted',
      tools: [MAIL_TRIAGE_TOOL],
      readOnlyTools: [],
      schemaChars: 0,
    },
    disabledTools: [],
    runtimeEnv: { [MAIL_TRIAGE_CAPABILITY_ENV]: capability },
  }
}

/** What one call asks for, already checked against the run: its thread or a refusal the model reads. */
export type MailTriageLabeller = (id: string, label: MailLabel, reason: string) => string

/**
 * The tool server behind `mail_set_label`. `label` decides against this run's ids and
 * writes the label; `limit` caps the calls of one run, so a confused model cannot loop.
 */
export function mailTriageToolServer(label: MailTriageLabeller, limit: number): McpToolServer {
  let calls = 0
  return {
    name: 'manor-mail-triage',
    failureMessage: 'The label could not be set.',
    instructions: 'Sets one triage label on one mail of the current run. It never sends, archives or changes mail.',
    tools: [{
      name: MAIL_TRIAGE_TOOL,
      description: 'Label one mail of this run: reply (the user must answer or act), wait (the user waits for someone else) or fyi (nothing to do). Give the reason in one short line.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The mail\'s id from the list in this run.' },
          label: { type: 'string', enum: [...MAIL_LABELS] },
          reason: { type: 'string', maxLength: MAIL_REASON_MAX, description: 'Why, in one short line.' },
        },
        required: ['id', 'label', 'reason'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }],
    async callTool(name, arguments_) {
      if (name !== MAIL_TRIAGE_TOOL) throw new Error(`Unknown tool ${String(name)}.`)
      calls += 1
      if (calls > limit) throw new Error(`This run allows at most ${limit} label calls.`)
      const input = SetLabelInputSchema.safeParse(arguments_)
      if (!input.success) throw new Error('mail_set_label needs an id from this run, a label (reply, wait or fyi) and a one-line reason.')
      return [{ type: 'text', text: label(input.data.id, input.data.label, input.data.reason) }]
    },
  }
}
