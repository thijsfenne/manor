import { z } from 'zod'

/**
 * The Mail door: a triage place for the user's Inbox, not a mail client. The host reads
 * the mailbox over IMAP and keeps a small disposable cache; the IMAP server stays the
 * truth. Labels and project links are local to Manor and never written to the mailbox.
 * The only mailbox write is the user's own Archive, and the only send is the user's Send.
 */

/**
 * The triage labels. Keys `1` to `4` set them in this order. `other` holds newsletters,
 * promotions and automated notices: it has no tab and shows only in a search.
 */
export const MAIL_LABELS = ['reply', 'wait', 'fyi', 'other'] as const
export const MailLabelSchema = z.enum(MAIL_LABELS)
export type MailLabel = z.infer<typeof MailLabelSchema>

/** The labels that have a tab, in tab order. */
export const MAIL_TAB_LABELS = ['reply', 'wait', 'fyi'] as const satisfies readonly MailLabel[]

export const MAIL_LABEL_NAME: Record<MailLabel, string> = {
  reply: 'Needs reply',
  wait: 'Waiting',
  fyi: 'FYI',
  other: 'Other',
}

/** One line, shown as the label's tooltip. */
export const MAIL_REASON_MAX = 160
export const MAIL_THREAD_ID_MAX = 200
/** Plain text kept per message; longer mail is cut and marked `truncated`. */
export const MAIL_MESSAGE_TEXT_MAX = 20_000
/** A message's HTML part travels whole or not at all; a longer one is left out and the text stands in. */
export const MAIL_MESSAGE_HTML_MAX = 300_000
/** HTML of one thread on the wire, spent on the newest messages first. */
export const MAIL_THREAD_HTML_MAX = 1_200_000
export const MAIL_THREAD_MESSAGES_MAX = 50
/** The recent Inbox window the cache holds. */
export const MAIL_INBOX_WINDOW = 200
export const MAIL_INSTRUCTION_MAX = 2_000
export const MAIL_DRAFT_BODY_MAX = 20_000
export const MAIL_RECIPIENTS_MAX = 400
/** What Add to chat carries along; the preview shows exactly this text. */
export const MAIL_CONTEXT_TEXT_MAX = 6_000

const MailThreadIdSchema = z.string().min(1).max(MAIL_THREAD_ID_MAX)

export const MailAddressSchema = z.object({
  /** Display name, empty when the header carried only an address. */
  name: z.string().max(400),
  address: z.string().max(400),
})
export type MailAddress = z.infer<typeof MailAddressSchema>

/** One thread in the sidebar: the newest Inbox message stands for it. */
export const MailCardSchema = z.object({
  threadId: MailThreadIdSchema,
  subject: z.string().max(1_000),
  from: MailAddressSchema,
  /** Milliseconds since the epoch of the newest message. */
  at: z.number().int(),
  /** Unread on the server and not yet opened here. Opening never marks it read on the server. */
  unread: z.boolean(),
  messageCount: z.number().int().min(1),
  label: MailLabelSchema.optional(),
  /** Why the label was given, one line. Absent on a label the user set. */
  reason: z.string().max(MAIL_REASON_MAX).optional(),
  /** The project linked to this sender, when there is one. */
  projectId: z.string().optional(),
})
export type MailCard = z.infer<typeof MailCardSchema>

export const MailMessageSchema = z.object({
  id: z.string().min(1).max(200),
  from: MailAddressSchema,
  to: z.array(MailAddressSchema).max(100),
  cc: z.array(MailAddressSchema).max(100),
  at: z.number().int(),
  /** The text part, or HTML stripped to text on the host. This is all an agent ever reads of a mail. */
  text: z.string().max(MAIL_MESSAGE_TEXT_MAX),
  /**
   * The message's own HTML part as the sender wrote it, absent when it has none or it is
   * over the cap. Untrusted: a client draws it only in a sandboxed frame without scripts.
   */
  html: z.string().max(MAIL_MESSAGE_HTML_MAX).optional(),
  truncated: z.boolean(),
  attachments: z.array(z.object({ name: z.string().max(400), kb: z.number().int().min(0) })).max(50),
  /** Sent by the mailbox's own account. */
  mine: z.boolean(),
})
export type MailMessage = z.infer<typeof MailMessageSchema>

