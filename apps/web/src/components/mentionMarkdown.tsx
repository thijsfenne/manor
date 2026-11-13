import type { AgentConfig, InlineQuote, SkillConfig } from '@manor/contracts'
import type { ComponentProps } from 'react'
import type { Components } from 'react-markdown'
import { remarkAgentMentions, remarkMessageChips, remarkSoftBreaks, shieldFileChips, shieldMessageRefs } from '../mentions'
import type { Markdown } from './Markdown'
import { AgentChip, DestinationChip, FileChip, ImageRefChip, QuoteRefChip, SkillChip } from './MentionText'
import type { GalleryImage } from './ui/ZoomableImage'

type RemarkPlugins = ComponentProps<typeof Markdown>['plugins']

/**
 * The seam `Markdown` asks for, filled with mention chips. Both halves keep their
 * identity while the roster does (the React Compiler memoizes them): the live turn
 * re-renders per delta, and a fresh plugin array on each one would re-parse the whole
 * reply instead of only the text that grew.
 */
export function useAgentMentions(agents: readonly AgentConfig[]): {
  plugins: RemarkPlugins
  components: Components
} {
  'use memo'
  const plugins: RemarkPlugins = [remarkAgentMentions(agents)]
  const components = chipComponents(agents, [], NO_IMAGES, NO_QUOTES)
  return { plugins, components }
}

const NO_IMAGES: readonly GalleryImage[] = []
const NO_QUOTES: MessageQuotes = { quotes: [], showAuthor: false }

/** A message's own quotes, and what the room lets their pills say about the source. */
export interface MessageQuotes {
  quotes: readonly InlineQuote[]
  showAuthor: boolean
  onOpenSource?: (eventId: string) => void
}

/**
 * The same seam for a message the user wrote: every chip the composer offered, and their
 * single newlines kept as line breaks. `images` are the pictures the message carries,
 * which its `[Image #n]` references open; `quotes` are what its `[Quote #n]` pills hold.
 */
export function useMessageChips(text: string, agents: readonly AgentConfig[], skills: readonly SkillConfig[], images: readonly GalleryImage[] = NO_IMAGES, quotes: MessageQuotes = NO_QUOTES): {
  markdown: string
  plugins: RemarkPlugins
  components: Components
} {
  'use memo'
  const shielded = shieldFileChips(shieldMessageRefs(text, images.length, quotes.quotes.length), agents)
  const plugins: RemarkPlugins = [remarkMessageChips(agents, skills, shielded.files, images.length, quotes.quotes), remarkSoftBreaks]
  const components = chipComponents(agents, skills, images, quotes)
  return { markdown: shielded.text, plugins, components }
}

function chipComponents(agents: readonly AgentConfig[], skills: readonly SkillConfig[], images: readonly GalleryImage[], { quotes, showAuthor, onOpenSource }: MessageQuotes): Components {
  const byName = new Map(agents.map((agent) => [agent.name.toLowerCase(), agent]))
  const bySkillId = new Map(skills.map((skill) => [skill.id, skill]))
  return {
    // Two kinds of span reach this: the chip plugin's, and the word wrappers a live
    // reply is split into. Anything that is not a chip is handed back with its own
    // props, or the reveal would lose the class that animates it on the way through
    // here. `node` is react-markdown's own and is not a DOM attribute.
    span: ({ children, node: _node, ...props }) => {
      const data = props as Record<string, unknown>
      const read = (key: string) => typeof data[key] === 'string' ? data[key] : undefined
      const agent = byName.get(read('data-mention')?.toLowerCase() ?? '')
      if (agent !== undefined) return <AgentChip agent={agent} />
      const skill = bySkillId.get(read('data-skill') ?? '')
      if (skill !== undefined) return <SkillChip skill={skill} />
      const file = read('data-file')
      if (file !== undefined) return <FileChip path={file} />
      const image = Number(read('data-image'))
      if (Number.isInteger(image) && image >= 1 && image <= images.length) return <ImageRefChip number={image} images={images} />
      const number = Number(read('data-quote'))
      const quote = quotes[number - 1]
      if (quote !== undefined) return <QuoteRefChip number={number} quote={quote} sent={{ agents, showAuthor, ...(onOpenSource === undefined ? {} : { onOpenSource }) }} />
      const destination = read('data-destination')
      if (destination === 'browser' || destination === 'computer' || destination === 'work') return <DestinationChip kind={destination} />
      return <span {...props}>{children}</span>
    },
  }
}
