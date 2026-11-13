import { describe, expect, it } from 'vitest'

import { imageParts } from './markdownImageParts'

describe('imageParts', () => {
  it('cuts a paragraph around its picture, keeping the alt text and no stray "!"', () => {
    expect(imageParts('![Volwassen bedwants](https://example.com/bug.jpg)\nDit is een bedwants.')).toEqual([
      { kind: 'image', alt: 'Volwassen bedwants', src: 'https://example.com/bug.jpg' },
      { kind: 'text', text: 'Dit is een bedwants.' },
    ])
  })

  it('keeps the link a picture sits inside', () => {
    expect(imageParts('Zie [![logo](https://example.com/logo.png)](https://example.com)')).toEqual([
      { kind: 'text', text: 'Zie' },
      { kind: 'image', alt: 'logo', src: 'https://example.com/logo.png', href: 'https://example.com' },
    ])
  })

  it('reads the address the way the server does: parentheses, angle brackets and a title', () => {
    expect(imageParts('![Bed](https://en.wikipedia.org/wiki/Bed_(insect).jpg "Bedwants")')).toEqual([
      { kind: 'image', alt: 'Bed', src: 'https://en.wikipedia.org/wiki/Bed_(insect).jpg' },
    ])
    expect(imageParts('![bed bug](<https://example.com/bed bug.jpg>)')).toEqual([
      { kind: 'image', alt: 'bed bug', src: 'https://example.com/bed bug.jpg' },
    ])
  })

  it('leaves text without pictures, and a picture written as code, alone', () => {
    expect(imageParts('Een [link](https://example.com) maar geen foto')).toBeUndefined()
    expect(imageParts('Schrijf `![alt](url)` voor een foto')).toBeUndefined()
  })
})
