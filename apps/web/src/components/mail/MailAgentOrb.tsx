import type { AgentConfig } from '@manor/contracts'
import { accentStyle } from '../../accent'

/** The default agent as a small dot of its own colour, beside what it does in Mail. */
export function MailAgentOrb({ agent }: { agent: AgentConfig | null }) {
  if (agent === null) return null
  return <span aria-hidden="true" className="size-3 flex-none rounded-full bg-[var(--accent)]" style={accentStyle(agent.color)} />
}

/** The square that stands for a linked project. With `named` it carries the name on hover. */
export function MailProjectSquare({ name, color, named = false }: { name: string; color: string; named?: boolean }) {
  return (
    <span className="size-2 flex-none rounded-xs bg-[var(--accent)]" style={accentStyle(color)}
      {...(named ? { title: name, role: 'img', 'aria-label': name } : { 'aria-hidden': true })} />
  )
}
