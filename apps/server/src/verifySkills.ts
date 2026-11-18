import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Project, UserInputAnswerValue, UserInputQuestion } from '@manor/contracts'
import { userInputAnswerLines } from '@manor/contracts'

/**
 * Whether a project has a screenshot route, and the one-time offer of one (2026-11-18).
 *
 * A route is a project-local verify skill: a skill folder named `verify-…`, such as
 * Manor's own `verify-manor`, or `create-verification-skill`, which makes one. Manor looks
 * for them in the three folders where coding agents keep project skills. That is the
 * simplest signal that holds across projects: a folder name, read live from the
 * Session's own checkout every turn, so a skill added mid-Session counts at once. These are
 * project files the agent reads by the path Manor names, like any file in the repository;
 * they never enter the skill registry and Manor discovers nothing else from these folders.
 *
 * A project without a route gets the offer: the Session lead asks once with ask_user,
 * question id `VERIFY_OFFER_ID`, before its first UI change. A yes adds the two verification
 * skills below to the Session's checkout, so they land with Confirm like the rest of its
 * work; a no is stored on the project and Manor never asks there again.
 */

/** Where coding agents keep project skills, relative to a project folder. */
const SKILL_FOLDERS = ['.cursor/skills', '.claude/skills', '.agents/skills']

/** A skill folder that is a screenshot route, or makes one. */
const ROUTE_SKILL = /^(verify-[\w.-]+|create-verification-skill)$/

/** The `SKILL.md` of every verify skill in these folders, relative to its project folder. */
export async function screenshotRoutes(repoPaths: readonly string[]): Promise<string[]> {
  const found = await Promise.all(repoPaths.flatMap((root) => SKILL_FOLDERS.map(async (folder) => {
    const names = await readdir(path.join(root, folder)).catch(() => [])
    const skills = await Promise.all(names.filter((name) => ROUTE_SKILL.test(name)).sort().map(async (name) => {
      const file = path.join(folder, name, 'SKILL.md')
      return (await stat(path.join(root, file)).catch(() => undefined))?.isFile() === true ? [file] : []
    }))
    return skills.flat()
  })))
  return [...new Set(found.flat())]
}

/** The ask_user question id of the offer; the answer is read from it. */
export const VERIFY_OFFER_ID = 'add_verify_skills'

/** The offer's question and its two answers, in this order; the server acts only on this exact card. */
export const VERIFY_OFFER_QUESTION = 'This project has no way to check UI changes on screen. Add the open source verify skills, so Sessions can take screenshots?'
export const VERIFY_OFFER_OPTIONS = ['Yes, add them', "No, don't ask again"] as const

/**
 * What the user answered the offer: a yes adds the skills, a no stops the offer for good.
 * Only a card that asked exactly the offer's question with its two options counts, and only
 * an answer that is one of them, so a free line or another card reusing the id authorizes nothing.
 */
export function verifyOfferAnswer(asked: readonly UserInputQuestion[] | undefined, answer: UserInputAnswerValue | undefined): NonNullable<Project['verifySkills']> | undefined {
  const question = asked?.find((candidate) => candidate.id === VERIFY_OFFER_ID)
  const offered = question?.question === VERIFY_OFFER_QUESTION ? question.options.map((option) => option.label) : undefined
  if (offered?.length !== 2 || offered.some((label, index) => label !== VERIFY_OFFER_OPTIONS[index])) return undefined
  const lines = answer === undefined ? [] : userInputAnswerLines(answer)
  if (lines.length !== 1) return undefined
  return lines[0] === VERIFY_OFFER_OPTIONS[0] ? 'added' : lines[0] === VERIFY_OFFER_OPTIONS[1] ? 'declined' : undefined
}

/**
 * The verification skills of Cursor's pstack plugin, MIT licensed, pinned to one commit and
 * checked by hash, because their text becomes instructions to the agents that read them.
 * Fetched at the user's yes rather than shipped with Manor; the licence travels with each
 * skill as `LICENSE.txt`.
 */
const PSTACK_COMMIT = '7eedb25021e53910abb09d86fc781c45f02a678d'
const PSTACK_LICENSE = { source: 'LICENSE', sha256: 'bc957ca6bee02792566a1a028d105e02e247c6e77cf057061674273da77b200e' }
const PSTACK_SKILLS: readonly { name: string; files: readonly { file: string; sha256: string }[] }[] = [
  {
    name: 'create-verification-skill',
    files: [
      { file: 'SKILL.md', sha256: 'd353973547bf8ad8977eca645f4cd4feaed0d32f4b43d1448f906b0a76c4d694' },
      { file: 'references/feature-map-example/README.md', sha256: 'cb7bd782cf89968a4ba3d58a5151db837430db92d19a6f52a906973b77b516ba' },
      { file: 'references/feature-map-example/create-note.md', sha256: '644a44c74f35d38c2feb7cd05a0121fdebbb623e8dc376c185b565a581d1ccf7' },
      { file: 'references/feature-map-example/search.md', sha256: '6e87b9e7f2791a7776ba1bb83f371cd285c306c67f19d245cc4dd6ca3015c823' },
    ],
  },
  {
    name: 'maintain-verification-skill',
    files: [{ file: 'SKILL.md', sha256: '515c0eaa054b3f6be1b1fb06f2c2f173c80fddb58bbcac57576f89c479bc68e8' }],
  },
]

