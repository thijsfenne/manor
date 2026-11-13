import type { AttachedMcpServer } from '@manor/contracts'
import { ROUTINE_TOOL_NAMES } from '../routineTool.js'

export const ROUTINE_BROKER_CAPABILITY_ENV = 'MANOR_ROUTINE_BROKER_CAPABILITY'
export const BUILT_IN_ROUTINE_MCP_NAME = 'routines'

export function routineMcpAttachment(
  brokerUrl: string,
  capability: string,
): AttachedMcpServer {
  return {
    server: {
      id: 'builtin_routines',
      name: BUILT_IN_ROUTINE_MCP_NAME,
      command: '',
      args: ['--broker-url', brokerUrl],
      envKeys: [],
      description: 'List, create, update and cancel routines and one-time reminders in this agent’s direct message.',
      writes: true,
      effectPolicy: 'trusted',
      tools: [...ROUTINE_TOOL_NAMES],
      readOnlyTools: ['list_routines'],
      schemaChars: 0,
    },
    disabledTools: [],
    runtimeEnv: { [ROUTINE_BROKER_CAPABILITY_ENV]: capability },
  }
}
