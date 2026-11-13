import type { WorkflowSuggestion } from '@manor/contracts'

export function suggestionPrompt(suggestion: WorkflowSuggestion): string {
  return [
    `Let's review workflow suggestion \`${suggestion.id}\`.`,
    '',
    `It is currently **${suggestion.status}**.`,
    '',
    'What it would encode',
    suggestion.description,
    '',
    'Evidence',
    suggestion.occurrences,
    '',
    'Corrections already seen',
    suggestion.corrections,
    '',
    'Existing coverage',
    suggestion.existingCoverage,
    '',
    'First decide whether this should become a skill, automation, template, an update to an existing capability, or be dismissed. Do not build it until we have made that decision.',
  ].join('\n')
}
