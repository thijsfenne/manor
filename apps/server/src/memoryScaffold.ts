import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LONG_TERM_FILE, LONG_TERM_STARTER } from './memoryCompress.js'

/**
 * The files a new memory folder starts with. They are the user's to rewrite: each one
 * says what it is for and holds almost nothing, because a made-up preference is worse
 * than an empty line.
 */
const STARTER_FILES: Readonly<Record<string, string>> = {
  'soul.md': `# Voice and values

How your agents should sound and what they should care about. Agents with memory on read this file at the start of every turn. Edit it freely.

- Be direct. Lead with the answer.
- Say so when you are unsure.
- Keep replies as short as the question allows.
`,
  'user-core.md': `# About me

Who you are and how you like to work. Agents with memory on read this file at the start of every turn.

- Work:
- Languages:
- Preferences:
`,
  'rules.md': `# Rules

Standing rules for every agent with memory on. Add one when you find yourself correcting the same thing twice.
`,
  // Its presence is what turns the distilling of old days on (`memoryCompress.ts`).
  [LONG_TERM_FILE]: LONG_TERM_STARTER,
  [path.join('memory', 'structured', 'MEMORY.md')]: `# Memory index

One line per saved fact, linking to its file in this folder.
`,
}

/**
 * Gives a new install somewhere to remember. Only a folder that is missing or empty is
 * filled: one that already holds anything is somebody's memory, and nothing in it is
 * created, changed or completed. Returns whether it wrote the starter files.
 */
export async function ensureMemoryFolder(root: string): Promise<boolean> {
  const held = await readdir(root).catch(() => undefined)
  if (held !== undefined && held.length > 0) return false
  await mkdir(path.join(root, 'memory', 'daily'), { recursive: true })
  for (const [name, content] of Object.entries(STARTER_FILES)) {
    const file = path.join(root, name)
    await mkdir(path.dirname(file), { recursive: true })
    // `wx`: a file that appeared meanwhile is kept.
    await writeFile(file, content, { flag: 'wx' }).catch(() => undefined)
  }
  return true
}