/** Where the skills go inside a project folder, beside the verify skill they make. */
export const VERIFY_SKILLS_FOLDER = '.cursor/skills'

/**
 * Adds the verification skills to one project folder and returns the files it wrote. All
 * files are fetched and checked, then written to a staging folder beside the skills and
 * moved into place one whole skill folder at a time, so a failure leaves no half-written
 * skill; a skill folder that already exists is left as it is.
 */
export async function installVerifySkills(root: string, fetchFile: (url: string) => Promise<Uint8Array> = download): Promise<string[]> {
  const get = async (source: string, sha256: string) => {
    const bytes = await fetchFile(`https://raw.githubusercontent.com/cursor/plugins/${PSTACK_COMMIT}/pstack/${source}`)
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`${source} did not match the pinned version.`)
    return bytes
  }
  const missing = []
  for (const skill of PSTACK_SKILLS) {
    if (await stat(path.join(root, VERIFY_SKILLS_FOLDER, skill.name)).catch(() => undefined) === undefined) missing.push(skill)
  }
  if (missing.length === 0) return []
  const license = await get(PSTACK_LICENSE.source, PSTACK_LICENSE.sha256)
  // One file at a time: GitHub's raw host answers a burst with 429.
  const files: { skill: string; file: string; bytes: Uint8Array }[] = []
  for (const skill of missing) {
    for (const { file, sha256 } of skill.files) files.push({ skill: skill.name, file, bytes: await get(`skills/${skill.name}/${file}`, sha256) })
    files.push({ skill: skill.name, file: 'LICENSE.txt', bytes: license })
  }
  const skills = path.join(root, VERIFY_SKILLS_FOLDER)
  await mkdir(skills, { recursive: true })
  const staging = await mkdtemp(path.join(skills, '.manor-staging-'))
  try {
    for (const { skill, file, bytes } of files) {
      await mkdir(path.dirname(path.join(staging, skill, file)), { recursive: true })
      await writeFile(path.join(staging, skill, file), bytes)
    }
    const placed: string[] = []
    try {
      for (const skill of missing) {
        await rename(path.join(staging, skill.name), path.join(skills, skill.name))
        placed.push(path.join(skills, skill.name))
      }
    } catch (error) {
      // A skill moved in before the failure would read as a route and end the offer.
      await Promise.all(placed.map((folder) => rm(folder, { recursive: true, force: true })))
      throw error
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return files.map(({ skill, file }) => path.join(skills, skill, file))
}

/** One file from GitHub, tried up to three times while it answers 429 or a server error. */
async function download(url: string): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (response.ok) return new Uint8Array(await response.arrayBuffer())
    if (attempt === 3 || (response.status !== 429 && response.status < 500)) throw new Error(`GitHub answered ${response.status}.`)
    const seconds = Math.min(Number(response.headers.get('retry-after')) || 2 * attempt, 10)
    await new Promise((resolve) => setTimeout(resolve, seconds * 1_000))
  }
}

/**
 * The goal owner's per-turn note on how this Session proves a UI change, and the offer
 * while the project has no route and the user has not declined it.
 */
export function proofRouteBlock(routes: readonly string[], offer: boolean): string {
  if (routes.length > 0) {
    const makesOne = routes.every((route) => route.includes('create-verification-skill'))
    return [
      `[Manor] Screenshot route: ${routes.join(', ')}. This replaces any earlier screenshot route note.`,
      makesOne
        ? 'This project has no verify skill yet. Before your first UI change is reported, follow create-verification-skill to make one, then take the screenshots with it.'
        : 'A changed UI file needs an after screenshot taken with it and passed to goal_reached.',
    ].join('\n')
  }
  return [
    '[Manor] Screenshot route: none. This replaces any earlier screenshot route note.',
    'This project has no verify skill, so a changed UI file needs a successful test, typecheck, build or script run like other code, and the result card says it was not checked on screen.',
    ...(offer ? [
      `If this task changes UI, ask the user before your first UI change with ask_user, question id "${VERIFY_OFFER_ID}", only that question: ` +
        `"${VERIFY_OFFER_QUESTION}" with exactly the options "${VERIFY_OFFER_OPTIONS[0]}" and "${VERIFY_OFFER_OPTIONS[1]}". ` +
        `On a yes Manor adds them under ${VERIFY_SKILLS_FOLDER} in your checkout before the answer reaches you; then follow create-verification-skill to make this project's verify skill and use it for your screenshots. ` +
        'Ask it once; on a no, carry on without.',
    ] : []),
  ].join('\n')
}
