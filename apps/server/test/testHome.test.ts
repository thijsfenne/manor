import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveGrokHome } from '../src/drivers/grokDriver.js'
import { dataPaths } from '../src/paths.js'

// The setup file's enforcer: nothing in the suite may resolve under the real home.
describe('test home', () => {
  const real = process.env.MANOR_TEST_REAL_HOME ?? ''
  const insideReal = (p: string) => {
    const relative = path.relative(real, p)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  it('points os.homedir() and the Manor folders away from the real home', () => {
    expect(real).not.toBe('')
    expect(insideReal(os.userInfo().homedir)).toBe(true)
    expect(os.homedir()).toBe(process.env.MANOR_TEST_HOME)
    for (const p of [os.homedir(), resolveGrokHome(), dataPaths().root, dataPaths().grokHome, dataPaths(undefined).skills]) {
      expect(insideReal(p)).toBe(false)
    }
  })
})
