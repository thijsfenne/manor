import type { AgentConfig, Project } from '@manor/contracts'

export const hasWorkDestination = (text: string): boolean => /(?:^|\s)@work(?=$|[\s.,!?:;])/iu.test(text)

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const action = `(?:${[
  'werk(?:en|t)?', 'uit\\s+te\\s+werken', 'uitwerk(?:en|t)?', 'bouw(?:en|t)?',
  'maak', 'maken', 'implementeer', 'implementeren', 'voer', 'uitvoeren', 'pak',
  'oppakken', 'onderzoek', 'onderzoeken', 'hand[ -]?off', 'draag', 'overdragen',
  'work', 'develop', 'build', 'make', 'implement', 'execute', 'investigate', 'research',
].join('|')})`

/**
 * Conservative syntax for the one intent Manor must enforce rather than merely
 * suggest: an action assigned into an existing, explicitly named project. Ordinary
 * questions *about* a project deliberately stay ordinary Chat turns.
 */
export function explicitWorkHandoffRequest(
  text: string,
  projects: readonly Project[],
  agents: readonly AgentConfig[],
): boolean {
  if (hasWorkDestination(text)) return true
  const namesProject = projects.some((project) => new RegExp(
    `\\b(?:in|binnen|naar|into|to)\\s+(?:(?:het|the)\\s+)?project\\s+[“"']?${escaped(project.name)}(?:[”"']|\\b)`,
    'iu',
  ).test(text))
  if (!namesProject) return false

  const assignsNamedPersona = agents.some((agent) => new RegExp(
    `\\b(?:laat|vraag|let|have|ask)\\s+@?${escaped(agent.name)}\\b(?:(?!\\b(?:niet|not)\\b)[\\s\\S]){0,160}?\\b${action}\\b`,
    'iu',
  ).test(text))
  if (assignsNamedPersona) return true

  return new RegExp(`(?:^|[.!?]\\s+)(?:please\\s+|graag\\s+)?${action}\\b`, 'iu').test(text)
}
