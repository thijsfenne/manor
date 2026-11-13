import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RENDERER_URL,
  isAllowedRendererNavigation,
  resolveRendererUrl,
} from './rendererUrl'

describe('renderer URL', () => {
  it('uses the stable Manor origin by default', () => {
    expect(resolveRendererUrl()).toBe(DEFAULT_RENDERER_URL)
  })

  it('accepts a local development origin', () => {
    expect(resolveRendererUrl('http://localhost:5173')).toBe('http://localhost:5173/')
  })

  it('rejects remote and file renderers', () => {
    expect(() => resolveRendererUrl('https://example.com')).toThrow('local machine')
    expect(() => resolveRendererUrl('file:///tmp/index.html')).toThrow('local machine')
  })

  it('keeps top-level navigation on the renderer origin', () => {
    expect(isAllowedRendererNavigation('http://localhost:43179/settings', DEFAULT_RENDERER_URL)).toBe(true)
    expect(isAllowedRendererNavigation('https://example.com', DEFAULT_RENDERER_URL)).toBe(false)
  })
})
