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

  it('lets the Manor window\'s main frame record audio for dictation and nothing more', () => {
    const manor = { fromManorWindow: true, isMainFrame: true }
    expect(allowsRendererPermission('media', { ...manor, mediaTypes: ['audio'] })).toBe(true)
    expect(allowsRendererPermission('media', { ...manor, isMainFrame: false, mediaTypes: ['audio'] })).toBe(false)
    expect(allowsRendererPermission('media', { ...manor, mediaTypes: ['video'] })).toBe(false)
    expect(allowsRendererPermission('media', { ...manor, mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(allowsRendererPermission('media', { ...manor, mediaTypes: [] })).toBe(false)
    expect(allowsRendererPermission('media', manor)).toBe(false)
  })

  it('denies the microphone to any contents other than the Manor window', () => {
    expect(allowsRendererPermission('media', { fromManorWindow: false, isMainFrame: true, mediaTypes: ['audio'] })).toBe(false)
    expect(allowsRendererPermission('media', { isMainFrame: true, mediaTypes: ['audio'] })).toBe(false)
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
