import type { AttachedMcpServer } from '@manor/contracts'

export const SKILL_READER_CAPABILITY_ENV = 'MANOR_SKILL_READER_CAPABILITY'
export const BUILT_IN_SKILL_MCP_ID = 'builtin_skills'
export const BUILT_IN_SKILL_MCP_NAME = 'skills'

export function skillMcpAttachment(
  brokerUrl: string,
  capability: string,
): AttachedMcpServer {
  return {
    server: {
      id: BUILT_IN_SKILL_MCP_ID,
      name: BUILT_IN_SKILL_MCP_NAME,
      command: '',
      args: ['--broker-url', brokerUrl],
      envKeys: [],
      description: 'Read instructions and supporting text from skills attached to this persona.',
      writes: false,
      effectPolicy: 'trusted',
      tools: ['read_skill'],
      readOnlyTools: ['read_skill'],
      schemaChars: 0,
    },
    disabledTools: [],
    runtimeEnv: { [SKILL_READER_CAPABILITY_ENV]: capability },
  }
}
