import { describe, expect, it } from 'vitest'
import { filterSettingsGroups, pageAfterSearch, settingsGroups } from './sections'

const ids = (query: string) => filterSettingsGroups(settingsGroups(true), query).flatMap((group) => group.sections.map((entry) => entry.id))

describe('the settings nav search', () => {
  it('keeps every group for an empty or blank query', () => {
    const groups = settingsGroups(true)

    expect(filterSettingsGroups(groups, '')).toBe(groups)
    expect(filterSettingsGroups(groups, '   ')).toBe(groups)
  })

  it('matches a page title without regard to case', () => {
    expect(ids('STOR')).toEqual(['storage'])
  })

  it('matches a row label from a page the title does not name', () => {
    expect(ids('Sign out')).toEqual(['general'])
    expect(ids('backups')).toEqual(['storage'])
  })

  it('hides a group with no matching page', () => {
    const groups = filterSettingsGroups(settingsGroups(true), 'theme')

    expect(groups.map((group) => group.label)).toEqual(['Personal'])
    expect(groups[0]?.sections.map((entry) => entry.id)).toEqual(['appearance'])
  })

  it('returns nothing when no page matches', () => {
    expect(filterSettingsGroups(settingsGroups(true), 'zzzz')).toEqual([])
  })

  it('moves the open page to the first match only once it stops matching', () => {
    const groups = settingsGroups(true)

    expect(pageAfterSearch(groups, 'default agent', 'general')).toBeUndefined()
    expect(pageAfterSearch(groups, 'cost', 'general')).toBe('usage')
    expect(pageAfterSearch(groups, 'zzzz', 'general')).toBeUndefined()
  })
})
