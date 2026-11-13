import type { ClientMessage, ServerMessage } from '@manor/contracts'
import { listDirectories } from './browse.js'
import type { ExternalFileOpener } from './externalFiles.js'
import type { Effort } from '@manor/contracts'
import path from 'node:path'
import type { EditNote } from './noteEdit.js'
import { dataPaths } from './paths.js'
import { createVaultFolder, deleteVaultEntry, moveVaultEntry, renameVaultFile, notePreview, listVaultFiles, readVaultFile, writeVaultFile, type Vault, type VaultDeleteResult } from './vault.js'

type HostMessage = Extract<
  ClientMessage,
  {
    type:
      | 'list_dirs'
      | 'open_external_url'
      | 'list_vault'
      | 'create_vault_folder'
      | 'rename_vault_file'
      | 'read_vault_file'
      | 'delete_vault_entry'
      | 'move_vault_entry'
      | 'write_vault_file'
      | 'edit_vault_note'
      | 'cancel_vault_note_edit'
  }
>

interface HostModuleOptions {
  externalFiles?: ExternalFileOpener
  /** The browser this host can open for a user-clicked website link. */
  externalBrowser?: 'dia'
  /** Opens that link on this host. Absent on the VPS and every non-Mac runtime. */
  openExternalUrl?: (url: string) => Promise<void>
  /** The one host-local Obsidian vault. Absent means the Knowledge tab is unavailable. */
  vault?: Vault
  /** Where Knowledge deletes go. Defaults to `trash/knowledge` in Manor's data folder. */
  vaultTrash?: string
  /** Runs one AI edit of a note's text. Absent means the note AI is unavailable here. */
  editNote?: EditNote
  /** The model and effort Settings names for it, read when a job starts. */
  noteAi?: () => { model: string; effort: Effort }
  /** Reaches every client, so a create or delete shows in every open tree. */
  broadcast?: (message: ServerMessage) => void
  /** Apple Reminders can be reached on this host, so the Reminders door shows. */
  reminders?: boolean
  /** A runtime selector is wired in, so Auto mode can choose for a first turn. */
  auto?: boolean
  /** The home room's folders, which is the memory folder; clients offer its files. */
  homeFolders?: readonly string[]
}

/**
 * What a vault request gets on a machine with no vault. A client that respects
 * `vault_status` never sends one, so this exists for the honest answer rather than
 * the expected path. Silence would look exactly like a note that will not load.
 */
const NO_VAULT = {
  status: 'unavailable',
  message: 'This Manor has no vault: set MANOR_VAULT_DIR on the machine it runs on.',
} as const

/**
 * Owns capabilities that exist on one machine rather than in shared Manor state.
 * Reads and saves are reply-only. What changes the shape of the vault (a new note or
 * folder, a rename, a delete) also broadcasts the fresh listing, because every other
 * client holds that listing as its tree.
 */
export class HostModule {
  private readonly trash: string
  /** Note edits in flight by request id, so Stop reaches the turn. */
  private readonly noteEdits = new Map<string, { stop: () => void; threadId: string | null }>()

  /** Scratch folders of note edits in flight, which the hourly lifecycle sweep must leave alone. */
  activeScratchThreadIds(): string[] {
    return [...this.noteEdits.values()].flatMap((job) => (job.threadId === null ? [] : [job.threadId]))
  }

  constructor(private readonly options: HostModuleOptions) {
    this.trash = options.vaultTrash ?? path.join(dataPaths().trash, 'knowledge')
  }

  private async announceListing(vault: Vault): Promise<void> {
    if (this.options.broadcast === undefined) return
    this.options.broadcast({ type: 'vault_files', ...await listVaultFiles(vault) })
  }

  capabilities(): ServerMessage {
    return {
      type: 'host_capabilities',
      externalBrowser: this.options.externalBrowser ?? null,
      repoFileApps: this.options.externalFiles?.apps ?? [],
      reminders: this.options.reminders === true,
      auto: this.options.auto === true,
      homeFolders: [...this.options.homeFolders ?? []],
    }
  }

  vaultStatus(): ServerMessage {
    const vault = this.options.vault
    return {
      type: 'vault_status',
      available: vault !== undefined,
      name: vault?.name ?? null,
      root: vault?.root ?? null,
      trash: vault === undefined ? null : this.trash,
    }
  }

