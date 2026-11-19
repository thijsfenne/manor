import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectGeneratedImages } from '../src/drivers/generatedImages.js'

describe('collectGeneratedImages', () => {
  it('collects recent supported images but never echoes materialised user inputs', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-generated-images-'))
    const startedAt = Date.now()
    await mkdir(path.join(root, 'nested'), { recursive: true })
    await mkdir(path.join(root, 'attachments'), { recursive: true })
    await writeFile(path.join(root, 'nested', 'diagram.png'), Buffer.from('generated'))
    await writeFile(path.join(root, 'attachments', 'user.png'), Buffer.from('input'))

    const images = await collectGeneratedImages([root], startedAt)

    expect(images).toEqual([
      { name: 'diagram.png', dataUrl: `data:image/png;base64,${Buffer.from('generated').toString('base64')}` },
    ])
  })

  it('collects SVG, which is the format Claude reaches for without an image tool', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-generated-images-'))
    const startedAt = Date.now()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" /></svg>'
    await writeFile(path.join(root, 'architecture.svg'), Buffer.from(svg))

    const images = await collectGeneratedImages([root], startedAt)

    expect(images).toEqual([
      { name: 'architecture.svg', dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` },
    ])
  })

  it('ignores vendor directories, whose bundled images all look freshly written', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-generated-images-'))
    const startedAt = Date.now()
    await mkdir(path.join(root, 'node_modules', 'icons'), { recursive: true })
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'icons', 'logo.svg'), Buffer.from('vendored'))
    await writeFile(path.join(root, 'dist', 'bundle.png'), Buffer.from('built'))

    const images = await collectGeneratedImages([root], startedAt)

    expect(images).toEqual([])
  })

  it('ignores pictures in a checkout cloned under the working folder, but keeps a screenshot the agent wrote', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-generated-images-'))
    const startedAt = Date.now()
    const art = path.join(root, 'repos', 'site', 'content-art', 'card')
    await mkdir(art, { recursive: true })
    await mkdir(path.join(root, 'repos', 'site', '.git'), { recursive: true })
    await writeFile(path.join(art, 'best-ai-agent-apps.webp'), Buffer.from('cloned'))
    await writeFile(path.join(root, 'screenshot.png'), Buffer.from('captured'))

    const images = await collectGeneratedImages([root], startedAt)

    expect(images).toEqual([
      { name: 'screenshot.png', dataUrl: `data:image/png;base64,${Buffer.from('captured').toString('base64')}` },
    ])
  })
})
