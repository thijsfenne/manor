import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_PROJECT_FOLDERS } from '@manor/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import { validateRepoPath, validateRepoPaths } from '../src/repo.js'

let folder: string
let second: string
let file: string

beforeAll(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), 'manor-repo-'))
  second = mkdtempSync(path.join(os.tmpdir(), 'manor-repo-second-'))
  file = path.join(folder, 'notes.md')
  writeFileSync(file, 'not a folder\n', 'utf8')
})

describe('validateRepoPath', () => {
  it('accepts a folder that is there, and hands back the normalised path', async () => {
    const result = await validateRepoPath(`${folder}/./`)

    expect(result).toEqual({ ok: true, path: folder })
  })

  it('trims what was typed before judging it', async () => {
    expect(await validateRepoPath(`  ${folder}  `)).toEqual({ ok: true, path: folder })
  })

  it('refuses a relative path, because the server has no folder to read it against', async () => {
    const result = await validateRepoPath('Ontwikkeling/Manor')

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('Ontwikkeling/Manor is not an absolute path')
  })

  it('refuses an empty path', async () => {
    expect(await validateRepoPath('   ')).toEqual({ ok: false, message: 'Manor needs a folder path to link.' })
  })

  it('says so when there is nothing at the path', async () => {
    const missing = path.join(folder, 'no-such-folder')

    expect(await validateRepoPath(missing)).toEqual({ ok: false, message: `There is nothing at ${missing}.` })
  })

  it('refuses a file, which is not a folder to work in', async () => {
    expect(await validateRepoPath(file)).toEqual({ ok: false, message: `${file} is a file, not a folder.` })
  })
})

describe('validateRepoPaths', () => {
  it('accepts several folders and keeps them in the order they were given', async () => {
    expect(await validateRepoPaths([`${second}/`, folder])).toEqual({ ok: true, paths: [second, folder] })
  })

  it('is empty for a project that links nothing', async () => {
    expect(await validateRepoPaths([])).toEqual({ ok: true, paths: [] })
    // A blank row in the dialog is an unfilled field, not a folder nobody can find.
    expect(await validateRepoPaths(['  ', ''])).toEqual({ ok: true, paths: [] })
  })

  it('drops a folder named twice rather than refusing the list', async () => {
    // The picker and a pasted path reach the same place by different spellings.
    expect(await validateRepoPaths([folder, `${folder}/./`])).toEqual({ ok: true, paths: [folder] })
  })

  it('refuses the whole list when one folder is unusable', async () => {
    const missing = path.join(folder, 'no-such-folder')

    // All or nothing: a half-applied edit is a project whose folders are neither
    // what they were nor what was asked for.
    expect(await validateRepoPaths([folder, missing])).toEqual({
      ok: false,
      message: `There is nothing at ${missing}.`,
    })
  })

  it('refuses more folders than a persona can be told about', async () => {
    const tooMany = Array.from({ length: MAX_PROJECT_FOLDERS + 1 }, () => folder)

    const result = await validateRepoPaths(tooMany)

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain(`at most ${MAX_PROJECT_FOLDERS}`)
  })
})