  async handle(message: HostMessage, reply: (message: ServerMessage) => void): Promise<void> {
    switch (message.type) {
      case 'open_external_url': {
        const open = this.options.openExternalUrl
        if (open === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'This Manor cannot open links in Dia.' })
          return
        }
        try {
          await open(message.url)
        } catch {
          reply({ type: 'notice', kind: 'error', text: 'Dia could not open that link.' })
        }
        return
      }
      case 'list_dirs': {
        const listing = await listDirectories(message.path)
        reply(
          listing.ok
            ? { type: 'dir_listing', path: listing.path, parent: listing.parent, entries: listing.entries }
            : { type: 'notice', kind: 'error', text: listing.message },
        )
        return
      }
      case 'list_vault': {
        const vault = this.options.vault
        if (vault === undefined) {
          reply({ type: 'vault_files', files: [], truncated: false })
          return
        }
        const listing = await listVaultFiles(vault)
        reply({ type: 'vault_files', ...listing })
        return
      }
      case 'create_vault_folder': {
        const vault = this.options.vault
        const result = vault === undefined ? { status: 'rejected' as const, message: NO_VAULT.message } : await createVaultFolder(vault, message.path)
        reply({ type: 'vault_folder_created', path: message.path, result })
        if (vault !== undefined && result.status === 'created') await this.announceListing(vault)
        return
      }
      case 'rename_vault_file': {
        const vault = this.options.vault
        const result = vault === undefined ? { status: 'rejected' as const, message: NO_VAULT.message } : await renameVaultFile(vault, message.path, message.newPath, message.baseRevision)
        reply({ type: 'vault_renamed', requestId: message.requestId, path: message.path, newPath: message.newPath, result })
        if (vault !== undefined && result.status === 'renamed') await this.announceListing(vault)
        return
      }
      case 'move_vault_entry': {
        const vault = this.options.vault
        const result = vault === undefined ? ({ status: 'rejected', message: NO_VAULT.message } as const) : await moveVaultEntry(vault, message.path, message.folder)
        const answer: ServerMessage = { type: 'vault_moved', requestId: message.requestId, path: message.path, result }
        // A refusal or a move onto its own folder changed nothing anybody else holds.
        if (vault === undefined || result.status === 'rejected' || result.newPath === message.path || this.options.broadcast === undefined) {
          reply(answer)
          return
        }
        this.options.broadcast(answer)
        await this.announceListing(vault)
        return
      }
      case 'read_vault_file': {
        const vault = this.options.vault
        const result = vault === undefined ? NO_VAULT : await readVaultFile(vault, message.path)
        reply({ type: 'vault_file', path: message.path, result })
        return
      }
      case 'write_vault_file': {
        const vault = this.options.vault
        const result =
          vault === undefined
            ? ({ status: 'rejected', message: NO_VAULT.message } as const)
            : await writeVaultFile(vault, message.path, message.content, message.baseRevision)
        reply({ type: 'vault_write', path: message.path, result, ...(result.status === 'saved' ? { preview: notePreview(message.content) } : {}) })
        if (vault !== undefined && message.baseRevision === null && result.status === 'saved') await this.announceListing(vault)
        return
      }
      case 'edit_vault_note': {
        const { editNote, noteAi } = this.options
        if (editNote === undefined || noteAi === undefined) {
          reply({ type: 'vault_note_edit', requestId: message.requestId, result: { status: 'failed', message: 'This Manor cannot edit notes with AI.' } })
          return
        }
        // The same id asked twice is one job: the first keeps running and answers once.
        if (this.noteEdits.has(message.requestId)) return
        const run = editNote({ note: message.note, instruction: message.instruction, ...(message.selection === undefined ? {} : { selection: message.selection }) }, noteAi())
        this.noteEdits.set(message.requestId, { stop: run.stop, threadId: run.threadId })
        // Not awaited: an edit takes as long as a model does, and this connection's
        // other messages, Stop among them, must not queue behind it.
        void run.result.then((result) => {
          this.noteEdits.delete(message.requestId)
          if (result !== null) reply({ type: 'vault_note_edit', requestId: message.requestId, result })
        })
        return
      }
      case 'cancel_vault_note_edit': {
        // The job leaves the map when its turn has ended, so its scratch folder stays protected until then.
        this.noteEdits.get(message.requestId)?.stop()
        return
      }
      case 'delete_vault_entry': {
        const vault = this.options.vault
        const outcome: VaultDeleteResult = vault === undefined
          ? { status: 'rejected', message: NO_VAULT.message }
          : await deleteVaultEntry(vault, message.path, this.trash)
        const result = outcome.status === 'rejected' ? ({ status: 'rejected', message: outcome.message } as const) : outcome
        const answer: ServerMessage = { type: 'vault_deleted', requestId: message.requestId, path: message.path, result }
        if (vault === undefined || outcome.status === 'rejected' || this.options.broadcast === undefined) {
          reply(answer)
          // A removal that failed partway still changed the tree, so every client relists it.
          if (vault !== undefined && outcome.status === 'rejected' && outcome.listingChanged === true) await this.announceListing(vault)
          return
        }
        this.options.broadcast(answer)
        await this.announceListing(vault)
        return
      }
    }
  }
}
