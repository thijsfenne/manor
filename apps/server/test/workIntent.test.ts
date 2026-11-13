import type { Project } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { explicitWorkHandoffRequest, hasWorkDestination } from '../src/workIntent.js'
import { roster } from './helpers.js'

const projects: Project[] = [{
  id: 'project_1',
  name: 'Manor',
  repoPaths: [],
  icon: 'folder',
  color: '#8A8F98',
  memoryScope: 'project',
}]

describe('explicitWorkHandoffRequest', () => {
  it('recognises the destination without requiring a project in the same message', () => {
    for (const text of ['@work Build quote replies', '@work stuur die drie opdrachten los door', 'Doorsturen @Work.']) {
      expect(explicitWorkHandoffRequest(text, [], roster)).toBe(true)
    }
    for (const text of ['name@work.com', '@worker', 'work', '@work/project']) {
      expect(hasWorkDestination(text)).toBe(false)
    }
  })

  it('recognises the reported Dutch handoff and an English equivalent', () => {
    expect(explicitWorkHandoffRequest(
      'Ik wil replies toevoegen. Laat Smith dit uitwerken in project Manor.', projects, roster,
    )).toBe(true)
    expect(explicitWorkHandoffRequest(
      'Have Smith implement replies in project Manor.', projects, roster,
    )).toBe(true)
    expect(explicitWorkHandoffRequest(
      'Werk dit uit in project Manor.', projects, roster,
    )).toBe(true)
  })

  it('does not turn questions about a project or unknown project names into Work', () => {
    expect(explicitWorkHandoffRequest('Wat is de status in project Manor?', projects, roster)).toBe(false)
    expect(explicitWorkHandoffRequest('Waarom bouwen we dit in project Manor?', projects, roster)).toBe(false)
    expect(explicitWorkHandoffRequest(
      'Laat Smith dit niet uitwerken in project Manor.', projects, roster,
    )).toBe(false)
    expect(explicitWorkHandoffRequest(
      'Laat Smith dit uitwerken in project Niet Manor.', projects, roster,
    )).toBe(false)
  })
})
