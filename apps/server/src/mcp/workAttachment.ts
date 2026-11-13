import type { AttachedMcpServer } from '@manor/contracts'
import { WORK_TOOL_NAME } from '../workTool.js'

export const WORK_BROKER_CAPABILITY_ENV = 'MANOR_WORK_BROKER_CAPABILITY'
export const BUILT_IN_WORK_MCP_NAME = 'work'

export function workMcpAttachment(
  brokerUrl: string,
  capability: string,
): AttachedMcpServer {
  return {
    server: {
      id: 'builtin_work',
      name: BUILT_IN_WORK_MCP_NAME,
      command: '',
      args: ['--broker-url', brokerUrl],
      envKeys: [],
      description: 'Start explicitly requested project work here; this takes priority over in-Chat persona delegation.',
      writes: true,
      effectPolicy: 'trusted',
      tools: [WORK_TOOL_NAME],
      readOnlyTools: [],
      schemaChars: 0,
    },
    disabledTools: [],
    runtimeEnv: { [WORK_BROKER_CAPABILITY_ENV]: capability },
  }
}
