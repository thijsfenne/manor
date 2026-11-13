import type { McpServerDraft } from '@manor/contracts'
import { builtInMcpArgs, nodeRuntimeEnvKeys } from './browserAttachment.js'
import { DEFAULT_MAIL_ENV_PREFIX, mailEnvKeys } from './mailMcp.js'

export const MAIL_MCP_NAME = 'mail'

const PERSONAL_DESCRIPTION = 'Search, read and draft in the user’s personal mailbox over IMAP. Cannot send.'

/**
 * The registry row for Manor's own mail connector.
 *
 * A registry row rather than a built-in like the browser, and that difference is the
 * whole point. The browser is a property of the desktop host, identical for every
 * persona, so it attaches unconditionally. Mail is a credential: which personas hold
 * it is a decision the user makes per persona, which is exactly what the registry and
 * its attachment model already express. Making it built-in would hand every persona
 * in the house a key to the mailbox.
 *
 * `writes` is true because mail_draft leaves something behind in the account, even
 * though nothing here can send.
 */
export function mailMcpDraft(
  runtime: { execPath?: string; execArgv?: readonly string[]; entryPath?: string } = {},
): McpServerDraft {
  return {
    name: MAIL_MCP_NAME,
    command: runtime.execPath ?? process.execPath,
    args: [
      ...builtInMcpArgs('mail', runtime),
      `--env-prefix=${DEFAULT_MAIL_ENV_PREFIX}`,
    ],
    envKeys: [...mailEnvKeys(), ...nodeRuntimeEnvKeys()],
    description: PERSONAL_DESCRIPTION,
    writes: true,
    effectPolicy: 'confirm_writes',
  }
}
