import type { ComposioApp } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { APP_CATEGORIES, appCategory, groupByCategory } from './composioCatalogue'

const app = (slug: string, categories: string[], connect: ComposioApp['connect'] = 'one_click'): ComposioApp =>
  ({ slug, name: slug, description: '', categories, connect })

describe('appCategory', () => {
  it('files an app under the first of its Composio categories that maps', () => {
    expect(appCategory(app('notion', ['notes', 'documents', 'project management']))).toBe('productivity')
    expect(appCategory(app('figma', ['images & design', 'team collaboration']))).toBe('design')
    expect(appCategory(app('hubspot', ['crm', 'marketing automation']))).toBe('business')
    expect(appCategory(app('github', ['developer tools']))).toBe('coding')
  })

  it('skips a category that names the transport and reads names case-insensitively', () => {
    expect(appCategory(app('mcpmail', ['model context protocol', 'Email']))).toBe('communication')
  })

  it('puts an app with no known category in Other', () => {
    expect(appCategory(app('mystery', ['tag1']))).toBe('other')
    expect(appCategory(app('bare', []))).toBe('other')
  })

  it('lists every Composio name under one category only', () => {
    const names = APP_CATEGORIES.flatMap((category) => [...category.composio])
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('groupByCategory', () => {
  it('follows the page order, leaves empty categories out and puts one-click apps first', () => {
    const groups = groupByCategory([
      app('stripe', ['payment processing'], 'own_credentials'),
      app('github', ['developer tools']),
      app('hackernews', ['news & lifestyle'], 'no_auth'),
      app('hubspot', ['crm']),
      app('zendesk', ['customer support'], 'own_credentials'),
      app('exa', ['web search & research']),
    ])
    expect(groups.map((group) => group.category.id)).toEqual(['research', 'business', 'coding'])
    expect(groups[0]?.apps.map((entry) => entry.slug)).toEqual(['exa', 'hackernews'])
    expect(groups[1]?.apps.map((entry) => entry.slug)).toEqual(['hubspot', 'stripe', 'zendesk'])
  })
})
