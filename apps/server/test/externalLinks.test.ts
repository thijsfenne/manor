import { describe, expect, it } from 'vitest'
import { createExternalLinkOpener } from '../src/externalLinks.js'

describe('external website links', () => {
  it('advertises no desktop browser away from a Mac with Dia', () => {
    expect(createExternalLinkOpener({ platform: 'linux' })).toBeUndefined()
    expect(createExternalLinkOpener({ platform: 'darwin', exists: () => false })).toBeUndefined()
  })

  it('opens a website in Dia without passing it through a shell', async () => {
    const calls: { file: string; args: readonly string[] }[] = []
    const opener = createExternalLinkOpener({
      platform: 'darwin',
      exists: () => true,
      run: async (file, args) => {
        calls.push({ file, args })
      },
    })

    await opener?.open('https://example.com/a?q=one%20two')

    expect(calls).toEqual([
      {
        file: '/usr/bin/open',
        args: ['-b', 'company.thebrowser.dia', 'https://example.com/a?q=one%20two'],
      },
    ])
  })

  it('refuses non-website protocols at the process boundary', async () => {
    const opener = createExternalLinkOpener({ platform: 'darwin', exists: () => true })

    await expect(opener?.open('file:///Users/sam/.ssh/id_ed25519')).rejects.toThrow(
      'Only website links',
    )
  })
})
