import { probeMcpServer, estimateEagerTokens } from './probe.js'
import { mailMcpDraft } from './mailAttachment.js'

/**
 * Proves the mail connector against the real mailbox, the way a driver would: spawn
 * it over stdio, handshake, list tools, then run one real search and one real read.
 *
 * Unit tests cover the parsing; only this can tell you the credential works, the
 * folder names are right, and a body actually comes back as text. Run it after
 * setting the four env keys and before trusting the connector in a chat.
 *
 *   pnpm --filter @manor/server smoke:mail "from:someone newer_than:30d"
 */

const query = process.argv[2] ?? 'newer_than:7d'
/** Generous: a cold IMAP connect plus a search over all mail is seconds, not minutes. */
const REQUEST_TIMEOUT_MS = 60_000

async function main(): Promise<void> {
  const draft = mailMcpDraft()
  const probe = await probeMcpServer(draft)
  process.stdout.write(
    `tools: ${probe.tools.join(', ')}\n` +
      `schema cost: ${probe.schemaChars} chars, about ${estimateEagerTokens(probe.schemaChars)} input tokens ` +
      'per persona per turn\n\n',
  )

  const { spawn } = await import('node:child_process')
  const { childProcessEnv } = await import('../childEnv.js')
  const child = spawn(draft.command, [...draft.args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: childProcessEnv(process.env, draft.envKeys),
  })
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const replies = new Map<number, (value: unknown) => void>()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown }
        if (typeof message.id === 'number') replies.get(message.id)?.(message.result)
      } catch {
        /* banners are not protocol */
      }
    }
  })
  // A diagnostic that hangs when the thing it diagnoses is broken is worse than no
  // diagnostic: the first real run of this script sat silent for four minutes on a
  // mailbox that could not be opened. Every request is bounded and says which call
  // stopped answering.
  const request = (id: number, method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        replies.delete(id)
        reject(new Error(`${method} did not answer within ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)
      replies.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })

  const text = (result: unknown): string => {
    const content = (result as { content?: { text?: string }[] } | undefined)?.content ?? []
    return content.map((item) => item.text ?? '').join('')
  }

  // The server outlives an exception otherwise. A failed credential makes mail_search
  // answer with an error string, `JSON.parse` throws on it, and the child is left
  // holding an open IMAP connection with nothing reading it.
  try {
    await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'manor-mail-smoke', version: '0' },
    })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    const searched = await request(2, 'tools/call', { name: 'mail_search', arguments: { query, limit: 5 } })
    const searchPayload = text(searched)
    process.stdout.write(`mail_search "${query}" -> ${searchPayload.length} chars\n${searchPayload}\n\n`)

    let hits: { messages?: { uid: number }[] }
    try {
      hits = JSON.parse(searchPayload) as { messages?: { uid: number }[] }
    } catch {
      // The tool answered, it just did not answer with a result. That text is the
      // diagnosis, so say so plainly instead of failing on the parse.
      throw new Error(`mail_search returned an error rather than results: ${searchPayload.trim()}`)
    }

    const first = hits.messages?.[0]?.uid
    if (first === undefined) {
      process.stdout.write('no messages matched, so mail_read was not exercised\n')
      return
    }
    const readResult = await request(3, 'tools/call', { name: 'mail_read', arguments: { uids: [first] } })
    const readPayload = text(readResult)
    process.stdout.write(`mail_read [${first}] -> ${readPayload.length} chars\n${readPayload.slice(0, 1_500)}\n`)
  } finally {
    child.kill('SIGTERM')
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`[manor-mail-smoke] ${error instanceof Error ? error.message : 'failed'}\n`)
  process.exitCode = 1
})
