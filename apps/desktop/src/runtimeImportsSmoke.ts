import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Workspace contracts point at TypeScript source for Vite and tsx. Electron's
 * packaged CommonJS runtime cannot strip types below node_modules, so any value
 * import from that package is a startup crash rather than a missing feature.
 */
async function main(): Promise<void> {
  const output = __dirname
  const contractPackage = ['@manor', 'contracts'].join('/')
  const forbidden = `require(${JSON.stringify(contractPackage)})`
  const offenders: string[] = []

  for (const file of await javascriptFiles(output)) {
    if ((await readFile(file, 'utf8')).includes(forbidden)) offenders.push(path.relative(output, file))
  }
  if (offenders.length > 0) {
    throw new Error(
      `Desktop runtime imports ${contractPackage} from ${offenders.join(', ')}. ` +
      'Keep desktop contract imports type-only or validate runtime values locally.',
    )
  }
}

async function javascriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return javascriptFiles(target)
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : []
  }))
  return files.flat()
}

void main()
