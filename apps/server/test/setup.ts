import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

/**
 * Keeps the whole suite out of the real home folder of whoever runs it.
 *
 * Without this a test that clears `MANOR_GROK_HOME` or `MANOR_DATA_DIR`, or a default
 * that reads `os.homedir()`, lands in the real `~/.manor`, `~/.grok`, `~/.codex` or
 * `~/.claude` and changes the user's own files. `HOME` (and `USERPROFILE`) point at one
 * temp folder per worker, so `os.homedir()` and every path derived from it, in this
 * process and in the children it spawns, stay inside it. `PATH` is left alone, so
 * binaries are still found.
 *
 * `MANOR_TEST_REAL_HOME` keeps the home from before the override, for the proof test in
 * `testHome.test.ts` only. Never print it. Setup runs before every test file, so the
 * Manor data and Grok folders are reset per file and one file cannot leave the next one
 * an unset variable.
 */
const testHome = (() => {
  const current = process.env.MANOR_TEST_HOME
  if (current !== undefined && process.env.HOME === current) return current
  process.env.MANOR_TEST_REAL_HOME ??= os.homedir()
  const home = mkdtempSync(path.join(os.tmpdir(), 'manor-test-home-'))
  process.env.MANOR_TEST_HOME = home
  process.env.HOME = home
  process.env.USERPROFILE = home
  return home
})()
// Each worker removes its own temp home at the end. A failure to remove never fails the suite.
afterAll(() => {
  try {
    rmSync(testHome, { recursive: true, force: true })
  } catch {
    // leftover temp folder, harmless
  }
})
const testData = path.join(testHome, 'manor-data')
mkdirSync(testData, { recursive: true })
process.env.MANOR_DATA_DIR = testData
process.env.MANOR_GROK_HOME = path.join(testData, 'grok-home')

/**
 * Switches off the global-memory layer for the whole suite.
 *
 * `composeProjectMemory` otherwise reads the real `~/.claude` of whoever runs the
 * tests, which would make assertions about a persona's prompt depend on the machine:
 * green on a laptop with no global config, red on the user's. Cases that care about the
 * layer pass an explicit `globalRoot` pointing at a temp directory they built.
 */
process.env.MANOR_GLOBAL_CLAUDE_DIR = ''

/**
 * Keeps every Codex driver in the suite off the managed install in
 * `~/.manor/tools/codex`, which would otherwise download a release. Cases about the
 * install build a `CodexInstallation` on a temp folder.
 */
process.env.MANOR_CODEX_COMMAND = 'codex'
