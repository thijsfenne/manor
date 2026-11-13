import { describe, expect, it } from 'vitest'
import { allowsBrowserPagePermission, allowsRendererPermission } from './permissions'

describe('allowsRendererPermission', () => {
  it('lets the renderer put text on the clipboard', () => {
    // Every copy button in Manor dies silently without this one.
    expect(allowsRendererPermission('clipboard-sanitized-write')).toBe(true)
  })

  it('keeps the rest denied', () => {
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal']) {
      expect(allowsRendererPermission(permission)).toBe(false)
    }
  })
})

describe('allowsBrowserPagePermission', () => {
  it('lets a page in the shared browser go fullscreen and nothing else', () => {
    expect(allowsBrowserPagePermission('fullscreen')).toBe(true)
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'pointerLock']) {
      expect(allowsBrowserPagePermission(permission)).toBe(false)
    }
  })
})
