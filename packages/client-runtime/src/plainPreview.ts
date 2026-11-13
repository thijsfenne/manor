/**
 * Markdown flattened to the words underneath it, for the two places a preview is
 * read as plain text: the sidebar row and the system banner. Neither renders
 * Markdown, so the syntax that reaches them is never emphasis; it is literal
 * asterisks in front of the reader ("1. **Middel:**") and a file path swallowed by
 * a link target.
 *
 * Regex rather than a Markdown parser, deliberately. The input is one line already
 * cut short by the store, so it is usually a fragment with a marker whose partner
 * was cut off, and a parser handed that fragment reads structure into it that the
 * author never wrote. Every rule below fires only on a matched pair, so a glob
 * (`*.ts`), a snake_case identifier and "2 * 3" all pass through untouched; the
 * one exception is the dangling-marker rule at the end, which only removes a marker
 * that provably has no partner left in the string.
 */
export function plainPreview(text: string): string {
  return flattenMarkdown(text).replace(/\s+/g, ' ').trim()
}

/**
 * Same flattening as the sidebar preview, but newlines stay. An outbound draft
 * copied into Gmail or Slack must be words, not Manor markdown or HTML.
 */
export function plainDraftText(text: string): string {
  return flattenMarkdown(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function flattenMarkdown(text: string): string {
  // Markdown autolinks use angle brackets too. Flatten those before removing HTML,
  // otherwise `<https://…>` looks like a tag and loses the URL with the brackets.
  let out = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
  out = out.replace(/<\/?[^>\n]+>/g, '')
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}

const RULES: readonly (readonly [RegExp, string])[] = [
  // Whatever opens the line: heading hashes, a quote arrow, a bullet or a number.
  // Once, not globally, because "1." halfway through a sentence is prose.
  [/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)/, ''],
  // A link keeps its label and drops its target, which in an agent's reply is a
  // machine-length absolute path and the least readable thing in the line. The
  // second rule is the same link with its closing paren cut off by the 120-char
  // preview limit, which is how most of them arrive.
  [/!?\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/!?\[([^\]]*)\]\([^)]*$/, '$1'],
  [/`{1,3}([^`]+)`{1,3}/g, '$1'],
  [/\*\*\*(?=\S)([^*]*[^*\s])\*\*\*/g, '$1'],
  [/\*\*(?=\S)([^*]*[^*\s])\*\*/g, '$1'],
  [/\*(?=\S)([^*]*[^*\s])\*/g, '$1'],
  [/~~(?=\S)([^~]*[^~\s])~~/g, '$1'],
  // Underscores need the word boundary that asterisks do not: without it the middle
  // of `snake_case_name` is a perfectly good italic run.
  [/(?<![\p{L}\p{N}_])__(?=\S)([^_]*[^_\s])__(?![\p{L}\p{N}_])/gu, '$1'],
  [/(?<![\p{L}\p{N}_])_(?=\S)([^_]*[^_\s])_(?![\p{L}\p{N}_])/gu, '$1'],
  // An opener with no marker of its own kind left before the end of the line: its
  // partner was cut off by the preview limit, so nothing above could pair it. Only
  // the unambiguous doubles and the backtick, never a lone `*` or `_`, which carry
  // their own meaning in prose.
  [/(?:\*\*|~~|`)(?=[^*_~`]*$)/g, ''],
  [/(?<![\p{L}\p{N}_])__(?=[^*_~`]*$)/gu, ''],
]
