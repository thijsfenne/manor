import type { ClientMessage, ServerMessage } from '@manor/contracts'
import type { MyMindClient, MyMindListing } from './mymind.js'

const LISTING_TTL_MS = 5 * 60_000

type MyMindMessage = Extract<
  ClientMessage,
  { type: 'list_mymind_objects' | 'load_more_mymind_objects' | 'verify_mymind' }
>

interface MyMindListingSession {
  query: string
  pages: AsyncGenerator<MyMindListing>
  loading: boolean
  timer?: ReturnType<typeof setTimeout>
}

interface MyMindModuleOptions {
  client?: MyMindClient
  problem?: string
  hostEnv?: NodeJS.ProcessEnv
  broadcast: (message: ServerMessage) => void
}

/**
 * Owns the mymind connector lifecycle. Callers see capability status and three
 * protocol commands while pagination, expiry, verification and errors stay inside.
 */
export class MyMindModule {
  private check: { checkedAt: string; result: 'verified' | 'failed' } | null = null
  private readonly listings = new Map<string, MyMindListingSession>()

  constructor(private readonly options: MyMindModuleOptions) {}

  status(): ServerMessage {
    const env = this.options.hostEnv ?? process.env
    return {
      type: 'mymind_status',
      available: this.options.client !== undefined,
      env: ['MANOR_MYMIND_KEY_ID', 'MANOR_MYMIND_SECRET'].map((key) => ({
        key,
        present: Boolean(env[key]),
      })),
      problem: this.options.problem ?? null,
      check: this.check,
    }
  }

  async handle(message: MyMindMessage, reply: (message: ServerMessage) => void): Promise<void> {
    switch (message.type) {
      case 'list_mymind_objects': {
        const client = this.options.client
        if (client === undefined) {
          reply({
            type: 'mymind_objects',
            requestId: message.requestId,
            query: message.query,
            append: false,
            result: { status: 'error', message: 'This Manor has no mymind access key.' },
          })
          return
        }
        if (message.cancelRequestId !== undefined) this.closeListing(message.cancelRequestId)
        const session = { query: message.query, pages: client.list(message.query), loading: false }
        this.listings.set(message.requestId, session)
        await this.sendPage(message.requestId, false, reply)
        return
      }
      case 'load_more_mymind_objects':
        if (!this.listings.has(message.requestId)) {
          reply({
            type: 'mymind_objects',
            requestId: message.requestId,
            query: '',
            append: true,
            result: { status: 'error', message: 'This artifact stream expired. Reload the artifacts to continue.' },
          })
          return
        }
        await this.sendPage(message.requestId, true, reply)
        return
      case 'verify_mymind': {
        const client = this.options.client
        if (client === undefined) {
          reply({
            type: 'notice',
            kind: 'error',
            text: this.options.problem ?? 'Set both mymind environment keys, then restart Manor.',
          })
          return
        }
        try {
          await client.verify()
          this.check = { checkedAt: new Date().toISOString(), result: 'verified' }
          this.options.broadcast(this.status())
          reply({ type: 'notice', kind: 'info', text: 'mymind verified through its read-only Spaces endpoint.' })
        } catch (error: unknown) {
          this.check = { checkedAt: new Date().toISOString(), result: 'failed' }
          this.options.broadcast(this.status())
          reply({
            type: 'notice',
            kind: 'error',
            text: `mymind could not be verified: ${error instanceof Error ? error.message : 'connection failed'}`,
          })
        }
        return
      }
    }
  }

  private closeListing(requestId: string): void {
    const session = this.listings.get(requestId)
    if (session === undefined) return
    this.listings.delete(requestId)
    if (session.timer !== undefined) clearTimeout(session.timer)
    void session.pages.return(undefined).catch(() => undefined)
  }

  private keepListing(requestId: string, session: MyMindListingSession): void {
    if (session.timer !== undefined) clearTimeout(session.timer)
    session.timer = setTimeout(() => this.closeListing(requestId), LISTING_TTL_MS)
    session.timer.unref?.()
  }

  private async sendPage(
    requestId: string,
    append: boolean,
    reply: (message: ServerMessage) => void,
  ): Promise<void> {
    const session = this.listings.get(requestId)
    if (session === undefined || session.loading) return
    session.loading = true
    this.keepListing(requestId, session)
    try {
      const next = await session.pages.next()
      if (this.listings.get(requestId) !== session) return
      const page = next.value
      if (next.done || page === undefined) {
        reply({
          type: 'mymind_objects',
          requestId,
          query: session.query,
          append,
          result: { status: 'ready', objects: [], spaces: [], hasMore: false },
        })
        this.closeListing(requestId)
        return
      }
      reply({ type: 'mymind_objects', requestId, query: session.query, append, result: { status: 'ready', ...page } })
      if (!page.hasMore) this.closeListing(requestId)
    } catch (error: unknown) {
      if (this.listings.get(requestId) !== session) return
      reply({
        type: 'mymind_objects',
        requestId,
        query: session.query,
        append,
        result: {
          status: 'error',
          message: error instanceof Error ? error.message : 'mymind could not load the artifacts.',
        },
      })
      this.closeListing(requestId)
    } finally {
      if (this.listings.get(requestId) === session) session.loading = false
    }
  }
}
