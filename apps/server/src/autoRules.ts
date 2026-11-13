import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AutoRulesSchema, type AutoRules } from '@manor/contracts'
import { readBuildInfo, serverFile } from './serverRoot.js'

/**
 * The rule file Auto mode classifies against; edited from the composer's Auto settings.
 * Run from source it is the file in the package folder. A bundle is read-only, so
 * there the rules live in the data folder and read as the bundled defaults until the
 * first save.
 */
export const AUTO_RULES_DEFAULTS = serverFile('auto-runtime.json')
export const AUTO_RULES_PATH = readBuildInfo() === undefined
  ? AUTO_RULES_DEFAULTS
  : path.join(process.env.MANOR_DATA_DIR ?? path.join(os.homedir(), '.manor'), 'auto-runtime.json')

export interface AutoRulesFile {
  /** Undefined when the file is missing, malformed or fails the shared schema. */
  read(): Promise<AutoRules | undefined>
  /** Rejects an invalid document before touching disk; the replace itself is atomic. */
  write(rules: unknown): Promise<AutoRules>
}

export function createAutoRulesFile(file: URL | string = AUTO_RULES_PATH, defaults: string = AUTO_RULES_DEFAULTS): AutoRulesFile {
  const target = typeof file === 'string' ? file : file.pathname
  const parse = (from: string) => readFile(from, 'utf8').then((text) => AutoRulesSchema.parse(JSON.parse(text)))
  return {
    read: () =>
      parse(target)
        // Never saved here yet: the defaults that shipped. A saved file that is broken stays broken.
        .catch((error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT' && target !== defaults ? parse(defaults) : Promise.reject(error))
        .catch(() => undefined),
    async write(rules) {
      const checked = AutoRulesSchema.parse(rules)
      // Temp plus rename, so a selector reading mid-save sees the old file or the new one.
      const temp = `${target}.${process.pid}.tmp`
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(temp, `${JSON.stringify(checked, null, 2)}\n`, 'utf8')
      await rename(temp, target)
      return checked
    },
  }
}
