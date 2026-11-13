import type { SkillConfig } from '@manor/contracts'

/** Same boundary as @mentions. A currency amount or mid-word dollar stays prose. */
const SKILL_TOKEN = /(?<![\p{L}\p{N}_-])\$([a-z0-9][a-z0-9_-]*)/giu

/** Imported skill ids selected in a message, in first-use order and without repeats. */
export function parseSkillInvocations(text: string, skills: readonly SkillConfig[]): string[] {
  const known = new Set(skills.map((skill) => skill.id))
  const seen = new Set<string>()
  const selected: string[] = []
  for (const match of text.matchAll(SKILL_TOKEN)) {
    const id = match[1]?.toLowerCase()
    if (id === undefined || !known.has(id) || seen.has(id)) continue
    seen.add(id)
    selected.push(id)
  }
  return selected
}
