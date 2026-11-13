import type { AgentDraft, SkillConfig } from '@manor/contracts'
import { formFieldClass, formHintClass, formLabelClass } from '../ui/FormField'
import { Pill } from '../ui/Pill'

interface SkillsSectionProps {
  draft: AgentDraft
  skills: SkillConfig[]
  onChange: (skillIds: string[]) => void
}

/** Eligibility only. A checked skill costs no context until the user invokes it with `$`. */
export function SkillsSection({ draft, skills, onChange }: SkillsSectionProps) {
  const held = new Set(draft.skillIds ?? [])
  const toggle = (skillId: string) => {
    const next = new Set(held)
    if (next.has(skillId)) next.delete(skillId)
    else next.add(skillId)
    onChange(skills.filter((skill) => next.has(skill.id)).map((skill) => skill.id))
  }

  if (skills.length === 0) {
    return (
      <div className={formFieldClass}>
        <span className={formLabelClass}>Skills</span>
        <span className={formHintClass}>None imported yet. Import one under Plugins → Skills to make it attachable here.</span>
      </div>
    )
  }

  return (
    <div className={formFieldClass}>
      <span className={formLabelClass}>Skills</span>
      {/* The same pills as the toolset above: this is the same kind of decision, a
          set of names that are each on or off. The descriptions were never what was
          being picked, so they are one hover away rather than thirty rows tall. */}
      <div className="flex flex-wrap gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-2.5">
        {skills.map((skill) => (
          <Pill
            key={skill.id}
            label={skill.name}
            on={held.has(skill.id)}
            hint={
              <span className="flex flex-col gap-1">
                <span className="font-mono text-meta text-text">${skill.id}</span>
                <span>
                  {skill.description || 'No description. What it does is whatever its SKILL.md says, unannounced.'}
                </span>
              </span>
            }
            onToggle={() => toggle(skill.id)}
          />
        ))}
      </div>
    </div>
  )
}