export const MailThreadSchema = z.object({
  threadId: MailThreadIdSchema,
  subject: z.string().max(1_000),
  /** Oldest first. */
  messages: z.array(MailMessageSchema).max(MAIL_THREAD_MESSAGES_MAX),
  /** Where a reply goes by default: the newest sender that is not the account itself. */
  reply: z.object({
    to: z.string().max(MAIL_RECIPIENTS_MAX),
    cc: z.string().max(MAIL_RECIPIENTS_MAX),
    subject: z.string().max(1_000),
  }),
})
export type MailThread = z.infer<typeof MailThreadSchema>

export const MailTriageStateSchema = z.object({
  /** When the last triage run finished, or null when none has. */
  lastRunAt: z.number().int().nullable(),
  running: z.boolean(),
  /** Why the last run failed, cleared by the next good one. */
  error: z.string().max(400).optional(),
})
export type MailTriageState = z.infer<typeof MailTriageStateSchema>

/** Client to server. Spread into the wire union in `index.ts`. */
export const MailClientMessageSchemas = [
  // Answers the asker with the cached `mail_state` at once. With `refresh` the host then
  // polls the mailbox, broadcasts the fresh state and labels the mail that is new to it.
  // The Mail view sends it when it opens and on focus.
  z.object({ type: z.literal('mail_load'), refresh: z.boolean().optional() }),
  // Reads one thread, answered with `mail_thread`. Never marks it read.
  z.object({ type: z.literal('mail_open'), requestId: z.string().min(1).max(120), threadId: MailThreadIdSchema }),
  z.object({ type: z.literal('mail_set_label'), threadId: MailThreadIdSchema, label: MailLabelSchema }),
  // Links every mail from this sender to a project, or removes the link with null.
  z.object({ type: z.literal('mail_link_sender'), address: z.string().min(3).max(400), projectId: z.string().nullable() }),
  // The user's own mailbox write, answered with `mail_result`. Unarchive is its Undo.
  z.object({ type: z.literal('mail_archive'), requestId: z.string().min(1).max(120), threadId: MailThreadIdSchema }),
  z.object({ type: z.literal('mail_unarchive'), requestId: z.string().min(1).max(120), threadId: MailThreadIdSchema }),
  z.object({ type: z.literal('mail_triage_run') }),
  // Streams a reply draft from the default agent as `mail_draft` messages to the asker.
  // `instruction` with `current` asks for a new version of the text in the draft pane.
  z.object({
    type: z.literal('mail_draft_start'),
    draftId: z.string().min(1).max(120),
    threadId: MailThreadIdSchema,
    instruction: z.string().max(MAIL_INSTRUCTION_MAX).optional(),
    current: z.string().max(MAIL_DRAFT_BODY_MAX).optional(),
  }),
  z.object({ type: z.literal('mail_draft_stop'), draftId: z.string().min(1).max(120) }),
  // The user's Send, answered with `mail_result`. The subject is the thread's own.
  z.object({
    type: z.literal('mail_send'),
    requestId: z.string().min(1).max(120),
    threadId: MailThreadIdSchema,
    to: z.string().min(3).max(MAIL_RECIPIENTS_MAX),
    cc: z.string().max(MAIL_RECIPIENTS_MAX).optional(),
    body: z.string().min(1).max(MAIL_DRAFT_BODY_MAX),
  }),
] as const

