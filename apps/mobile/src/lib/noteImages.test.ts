import { describe, expect, it } from 'vitest'

import { noteImageWidth, withVaultPictures } from './noteImages'

const pictures = {
  images: {
    'Assets/a b.png': '/media/vault/sig1/Assets/a%20b.png',
    'Notes/pic.jpg': '/media/vault/sig2/Notes/pic.jpg',
  },
  attachmentFolder: 'Assets',
}

describe('withVaultPictures', () => {
  it('rewrites a wiki embed through the attachment folder and keeps its stored width', () => {
    const out = withVaultPictures('Voor\n![[a b.png|400]]\nNa', 'Notes/day.md', pictures)
    expect(out).toBe('Voor\n![a b.png](</media/vault/sig1/Assets/a%20b.png#manor-width=400>)\nNa')
    expect(noteImageWidth('/media/vault/sig1/Assets/a%20b.png#manor-width=400')).toEqual({ src: '/media/vault/sig1/Assets/a%20b.png', width: 400 })
  })

  it('rewrites a markdown embed relative to the note and keeps its alt text', () => {
    expect(withVaultPictures('![Kaart](pic.jpg)', 'Notes/day.md', pictures)).toBe('![Kaart](</media/vault/sig2/Notes/pic.jpg>)')
  })

  it('leaves unresolved embeds, remote pictures and embeds inside code as written', () => {
    const text = '![[missing.png]] ![x](https://example.com/x.png)\n`![[pic.jpg]]`\n```\n![[pic.jpg]]\n```'
    expect(withVaultPictures(text, 'Notes/day.md', pictures)).toBe(text)
  })

  it('has no width without a stored one', () => {
    expect(noteImageWidth('/media/vault/sig2/Notes/pic.jpg')).toEqual({ src: '/media/vault/sig2/Notes/pic.jpg' })
  })
})
