import { z } from 'zod'

// Slack's composer formatting, without arbitrary interactive Block Kit payloads.
const style = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  strike: z.boolean().optional(),
  code: z.boolean().optional(),
}).strict()
const text = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(20_000),
  style: style.optional(),
}).strict()
const link = z.object({
  type: z.literal('link'),
  url: z.string().max(3_000).url().refine((value) => /^(https?:|mailto:)/i.test(value)),
  text: z.string().min(1).max(20_000).optional(),
  style: style.optional(),
}).strict()
// `name` is Manor's display label for the card; Slack's schema rejects it, so posting strips it.
const user = z.object({
  type: z.literal('user'),
  user_id: z.string().regex(/^[UW][A-Z0-9]{2,20}$/),
  name: z.string().min(1).max(200).optional(),
  // Slack's user element takes no code style.
  style: style.omit({ code: true }).optional(),
}).strict()
export const SlackRichTextInlineSchema = z.discriminatedUnion('type', [text, link, user])
const section = z.object({
  type: z.literal('rich_text_section'),
  elements: z.array(SlackRichTextInlineSchema).min(1).max(1_000),
}).strict()
const document = z.object({
  type: z.literal('rich_text'),
  elements: z.array(z.discriminatedUnion('type', [
    section,
    z.object({
      type: z.literal('rich_text_list'),
      style: z.enum(['bullet', 'ordered']),
      indent: z.number().int().min(0).max(8).optional(),
      offset: z.number().int().min(0).max(20_000).optional(),
      elements: z.array(section).min(1).max(1_000),
    }).strict(),
    z.object({
      type: z.literal('rich_text_quote'),
      elements: z.array(SlackRichTextInlineSchema).min(1).max(1_000),
    }).strict(),
    z.object({
      type: z.literal('rich_text_preformatted'),
      elements: z.array(text.omit({ style: true })).min(1).max(1_000),
    }).strict(),
  ])).min(1).max(1_000),
}).strict()

export type SlackRichText = z.infer<typeof document>
export type SlackRichTextInline = z.infer<typeof SlackRichTextInlineSchema>

const mentionPattern = /<@([UW][A-Z0-9]{2,20})(?:\|([^<>|]{1,200}))?>/g
/** Slack's `<@U…>` / `<@U…|name>` syntax, split so a mention can become a real user run. */
export function splitSlackMentions(value: string): ({ text: string } | { user_id: string; name?: string })[] {
  const parts: ({ text: string } | { user_id: string; name?: string })[] = []
  let last = 0
  for (const match of value.matchAll(mentionPattern)) {
    if (match.index > last) parts.push({ text: value.slice(last, match.index) })
    parts.push({ user_id: match[1]!, ...(match[2]?.trim() ? { name: match[2].trim() } : {}) })
    last = match.index + match[0].length
  }
  if (last < value.length) parts.push({ text: value.slice(last) })
  return parts
}

export const slackMentionLabel = (item: Extract<SlackRichTextInline, { type: 'user' }>) => `@${item.name ?? item.user_id}`

/** The block exactly as Slack's API accepts it: Manor-only mention labels removed. */
export function slackRichTextForPost(value: SlackRichText): SlackRichText {
  const strip = <T extends SlackRichTextInline | { type: 'text'; text: string }>(elements: T[]) =>
    elements.map((item) => item.type === 'user' ? { type: 'user' as const, user_id: item.user_id, ...(item.style ? { style: item.style } : {}) } : item)
  return {
    type: 'rich_text',
    elements: value.elements.map((element) => element.type === 'rich_text_list'
      ? { ...element, elements: element.elements.map((section) => ({ ...section, elements: strip(section.elements) })) }
      : element.type === 'rich_text_preformatted' ? element : { ...element, elements: strip(element.elements) }),
  }
}

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
// A user element has no code key at all, not even `code: false`.
const userStyle = ({ code: _code, ...rest }: Json) => rest
// Agents write `<@U…>` inside text; in a rich_text block Slack shows that literally.
// Inline code stays literal, so a code sample never tags anyone.
const tagMentions = (elements: unknown) => Array.isArray(elements) ? elements.flatMap((item: unknown) =>
  isJson(item) && item['type'] === 'text' && typeof item['text'] === 'string' && item['text'].includes('<@')
    && !(isJson(item['style']) && item['style']['code'] === true)
    ? splitSlackMentions(item['text']).map((part) => 'text' in part
      ? { ...item, text: part.text }
      : { type: 'user', ...part, ...(isJson(item['style']) ? { style: userStyle(item['style']) } : item['style'] === undefined ? {} : { style: item['style'] }) })
    : [item]) : elements
const normalizeMentions = (value: unknown) => {
  if (!isJson(value) || !Array.isArray(value['elements'])) return value
  return {
    ...value,
    elements: value['elements'].map((element: unknown) => {
      if (!isJson(element)) return element
      if (element['type'] === 'rich_text_section' || element['type'] === 'rich_text_quote') return { ...element, elements: tagMentions(element['elements']) }
      if (element['type'] === 'rich_text_list' && Array.isArray(element['elements'])) {
        return { ...element, elements: element['elements'].map((section: unknown) => isJson(section) ? { ...section, elements: tagMentions(section['elements']) } : section) }
      }
      return element
    }),
  }
}

/** Text fallback for notifications, search and clients without the editor. */
export function slackRichTextFallback(value: SlackRichText): string {
  const inline = (elements: SlackRichTextInline[]) => elements.map((element) =>
    element.type === 'text' ? element.text : element.type === 'user' ? slackMentionLabel(element) : element.text === undefined || element.text === element.url
      ? element.url : `${element.text} (${element.url})`,
  ).join('')
  return value.elements.map((element) => {
    if (element.type === 'rich_text_list') {
      return element.elements.map((item, index) => {
        const prefix = '  '.repeat(element.indent ?? 0)
          + (element.style === 'bullet' ? '• ' : `${(element.offset ?? 0) + index + 1}. `)
        return prefix + inline(item.elements).replace(/\n/g, `\n${' '.repeat(prefix.length)}`)
      }).join('\n')
    }
    const content = inline(element.elements)
    return element.type === 'rich_text_quote' ? content.replace(/^/gm, '> ') : content
  }).join('\n')
}

// Bound the complete document, not just each text node. No silent truncation.
export const SlackRichTextSchema = z.preprocess(normalizeMentions, document).superRefine((value, context) => {
  const fallback = slackRichTextFallback(value)
  const hasContent = value.elements.some((element) => {
    const sections = element.type === 'rich_text_list' ? element.elements : [element]
    return sections.some((section) => section.elements.some((item) =>
      item.type !== 'text' || item.text.trim().length > 0,
    ))
  })
  if (!hasContent || fallback.length > 20_000 || JSON.stringify(value).length > 100_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Slack rich text must contain text and fit the draft limits.' })
  }
})