/** Server to client. Spread into the wire union in `index.ts`. */
export const MailServerMessageSchemas = [
  // `off` means this host has no mailbox configured, so the Mail door stays hidden.
  z.object({
    type: z.literal('mail_state'),
    status: z.enum(['off', 'ready', 'error']),
    /** The mailbox's own address. */
    account: z.string().max(400).optional(),
    /** Why the last poll failed; the cached cards still stand. */
    error: z.string().max(400).optional(),
    /** Inbox threads, newest first. */
    cards: z.array(MailCardSchema).max(MAIL_INBOX_WINDOW),
    syncedAt: z.number().int().nullable(),
    triage: MailTriageStateSchema,
  }),
  z.object({
    type: z.literal('mail_thread'),
    requestId: z.string().min(1).max(120),
    threadId: MailThreadIdSchema,
    result: z.discriminatedUnion('status', [
      z.object({ status: z.literal('ready'), thread: MailThreadSchema }),
      z.object({ status: z.literal('error'), message: z.string().max(400) }),
    ]),
  }),
  // `text` is the whole draft so far, never a delta, so a dropped message costs nothing.
  z.object({
    type: z.literal('mail_draft'),
    draftId: z.string().min(1).max(120),
    threadId: MailThreadIdSchema,
    status: z.enum(['streaming', 'done', 'error']),
    text: z.string().max(MAIL_DRAFT_BODY_MAX),
    message: z.string().max(400).optional(),
  }),
  // The outcome of an archive, an unarchive or a send. `ok` on a send means delivery was
  // confirmed; anything else carries the reason in `message`.
  z.object({
    type: z.literal('mail_result'),
    requestId: z.string().min(1).max(120),
    ok: z.boolean(),
    message: z.string().max(600).optional(),
  }),
] as const

/** The bare address of `Name <address>`, lowercased; undefined when there is none. */
export function mailBareAddress(value: string): string | undefined {
  const address = (/<([^<>]+)>\s*$/.exec(value)?.[1] ?? value).trim().toLowerCase()
  return /^[^@<>\s,]+@[^@<>\s,]+$/.test(address) ? address : undefined
}

/** Every address that wrote or received a message of the thread, lowercased. */
export function mailParticipants(thread: Pick<MailThread, 'messages'>): string[] {
  const seen = new Set<string>()
  for (const message of thread.messages) {
    for (const entry of [message.from, ...message.to, ...message.cc]) {
      const address = mailBareAddress(entry.address)
      if (address !== undefined) seen.add(address)
    }
  }
  return [...seen]
}

/**
 * Recipients of a reply that were not in the original thread, as typed. The draft pane
 * marks each one, because a reply that quietly reaches a stranger is how mail leaks.
 * An entry that is not an address counts as new: it cannot be shown to be known.
 */
export function mailNewRecipients(thread: Pick<MailThread, 'messages'>, to: string, cc = ''): string[] {
  const known = new Set(mailParticipants(thread))
  return [...to.split(','), ...cc.split(',')]
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .filter((entry) => {
      const address = mailBareAddress(entry)
      return address === undefined || !known.has(address)
    })
}

const nameOf = (entry: MailAddress) => entry.name === '' ? entry.address : `${entry.name} <${entry.address}>`

/**
 * The text Add to chat carries into a conversation, and what its preview shows. Cut at
 * `MAIL_CONTEXT_TEXT_MAX` with a visible mark, so the preview never promises more than
 * arrives.
 */
export function mailContextText(thread: MailThread): string {
  const head = thread.messages.at(-1)
  const lines = [
    thread.subject,
    ...(head === undefined ? [] : [nameOf(head.from)]),
    '',
    thread.messages
      .map((message) => `${nameOf(message.from)}, ${new Date(message.at).toISOString().slice(0, 16).replace('T', ' ')} UTC\n${message.text}`)
      .join('\n\n---\n\n'),
  ]
  const text = lines.join('\n')
  const mark = '\n[cut]'
  return text.length <= MAIL_CONTEXT_TEXT_MAX ? text : `${text.slice(0, MAIL_CONTEXT_TEXT_MAX - mark.length)}${mark}`
}
