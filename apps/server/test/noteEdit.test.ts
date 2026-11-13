import { DEFAULT_HOUSE_SETTINGS, HouseSettingsSchema, NOTE_AI_MAX_CHARS, type ServerMessage, type TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { HostModule } from '../src/hostModule.js'
import { buildNoteEditPrompt, createNoteEditor, fitNoteEdit, noteEditParts } from '../src/noteEdit.js'
import { scripted } from './helpers.js'

const NOTE = '---\ntype: note\n---\n\nWe hebben eigenlijk veel input gekregen.\n\nDaarna gaan we schetsen.\n'
const selectionOf = (text: string) => ({ from: NOTE.indexOf(text), to: NOTE.indexOf(text) + text.length })
const scratch = (threadId: string) => Promise.resolve(`/tmp/${threadId}`)

describe('note edit prompt', () => {
  it('sends the whole note for the composer and reads back into its parts', () => {
    const prompt = buildNoteEditPrompt({ note: NOTE, instruction: 'Maak het korter' })
    expect(prompt).toBe(`<instruction>\nMaak het korter\n</instruction>\n<note>\n${NOTE}\n</note>`)
    expect(noteEditParts(prompt)).toEqual({ instruction: 'Maak het korter', note: NOTE })
  })

  it('sends a selection as the passage between the text around it', () => {
    const prompt = buildNoteEditPrompt({ note: NOTE, selection: selectionOf('eigenlijk veel input'), instruction: 'Make it concrete' })
    expect(prompt).toContain('<before>\n---\ntype: note\n---\n\nWe hebben \n</before>')
    expect(prompt).toContain('<selection>\neigenlijk veel input\n</selection>')
    expect(prompt).toContain('<after>\n gekregen.\n\nDaarna gaan we schetsen.\n\n</after>')
    expect(noteEditParts(prompt)).toEqual({ instruction: 'Make it concrete', selection: 'eigenlijk veel input' })
  })
})

describe('fitting a model answer into the note', () => {
  it('keeps the whitespace the passage had and drops what the model wrapped it in', () => {
    expect(fitNoteEdit(' veel input ', 'much input\n')).toBe(' much input ')
    expect(fitNoteEdit('veel input', '```markdown\nmuch input\n```')).toBe('much input')
    expect(fitNoteEdit('veel input', '<selection>\nmuch input\n</selection>')).toBe('much input')
    expect(fitNoteEdit(NOTE, NOTE.trim())).toBe(NOTE)
  })

  it('leaves a fence alone when the original is itself a code block', () => {
    expect(fitNoteEdit('```ts\nlet a\n```', '```ts\nconst a = 1\n```')).toBe('```ts\nconst a = 1\n```')
  })
})

describe('note edit job', () => {
  it('runs one tool-less turn on the chosen model and returns the replacement', async () => {
    const seen: TurnInput[] = []
    const edit = createNoteEditor({ resolve: () => scripted(() => [{ type: 'result', text: 'veel input\n' }], seen), ensureScratchDir: scratch })
    const run = edit({ note: NOTE, selection: selectionOf('eigenlijk veel input'), instruction: 'Korter' }, { model: 'gpt-6-luna', effort: 'high' })

    await expect(run.result).resolves.toEqual({ status: 'ready', text: 'veel input' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.agent).toMatchObject({ id: 'manor-note-editor', driver: 'codex', model: 'gpt-6-luna', effort: 'high', allowedTools: [], mcpServers: [], memoryScope: false })
    expect(seen[0]).toMatchObject({ repoPaths: [], infrastructure: true, isFullCatchUp: true })
    expect(seen[0]?.catchUp).toHaveLength(1)
    expect(seen[0]?.threadId).toMatch(/^noteedit_[0-9a-f-]{36}$/)
  })

  it('reports a provider error or an empty answer instead of proposing nothing', async () => {
    const failing = createNoteEditor({ resolve: () => scripted(() => [{ type: 'error', message: 'provider unavailable' }], []), ensureScratchDir: scratch })
    await expect(failing({ note: NOTE, instruction: 'x' }, { model: 'claude-sonnet-5-5', effort: 'medium' }).result).resolves.toEqual({ status: 'failed', message: 'provider unavailable' })
  })

  it('refuses a whole note past the cap without starting a turn', async () => {
    const seen: TurnInput[] = []
    const edit = createNoteEditor({ resolve: () => scripted(() => [], seen), ensureScratchDir: scratch })
    const result = await edit({ note: 'a'.repeat(NOTE_AI_MAX_CHARS + 1), instruction: 'x' }, { model: 'claude-sonnet-5-5', effort: 'medium' }).result
    expect(result).toMatchObject({ status: 'failed' })
    expect(seen).toHaveLength(0)
  })

  it('answers nobody once it is stopped', async () => {
    const edit = createNoteEditor({ resolve: () => createMockDriver({}), ensureScratchDir: scratch })
    const run = edit({ note: NOTE, instruction: 'slow turn' }, { model: 'claude-sonnet-5-5', effort: 'medium' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    run.stop()
    await expect(run.result).resolves.toBeNull()
  })

  it('gets a real diff from the mock driver', async () => {
    const edit = createNoteEditor({ resolve: () => createMockDriver({}), ensureScratchDir: scratch })
    const result = await edit({ note: NOTE, instruction: 'Tighten' }, { model: 'claude-sonnet-5-5', effort: 'medium' }).result
    expect(result).toEqual({ status: 'ready', text: NOTE.replace('eigenlijk ', '') })
  })
})

describe('note AI setting', () => {
  it('defaults to Sonnet 5.5 at medium and keeps a saved pick', () => {
    expect(DEFAULT_HOUSE_SETTINGS).toMatchObject({ noteAiModel: 'claude-sonnet-5-5', noteAiEffort: 'medium' })
    // Settings saved before the field existed read as the default.
    expect(HouseSettingsSchema.parse({ archiveRetentionDays: 10 })).toMatchObject({ noteAiModel: 'claude-sonnet-5-5', noteAiEffort: 'medium' })
    expect(HouseSettingsSchema.parse({ noteAiModel: 'gpt-6-luna', noteAiEffort: 'low' })).toMatchObject({ noteAiModel: 'gpt-6-luna', noteAiEffort: 'low' })
  })

  it('is what the host hands the job, read when the job starts', async () => {
    const seen: TurnInput[] = []
    let settings = { model: 'claude-sonnet-5-5', effort: 'medium' as const }
    const host = new HostModule({
      editNote: createNoteEditor({ resolve: () => scripted(() => [{ type: 'result', text: 'done' }], seen), ensureScratchDir: scratch }),
      noteAi: () => settings,
    })
    const replies: ServerMessage[] = []
    const ask = async (requestId: string) => {
      await host.handle({ type: 'edit_vault_note', requestId, note: NOTE, instruction: 'x' }, (message) => replies.push(message))
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    await ask('one')
    settings = { model: 'claude-haiku-5-5', effort: 'medium' }
    await ask('two')

    expect(seen.map((input) => input.agent.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])
    expect(replies).toEqual([
      { type: 'vault_note_edit', requestId: 'one', result: { status: 'ready', text: 'done\n' } },
      { type: 'vault_note_edit', requestId: 'two', result: { status: 'ready', text: 'done\n' } },
    ])
  })

  it('stops a job on cancel and sends no answer for it', async () => {
    const host = new HostModule({
      editNote: createNoteEditor({ resolve: () => createMockDriver({}), ensureScratchDir: scratch }),
      noteAi: () => ({ model: 'claude-sonnet-5-5', effort: 'medium' }),
    })
    const replies: ServerMessage[] = []
    await host.handle({ type: 'edit_vault_note', requestId: 'one', note: NOTE, instruction: 'slow turn' }, (message) => replies.push(message))
    // The turn's scratch folder is the sweep's to leave alone for as long as the job runs.
    expect(host.activeScratchThreadIds()).toEqual([expect.stringMatching(/^noteedit_/)])
    await host.handle({ type: 'cancel_vault_note_edit', requestId: 'one' }, (message) => replies.push(message))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(replies).toEqual([])
    expect(host.activeScratchThreadIds()).toEqual([])
  })
})
