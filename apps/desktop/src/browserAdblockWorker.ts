import { rename, writeFile } from 'node:fs/promises'
import { adsAndTrackingLists, fetchLists, fetchResources, FiltersEngine } from '@ghostery/adblocker'

/**
 * Runs in an Electron utility process, because parsing EasyList, EasyPrivacy and
 * uBlock's companion lists takes over a second and would freeze the main process.
 * Writes the serialized engine to the path in argv and exits 0, or exits 1 and leaves
 * the previous file alone.
 */
const MIN_LIST_BYTES = 1_000_000

async function build(target: string): Promise<void> {
  const fetchOk = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return response
  }
  const [lists, resources] = await Promise.all([fetchLists(fetchOk, adsAndTrackingLists), fetchResources(fetchOk)])
  const size = lists.reduce((total, list) => total + list.length, 0)
  // A captive portal or an error page parses into an engine that blocks nothing.
  if (size < MIN_LIST_BYTES) throw new Error(`The filter lists were only ${size} bytes.`)
  const engine = FiltersEngine.parse(lists.join('\n'))
  engine.updateResources(resources, String(resources.length))
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, engine.serialize())
  await rename(temporary, target)
}

const target = process.argv[2]
if (target === undefined) {
  console.error('No engine path given.')
  process.exit(1)
}
build(target).then(() => process.exit(0), (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
