import { describe, expect, it } from 'vitest'
import { plainDraftText, plainPreview } from '@manor/client-runtime/plain-preview'

describe('plainPreview', () => {
  it('drops emphasis markers and keeps the words', () => {
    expect(plainPreview('Twee findings. 1. **Middel — defect:** de check mist')).toBe(
      'Twee findings. 1. Middel — defect: de check mist',
    )
    expect(plainPreview('dat was *snel* en ~~fout~~ en `groen`')).toBe('dat was snel en fout en groen')
    expect(plainPreview('__helemaal__ klaar')).toBe('helemaal klaar')
  })

  it('keeps a link label and drops its target', () => {
    expect(plainPreview('zie [askFlow.ts:71](/Users/sam/app/askFlow.ts) hierboven')).toBe(
      'zie askFlow.ts:71 hierboven',
    )
    expect(plainPreview('![grafiek](/tmp/plot.png) staat klaar')).toBe('grafiek staat klaar')
    expect(plainPreview('mail <https://manor.test/x> door')).toBe('mail https://manor.test/x door')
  })

  it('cleans up what the preview cut in half', () => {
    expect(plainPreview('twee findings. 1. **Middel:** [askFlow.ts:71](/Users/')).toBe(
      'twee findings. 1. Middel: askFlow.ts:71',
    )
    expect(plainPreview('hij zei **let op')).toBe('hij zei let op')
  })

  it('leaves prose that only looks like Markdown alone', () => {
    expect(plainPreview('verwijderd: *.ts en *.tsx')).toBe('verwijderd: *.ts en *.tsx')
    expect(plainPreview('kolom last_message_preview is leeg')).toBe('kolom last_message_preview is leeg')
    expect(plainPreview('2 * 3 = 6')).toBe('2 * 3 = 6')
    // A word wrapped in underscores is bold to Markdown itself, so it reads as bold
    // here too; only an identifier that carries them internally survives.
    expect(plainPreview('een __init__ in snake_case_name')).toBe('een init in snake_case_name')
  })

  it('strips the marker that opens a line, and collapses the whitespace', () => {
    expect(plainPreview('## Klaar\nalles groen')).toBe('Klaar alles groen')
    expect(plainPreview('- eerste punt')).toBe('eerste punt')
    expect(plainPreview('1. eerste punt')).toBe('eerste punt')
    expect(plainPreview('> geciteerd')).toBe('geciteerd')
    expect(plainPreview('  \n\n  ')).toBe('')
  })
})

describe('plainDraftText', () => {
  it('strips markdown and HTML but keeps newlines', () => {
    expect(plainDraftText('Hello **Ada**\n\nSee <b>you</b> Thursday.')).toBe('Hello Ada\n\nSee you Thursday.')
  })
})
