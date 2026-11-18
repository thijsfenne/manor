import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStore } from '../src/stores/index.js'
import { createSqliteStore } from '../src/stores/sqliteStore.js'
import { ensureLocalAccessToken, isLocalAccessToken } from '../src/localAccess.js'

const homes: string[] = []
const home = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-fresh-'))
  homes.push(dir)
  return dir
}
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('a first run on an empty home', () => {
  it('creates an empty house, and opens the same one on the next start', async () => {
    const filename = path.join(home(), 'sqlite', 'manor.db')

    const first = createStore({ kind: 'sqlite', filename })
    expect(await first.loadRoster()).toEqual([])
    expect(await first.listProjects()).toEqual([])
    const project = await first.createProject('Home')
    first.close?.()

    const second = createStore({ kind: 'sqlite', filename })
    expect((await second.listProjects()).map((entry) => entry.id)).toEqual([project.id])
    second.close?.()
  })

  it('refuses a database that was written but never finished', () => {
    const filename = path.join(home(), 'manor.db')
    createSqliteStore({ filename }).close()

    expect(() => createStore({ kind: 'sqlite', filename })).toThrow(/never finished/)
  })
})

describe('the local access token', () => {
  it('is private, survives a restart, and is replaced when the file is damaged', () => {
    const file = path.join(home(), 'data', 'local-access-token')

    const token = ensureLocalAccessToken(file)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8').trim()).toBe(token)
    expect(ensureLocalAccessToken(file)).toBe(token)
    expect(isLocalAccessToken(token, token)).toBe(true)
    expect(isLocalAccessToken(`${token.slice(0, -1)}x`, token)).toBe(false)
    expect(isLocalAccessToken('', token)).toBe(false)

    writeFileSync(file, 'short')
    const replaced = ensureLocalAccessToken(file)
    expect(replaced).not.toBe(token)
    expect(replaced).toHaveLength(43)
  })
})
