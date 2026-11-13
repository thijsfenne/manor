import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_NOTES_HEADING,
  MAX_AGENT_NOTES_CHARS,
  composeAgentNotesBundle,
} from '../src/agentNotes.js'

describe('composeAgentNotesBundle', () => {
  it('returns nothing on the relay branch or when the file is missing', async () => {
    await expect(composeAgentNotesBundle(undefined, 'sage')).resolves.toEqual({
      text: '',
      sources: [],
      truncated: false,
    })
    const dailyDir = await mkdtemp(path.join(os.tmpdir(), 'manor-notes-missing-'))
    await expect(composeAgentNotesBundle({ dailyDir }, 'sage')).resolves.toEqual({
      text: '',
      sources: [],
      truncated: false,
    })
  })

  it('injects the file when it exists, and traces the path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'manor-notes-'))
    const dailyDir = path.join(root, 'memory', 'daily')
    const filePath = path.join(root, 'memory', 'agents', 'sage.md')
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'Coach on career questions, do not answer them.\n', 'utf8')

    const bundle = await composeAgentNotesBundle({ dailyDir }, 'sage')
    expect(bundle.text).toContain(AGENT_NOTES_HEADING)
    expect(bundle.text).toContain('Coach on career questions, do not answer them.')
    expect(bundle.sources).toEqual([{
      path: filePath,
      content: 'Coach on career questions, do not answer them.',
    }])
  })

  it('cuts an oversized file on a line boundary and says so', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'manor-notes-cap-'))
    const dailyDir = path.join(root, 'memory', 'daily')
    const filePath = path.join(root, 'memory', 'agents', 'sage.md')
    await mkdir(path.dirname(filePath), { recursive: true })
    const lines = Array.from({ length: 80 }, (_, index) => `line ${index} ${'x'.repeat(40)}`)
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8')

    const bundle = await composeAgentNotesBundle({ dailyDir }, 'sage')
    expect(bundle.text).toContain('Consolidate that file to under 400 words')
    expect(bundle.truncated).toBe(true)
    expect(bundle.sources[0]?.content.length).toBeLessThanOrEqual(MAX_AGENT_NOTES_CHARS)
    expect(bundle.sources[0]?.content.includes('\n')).toBe(true)
  })
})
