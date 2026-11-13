import { readBuildInfo, serverFile } from '../serverRoot.js'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { BROWSER_TOOL_NAMES, type AttachedMcpServer } from '@manor/contracts'

export const BROWSER_BROKER_CAPABILITY_ENV = 'MANOR_BROWSER_BROKER_CAPABILITY'

/**
 * The prefix every browser tool wears on both drivers. Reserved against the registry
 * in `service.ts`, because a built-in and a registry row sharing one name is a
 * silently overwritten capability rather than a visible conflict.
 */
export const BUILT_IN_BROWSER_MCP_NAME = 'browser'

/**
 * What a connector server needs in its environment to start with the same runtime as
 * this server. Inside the desktop app that runtime is the app's own binary, which is
 * Node only while `ELECTRON_RUN_AS_NODE` is set; without it the connector would open
 * a second app window instead of serving. Run by a plain Node it is nothing.
 */
export const nodeRuntimeEnvKeys = (env: NodeJS.ProcessEnv = process.env): string[] =>
  env['ELECTRON_RUN_AS_NODE'] === '1' ? ['ELECTRON_RUN_AS_NODE'] : []

/** Keep only Node preload flags needed to execute the TypeScript MCP entrypoint. */
export function inheritedLoaderArgs(execArgv: readonly string[]): string[] {
  const args: string[] = []
  for (let index = 0; index < execArgv.length; index += 1) {
    const flag = execArgv[index]
    if (flag !== '--require' && flag !== '--import') continue
    const value = execArgv[index + 1]
    if (value === undefined) continue
    args.push(flag, value)
    index += 1
  }
  return args
}

export function builtInMcpArgs(
  name: string,
  runtime: { execArgv?: readonly string[]; entryPath?: string } = {},
): string[] {
  // A bundle ships the connector servers compiled, beside its entry file.
  const compiledDir = process.env.MANOR_MCP_COMPILED_DIR ?? (readBuildInfo() === undefined ? undefined : serverFile('mcp'))
  if (compiledDir && runtime.entryPath === undefined) {
    return [resolve(compiledDir, `${name}Mcp.mjs`)]
  }
  return [
    ...inheritedLoaderArgs(runtime.execArgv ?? process.execArgv),
    runtime.entryPath ?? fileURLToPath(new URL(`./${name}Mcp.ts`, import.meta.url)),
  ]
}

/**
 * Built per turn because the chat id and the persona are both capability boundaries.
 * It is not a registry row and cannot be detached from a persona: browser
 * availability is a property of the Manor desktop host, identical for Claude and
 * Codex. The opaque capability resolves to the chat and actor inside the server, so
 * neither can be changed by the MCP process or a shell command in the provider CLI.
 */
export function browserMcpAttachment(
  brokerUrl: string,
  capability: string,
): AttachedMcpServer {
  return {
    server: {
      id: 'builtin_browser',
      name: BUILT_IN_BROWSER_MCP_NAME,
      command: '',
      args: ['--broker-url', brokerUrl],
      envKeys: [],
      description: 'The shared browser visible in the Manor desktop app.',
      writes: true,
      effectPolicy: 'confirm_writes',
      tools: [...BROWSER_TOOL_NAMES],
      readOnlyTools: ['browser_navigate', 'browser_snapshot', 'browser_scroll', 'browser_screenshot', 'browser_tabs'],
      schemaChars: 0,
    },
    disabledTools: [],
    runtimeEnv: { [BROWSER_BROKER_CAPABILITY_ENV]: capability },
  }
}
