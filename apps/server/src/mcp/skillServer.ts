import { isRecord, option, type McpToolServer } from './stdio.js'

const tool = {
  name: 'read_skill',
  description:
    'Read SKILL.md or a supporting text file from a skill attached to this persona. ' +
    'Read SKILL.md first when the task clearly matches the skill description. ' +
    'Use the returned nextOffset to continue only when a supporting file is truncated.',
  inputSchema: {
    type: 'object',
    properties: {
      skillId: { type: 'string', description: 'The attached skill id shown in the Manor skills catalog.' },
      path: { type: 'string', description: 'Bundle-relative path, starting with SKILL.md for activation.' },
      offset: { type: 'integer', minimum: 0, description: 'Character offset for continuing a truncated read.' },
    },
    required: ['skillId', 'path'],
    additionalProperties: false,
  },
} as const

async function readSkill(
  brokerUrl: string,
  capability: string,
  skillId: unknown,
  path: unknown,
  offset: unknown,
): Promise<unknown> {
  if (typeof skillId !== 'string' || typeof path !== 'string') throw new Error('read_skill requires skillId and path.')
  if (offset !== undefined && (!Number.isSafeInteger(offset) || Number(offset) < 0)) {
    throw new Error('read_skill offset must be a non-negative integer.')
  }
  const response = await fetch(brokerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-manor-skill-capability': capability,
    },
    body: JSON.stringify({ skillId, path, ...(offset === undefined ? {} : { offset }) }),
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `Skill reader returned HTTP ${response.status}.`
    throw new Error(message)
  }
  return isRecord(payload) ? payload.result : undefined
}

export function skillMcpServer(argv: readonly string[]): McpToolServer {
  const brokerUrl = option('--broker-url', argv)
  return {
    name: 'manor-skills',
    tools: [tool],
    failureMessage: 'The skill read failed.',
    async callTool(rawName, arguments_, capability) {
      if (rawName !== 'read_skill') throw new Error(`Unknown skill tool ${String(rawName)}.`)
      const result = await readSkill(brokerUrl, capability, arguments_.skillId, arguments_.path, arguments_.offset)
      return [{ type: 'text', text: JSON.stringify(result) }]
    },
  }
}
