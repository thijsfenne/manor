import type { ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { replyLanguageNote, writtenLanguage } from '../src/replyLanguage.js'

const user = (text: string, extra: Partial<Extract<ThreadEvent, { type: 'user_message' }>> = {}): ThreadEvent =>
  ({ type: 'user_message', id: `evt_${text.length}`, ts: 1, text, mentions: [], ...extra })
const agent = (text: string, turnId = 'turn_old'): ThreadEvent => ({ type: 'agent_message', id: 'evt_a', ts: 2, agentId: 'robin', turnId, text })
const DUTCH_NOTE = '[Manor] The user wrote Dutch. Reply to them in Dutch, whatever language this result is in.'

describe('writtenLanguage', () => {
  it('reads Dutch, also when it is full of English terms', () => {
    expect(writtenLanguage('Nee, zet hem maar rechtsboven in de toolbar')).toBe('Dutch')
    expect(writtenLanguage('Kunnen we een weekly sync job maken die de release notes voor mij bijhoudt?')).toBe('Dutch')
    expect(writtenLanguage('ja doe maar')).toBe('Dutch')
  })

  it('reads English, and stays unsure on a short message or another language', () => {
    expect(writtenLanguage('Can you check why the build fails on main?')).toBe('English')
    expect(writtenLanguage('ok')).toBeUndefined()
    expect(writtenLanguage('Kannst du mir bitte helfen?')).toBeUndefined()
    expect(writtenLanguage('Pouvez-vous créer une routine de sauvegarde ?')).toBeUndefined()
    expect(writtenLanguage('¿Puedes crear una rutina de copia de seguridad?')).toBeUndefined()
    expect(writtenLanguage('Je prépare le dossier, je partagerai le résultat demain.')).toBeUndefined()
    for (const other of ['Kan du slå det op?', 'Kan du berätta om ändringen?', 'Ja, das ist ja genau der Fehler.',
      '¿Dónde van los archivos que dan error?', 'Peux-tu vérifier qui met à jour le fichier et qui le met en ligne ?']) {
      expect(writtenLanguage(other)).toBeUndefined()
    }
  })

  it('does not count words inside code or links', () => {
    expect(writtenLanguage('fix `if the and you` https://example.com/the/and/you')).toBeUndefined()
  })
})

describe('replyLanguageNote', () => {
  it('names Dutch from the message that started the turn', () => {
    expect(replyLanguageNote([agent('Done.'), user('Nee, zet hem maar rechtsboven in de toolbar')], 'turn_now')).toBe(DUTCH_NOTE)
  })

  it('quotes the opening words when the language is unclear', () => {
    expect(replyLanguageNote([user('Kannst du mir bitte helfen?')], 'turn_now'))
      .toBe('[Manor] Reply to the user in the language of their message ("Kannst du mir bitte helfen?"), whatever language this result is in.')
  })

  it('stays silent for English, and for a turn the user did not type', () => {
    expect(replyLanguageNote([user('Can you check why the build fails?')], 'turn_now')).toBeUndefined()
    expect(replyLanguageNote([user('Zet het maar in de toolbar'), user('Weekly scan', { source: 'routine' })], 'turn_now')).toBeUndefined()
  })

  it('reads only the running turn: an earlier answered message or a queued one does not count', () => {
    expect(replyLanguageNote([user('Zet het maar in de toolbar'), agent('Gedaan.')], 'turn_now')).toBeUndefined()
    expect(replyLanguageNote([user('Zet het maar in de toolbar'), agent('Eerst dit.', 'turn_now')], 'turn_now')).toBe(DUTCH_NOTE)
    expect(replyLanguageNote([user('Zet het maar in de toolbar'), user('And then ship it to the team', { dispatchState: 'pending' })], 'turn_now'))
      .toBe(DUTCH_NOTE)
  })

  it('looks past a message a project thread sent on after the user', () => {
    expect(replyLanguageNote([user('Kun jij dit voor mij oppakken?'), user('Report from a Session', { source: 'project_thread' })], 'turn_now'))
      .toBe(DUTCH_NOTE)
  })
})
