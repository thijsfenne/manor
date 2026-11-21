import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentFolderFor, embedWithWidth, imageEmbeds, resolveVaultImage } from './vaultImages.js'

test('finds picture embeds in both syntaxes, with the stored size', () => {
  const embeds = imageEmbeds('![[shot.png|400]] and ![Plan|320x200](<+/a b.jpg>) and ![[Other note]] and ![](https://x.test/a.png) and ![](//x.test/b.png)')
  assert.deepEqual(embeds.map(({ kind, target, alt, width, height }) => ({ kind, target, alt, width, height })), [
    { kind: 'wiki', target: 'shot.png', alt: '', width: 400, height: undefined },
    { kind: 'markdown', target: '+/a b.jpg', alt: 'Plan', width: 320, height: 200 },
  ])
  assert.equal(imageEmbeds('![](folder/a%20b.png)')[0]?.target, 'folder/a b.png')
  assert.equal(imageEmbeds('![[photo.png|A caption]]')[0]?.alt, 'A caption')
})

test('rewrites the width in the syntax the embed already used', () => {
  const check = (source: string, width: number) => embedWithWidth(source, imageEmbeds(source)[0]!, width)
  assert.equal(check('![[shot.png]]', 400), '![[shot.png|400]]')
  assert.equal(check('![[shot.png|caption|300x200]]', 412.4), '![[shot.png|caption|412]]')
  assert.equal(check('![alt](a.png)', 250), '![alt|250](a.png)')
  assert.equal(check('![](a.png)', 250), '![250](a.png)')
  assert.equal(check('![alt|90](a.png "t")', 250), '![alt|250](a.png "t")')
})

test('reads the attachment folder setting the way Obsidian does', () => {
  assert.equal(attachmentFolderFor(undefined, 'inbox/a.md'), '')
  assert.equal(attachmentFolderFor('/', 'inbox/a.md'), '')
  assert.equal(attachmentFolderFor('+', 'inbox/a.md'), '+')
  assert.equal(attachmentFolderFor('./', 'inbox/a.md'), 'inbox')
  assert.equal(attachmentFolderFor('./assets', 'inbox/a.md'), 'inbox/assets')
  assert.ok(attachmentFolderFor('../../x', 'a.md').includes('\0'))
})

test('resolves an embed relative to the note, from the root, in the attachment folder, then by name', () => {
  const images = { 'inbox/pic.png': 'a', '+/pic.png': 'b', 'deep/folder/only.png': 'c', 'x/only.png': 'd', 'root.png': 'e' }
  assert.equal(resolveVaultImage('pic.png', 'inbox/note.md', images, '+'), 'inbox/pic.png')
  assert.equal(resolveVaultImage('pic.png', 'other/note.md', images, '+'), '+/pic.png')
  assert.equal(resolveVaultImage('only.png', 'other/note.md', images, '+'), 'x/only.png')
  assert.equal(resolveVaultImage('ROOT.PNG', 'other/note.md', images, '+'), 'root.png')
  assert.equal(resolveVaultImage('../root.png', 'inbox/note.md', images), 'root.png')
  assert.equal(resolveVaultImage('missing.png', 'inbox/note.md', images, '+'), undefined)
})
