import { mkdtempSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installVerifySkills, proofRouteBlock, screenshotRoutes, verifyOfferAnswer, VERIFY_OFFER_ID, VERIFY_OFFER_OPTIONS, VERIFY_OFFER_QUESTION } from '../src/verifySkills.js'

const folder = () => mkdtempSync(path.join(os.tmpdir(), 'manor-verify-'))
const skill = async (root: string, relative: string) => {
  await mkdir(path.join(root, relative), { recursive: true })
  await writeFile(path.join(root, relative, 'SKILL.md'), '---\nname: x\n---\n')
}

describe('screenshotRoutes', () => {
  it('finds verify skills and the skill that makes one, in each project skill folder', async () => {
    const root = folder()
    await skill(root, '.cursor/skills/verify-manor')
    await skill(root, '.claude/skills/verify-shop')
    await skill(root, '.agents/skills/create-verification-skill')
    // Not routes: another skill, and a verify folder without its SKILL.md.
    await skill(root, '.cursor/skills/tdd')
    await mkdir(path.join(root, '.cursor/skills/verify-empty'), { recursive: true })
    expect(await screenshotRoutes([root, path.join(root, 'missing')])).toEqual([
      '.cursor/skills/verify-manor/SKILL.md',
      '.claude/skills/verify-shop/SKILL.md',
      '.agents/skills/create-verification-skill/SKILL.md',
    ])
    expect(await screenshotRoutes([folder()])).toEqual([])
  })
})

describe('verifyOfferAnswer', () => {
  const offer = [{ id: VERIFY_OFFER_ID, question: VERIFY_OFFER_QUESTION, options: VERIFY_OFFER_OPTIONS.map((label) => ({ label })) }]
  it('reads exactly one of the offered answers, on a card that asked the offer', () => {
    expect(verifyOfferAnswer(offer, 'Yes, add them')).toBe('added')
    expect(verifyOfferAnswer(offer, "No, don't ask again")).toBe('declined')
    expect(verifyOfferAnswer(offer, 'Yes, but later')).toBeUndefined()
    expect(verifyOfferAnswer(offer, ['Yes, add them', "No, don't ask again"])).toBeUndefined()
    expect(verifyOfferAnswer(offer, undefined)).toBeUndefined()
    expect(verifyOfferAnswer(undefined, 'Yes, add them')).toBeUndefined()
    expect(verifyOfferAnswer([{ ...offer[0]!, question: 'Delete the old skills?' }], 'Yes, add them')).toBeUndefined()
    expect(verifyOfferAnswer([{ ...offer[0]!, options: [{ label: 'Yes, add them' }, { label: 'Later' }] }], 'Yes, add them')).toBeUndefined()
  })
})

describe('proofRouteBlock', () => {
  it('names the route, or says there is none and offers the skills only when asked to', () => {
    expect(proofRouteBlock(['.cursor/skills/verify-manor/SKILL.md'], true)).not.toContain(VERIFY_OFFER_ID)
    expect(proofRouteBlock(['.cursor/skills/create-verification-skill/SKILL.md'], true)).toContain('follow create-verification-skill to make one')
    expect(proofRouteBlock([], true)).toContain(VERIFY_OFFER_ID)
    expect(proofRouteBlock([], false)).toContain('Screenshot route: none.')
    expect(proofRouteBlock([], false)).not.toContain(VERIFY_OFFER_ID)
  })
})

describe('installVerifySkills', () => {
  it('writes nothing when a file does not match its pinned hash', async () => {
    const root = folder()
    await expect(installVerifySkills(root, async () => new TextEncoder().encode('tampered'))).rejects.toThrow('did not match the pinned version')
    expect(await readdir(root)).toEqual([])
  })

  it('leaves skill folders that already exist alone and fetches nothing', async () => {
    const root = folder()
    await skill(root, '.cursor/skills/create-verification-skill')
    await skill(root, '.cursor/skills/maintain-verification-skill')
    const fetchFile = vi.fn(async () => new Uint8Array())
    expect(await installVerifySkills(root, fetchFile)).toEqual([])
    expect(fetchFile).not.toHaveBeenCalled()
  })
})
