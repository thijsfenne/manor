import type { AttachedMcpServer } from '@manor/contracts'
import { ARTIFACT_TOOL_NAMES } from '../artifactBroker.js'

export const ARTIFACT_BROKER_CAPABILITY_ENV = 'MANOR_ARTIFACT_BROKER_CAPABILITY'
export const BUILT_IN_ARTIFACT_MCP_NAME = 'artifacts'

export function artifactMcpAttachment(
  brokerUrl: string,
  capability: string,
): AttachedMcpServer {
  return {
    server: {
      id: 'builtin_artifacts',
      name: BUILT_IN_ARTIFACT_MCP_NAME,
      command: '',
      args: ['--broker-url', brokerUrl],
      envKeys: [],
      description: 'Search the user’s read-only mymind library and inspect selected visual references.',
      writes: false,
      effectPolicy: 'trusted',
      tools: [...ARTIFACT_TOOL_NAMES],
      readOnlyTools: [...ARTIFACT_TOOL_NAMES],
      schemaChars: 0,
    },
    disabledTools: [],
    runtimeEnv: { [ARTIFACT_BROKER_CAPABILITY_ENV]: capability },
  }
}
