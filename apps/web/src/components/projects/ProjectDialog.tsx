import { useEffect, useRef, useState } from 'react'
import { Cancel01Icon, Folder01Icon, FolderAddIcon } from '@hugeicons/core-free-icons'
import {
  DEFAULT_PROJECT_COLOR,
  DEFAULT_PROJECT_ICON,
  MAX_PROJECT_FOLDERS,
  NEW_SINGLE_CHAT_DEFAULT,
  SINGLE_DRIVERS,
  type ChatOverride,
  type Effort,
  type Project,
  type ProjectIcon,
  type ProjectMemoryScope,
  type ProjectRepoIcon,
} from '@manor/contracts'
import { hasModelOn, modelOptionsFor, readSingleRuntime, runtimeOn } from '../../runtimeChoices'
import { MODELS, PROVIDERS, effortsFor, landingModel } from '../../runtimes'
import { useOffModels } from '../../useOffModels'
import type { DirBrowse, Notice } from '../../state'
import { desktopChooseFolder } from '../../desktopBrowser'
import { ConfirmStrip, DeleteButton } from '../Confirm'
import { Icon } from '../Icon'
import { Modal, ModalFooter } from '../Modal'
import { Button } from '../ui/Button'
import { FormField, formFieldClass, formInputClass, formLabelClass, formOptionalClass } from '../ui/FormField'
import { IconButton } from '../ui/IconButton'
import { Select } from '../ui/Select'
import { RequestNotice } from '../ui/RequestNotice'
import { draftMark, projectMark, sameRepoIcon, type ProjectMarkChoice } from '../../projectAppearance'
import { ProjectIdentityField } from './ProjectIdentityField'

const quietButtonClass =
  'flex-none cursor-pointer rounded-md border border-line bg-transparent px-[9px] py-0.5 text-[12px] enabled:hover:border-dim disabled:cursor-default disabled:opacity-40 [font:inherit]'

/**
 * What the dialog is holding. It lives above the dialog so that closing never
 * costs the user a typed name; only Cancel, the explicit no, throws it away.
 */
export interface ProjectDraft {
  name: string
  icon: ProjectIcon
  /** What stands in for `icon`: the name's letters, a repo icon (Edit only), or null for the glyph. */
  mark: ProjectMarkChoice
  color: string
  /** Folders in the order they will be named to a persona; empty is the ordinary case. */
  repoPaths: string[]
  memoryScope: ProjectMemoryScope
  /** What the new project's thread runs on at first; empty means the house default. Create only. */
  threadRuntime: ChatOverride
}

type SingleDriver = (typeof SINGLE_DRIVERS)[number]
/** The providers a project thread can run on, in the house order. */
const THREAD_PROVIDERS = PROVIDERS.flatMap((option) => {
  const driver = SINGLE_DRIVERS.find((candidate) => candidate === option.value)
  return driver === undefined ? [] : [{ ...option, value: driver }]
})

export const emptyDraft: ProjectDraft = {
  name: '',
  icon: DEFAULT_PROJECT_ICON,
  mark: null,
  color: DEFAULT_PROJECT_COLOR,
  repoPaths: [],
  memoryScope: 'project',
  threadRuntime: {},
}

/** The last segment of a path, for the folder row's title; the full path sits under it. */
const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** The dialog's starting point when an existing project is opened for editing. */
export const draftOf = (project: Project): ProjectDraft => ({
  name: project.name,
  icon: project.icon,
  mark: projectMark(project),
  color: project.color,
  repoPaths: [...project.repoPaths],
  memoryScope: project.memoryScope,
  threadRuntime: {},
})

/** Grows the shorthand people commonly type; the wire and database keep one six-digit shape. */
export function normaliseProjectColor(value: string): string {
  const clean = value.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(clean)
  if (short === null) return clean
  const [, red = '', green = '', blue = ''] = short
  return `#${red}${red}${green}${green}${blue}${blue}`
}

interface ProjectDialogProps {
  /** Creating names and closes differently; everything between them is identical. */
  mode: 'create' | 'edit'
  draft: ProjectDraft
  /** Every edit also makes the server's last answer stale; the owner clears it. */
  onDraft: (draft: ProjectDraft) => void
  /** Where the picker is standing, straight from the server. */
  dirs: DirBrowse
  /** The server's answer to the write, shown here rather than in the sidebar foot. */
  notice: Notice | null
  /** A write is out and unanswered; a second one would be a second project. */
  busy: boolean
  onListDirs: (path?: string) => void
  onSubmit: () => void
  /** The explicit no: closes and forgets what was typed. */
  onCancel: () => void
  /** Escape and the backdrop: closes and keeps the draft for the next open. */
  onClose: () => void
  /**
   * Deletes the project being edited, chats and all. Only offered in edit mode;
   * since the sidebar became the chat list this dialog is where a project ends.
   */
  onDelete?: () => void
  /** Opens with the delete question already asked, for a menu entry that came to delete. */
  initialArmed?: boolean
  /** The icon the project's folders offer, shown as the picker's first option. Edit only. */
  repoIconOffer?: ProjectRepoIcon & { src: string }
  /** The link of the repo icon the project wears now, for the field while it stays picked. */
  repoIconSrc?: string
}

/**
 * Name a project, and point it at as many folders as it needs. Folders are
 * optional and have to read that way: most rooms in this house are knowledge
 * work, and a dialog that looks like it wants a repo would tilt the whole app
 * toward code. Plural, because a room can span a codebase, a notes vault and an
 * archive, and picking one of them was the old limit talking.
 *
 * On the desktop shell, "Add a folder…" opens the Finder dialog, which does hand back
 * an absolute path. Everywhere else the picker walks the SERVER's
 * filesystem, with paste-a-path inside it, because a browser has no way to
 * produce an absolute path (showDirectoryPicker hands out a handle,
 * webkitdirectory only a folder name) and the folders have to exist on the
 * machine the personas run on, not on the machine looking at them.
 */
export function ProjectDialog({
  mode,
  draft,
  onDraft,
  dirs,
  notice,
  busy,
  onListDirs,
  onSubmit,
  onCancel,
  onClose,
  onDelete,
  initialArmed = false,
  repoIconOffer,
  repoIconSrc,
}: ProjectDialogProps) {
  // The offer stands while its folder is in the draft. A picked icon shows the offer's
  // picture when it is the offer, else the one the project wears now.
  const offer = repoIconOffer !== undefined && draft.repoPaths.includes(repoIconOffer.folder) ? repoIconOffer : undefined
  const mark = draftMark(draft)
  const picked = mark === 'letters' ? null : mark
  const pickedSrc = picked === null ? undefined : offer !== undefined && sameRepoIcon(picked, offer) ? offer.src : repoIconSrc
  const repoIconProps = {
    ...(offer === undefined ? {} : { repoIconOffer: offer.src, repoIconOfferPicked: sameRepoIcon(picked, offer), onRepoIcon: () => onDraft({ ...draft, mark: { folder: offer.folder, path: offer.path } }) }),
    ...(pickedSrc === undefined ? {} : { repoIconSrc: pickedSrc }),
  }
  // Whether the picker is unfolded. Deliberately not part of the draft: a
  // reopened dialog shows the folders it holds, not the walk that found them.
  const [browsing, setBrowsing] = useState(false)
  const [typed, setTyped] = useState('')
  // A typed path is checked by listing it, which writes nothing: the server answers with
  // the folder's listing, or with an error notice when nothing is there. `refused` is
  // that notice's text, so the message sits by the field it is about.
  const [checking, setChecking] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const asked = useRef(false)
  // Stops a double-click racing the first open of the Finder dialog.
  const [choosing, setChoosing] = useState(false)
  const chooseFolder = desktopChooseFolder()
  // The Finder sheet outlives this dialog if a save or delete closes it meanwhile;
  // a late answer must not reach the owner's draft or notice.
  const open = useRef(true)
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
    }
  }, [])
  // Delete asks twice, in place; armed swaps the footer for the question.
  const [armed, setArmed] = useState(initialArmed && onDelete !== undefined)

  const canSubmit = draft.name.trim() !== '' && !busy
  const full = draft.repoPaths.length >= MAX_PROJECT_FOLDERS

  const openPicker = () => {
    setBrowsing(true)
    onListDirs()
  }

  const add = (path: string) => {
    setBrowsing(false)
    setTyped('')
    // A folder already on the list is not added twice; the server dedupes too, but
    // a list that visibly ignores the second pick explains itself better than a
    // duplicate row that silently disappears on save.
    if (draft.repoPaths.includes(path)) return
    onDraft({ ...draft, repoPaths: [...draft.repoPaths, path] })
  }

  // One answer at a time: a walk still on its way would end this check with its own folder.
  const check = (path: string) => {
    if (dirs.asking) return
    asked.current = false
    setRefused(null)
    setChecking(true)
    // Unchanged, but it drops the previous answer, so a repeated refusal reads as new.
    onDraft(draft)
    onListDirs(path)
  }

  // Any answer ends the server's wait: the listing is the folder being there, and a
  // notice with no listing change is it not being there.
  useEffect(() => {
    if (!checking) return
    if (dirs.asking) {
      asked.current = true
      return
    }
    if (!asked.current) return
    setChecking(false)
    if (notice?.kind === 'error') setRefused(notice.text)
    else if (dirs.listing !== null) add(dirs.listing.path)
  }, [checking, dirs, notice])

  // Cancel and a failed dialog both change nothing; a path goes through the same
  // add() as a pasted one, so the server still validates it on save.
  const chooseNative = async () => {
    if (chooseFolder === undefined || choosing) return
    setChoosing(true)
    try {
      const path = await chooseFolder()
      if (path !== null && open.current) add(path)
    } catch {
      // The dialog could not open; the paste field remains.
    } finally {
      setChoosing(false)
    }
  }

  const remove = (path: string) => {
    onDraft({ ...draft, repoPaths: draft.repoPaths.filter((candidate) => candidate !== path) })
  }

  const submit = () => {
    if (canSubmit) onSubmit()
  }

  // What the new project's thread starts on. An effort the picked model does not offer
  // falls back to High, the rule the server holds too.
  const off = useOffModels()
  const thread = readSingleRuntime(draft.threadRuntime, runtimeOn(NEW_SINGLE_CHAT_DEFAULT, off))
  const setThread = (driver: SingleDriver, model: string, effort: Effort) => {
    const offered = effortsFor(driver, model)
    onDraft({ ...draft, threadRuntime: { driver, model, effort: offered.some((option) => option.value === effort) ? effort : offered.find((option) => option.value === 'high')?.value ?? offered[0]?.value ?? effort } })
  }

  return (
    <Modal
      title={mode === 'create' ? 'New project thread' : 'Edit project thread'}
      {...(mode === 'create' ? { subtitle: 'One ongoing chat for the project. It answers you, or starts Sessions and reports back.' } : {})}
      onClose={onClose}
    >
      <ProjectIdentityField
        name={draft.name}
        icon={draft.icon}
        color={draft.color}
        onName={(name) => onDraft({ ...draft, name })}
        onIcon={(icon) => onDraft({ ...draft, icon, mark: null })}
        lettersPicked={mark === 'letters'}
        onLetters={() => onDraft({ ...draft, mark: 'letters' })}
        {...repoIconProps}
        onColor={(color) => onDraft({ ...draft, color })}
        onEnter={submit}
      />

      <section className={formFieldClass}>
        <span className={formLabelClass}>
          Folders <span className={formOptionalClass}>optional</span>
        </span>

        {/* One bordered list: each folder is a row, and the last row is the way in. An
            empty project is just that row, so the section reads as optional. */}
        <div
          className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface-2 data-[bare]:hidden"
          data-bare={browsing && draft.repoPaths.length === 0 ? '' : undefined}
        >
          {draft.repoPaths.map((path) => (
            <div key={path} className="flex items-center gap-3 py-2 pr-2 pl-3">
              <Icon icon={Folder01Icon} size={16} className="flex-none text-dim" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px] text-text">{folderName(path)}</span>
                <span className="truncate font-mono text-[12px] text-dim" title={path}>
                  {path}
                </span>
              </div>
              {/* The way out of a folder, on the folder it undoes. */}
              <IconButton
                className="h-6 w-6"
                icon={Cancel01Icon}
                iconSize={12}
                label={`Remove ${path}`}
                onClick={() => remove(path)}
              />
            </div>
          ))}
          {browsing ? null : (
            <div className="flex items-center">
              {/* On the desktop this opens Finder; elsewhere it unfolds the server's folder browser. */}
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 border-0 bg-transparent py-3 pl-3 text-left text-[14px] text-text enabled:hover:bg-user-bg disabled:cursor-default disabled:text-dim [font:inherit]"
                disabled={full || choosing}
                onClick={() => (chooseFolder === undefined ? openPicker() : void chooseNative())}
              >
                <Icon icon={FolderAddIcon} size={16} className="flex-none text-dim" />
                {full ? `That is the most a project can link (${MAX_PROJECT_FOLDERS}).` : 'Add a folder…'}
              </button>
            </div>
          )}
        </div>

        {browsing ? (
          <Picker
            dirs={dirs}
            typed={typed}
            onTyped={setTyped}
            // And no walk while a typed path is being checked, for the same reason. A walk
            // beside a walk stays allowed: its answer is what frees a wait a lost reply left behind.
            onWalk={(path) => { if (!checking) onListDirs(path) }}
            onPick={(path) => (path === dirs.listing?.path ? add(path) : check(path))}
            onDone={() => {
              setChecking(false)
              setBrowsing(false)
            }}
          />
        ) : null}
        {refused !== null && notice?.text === refused ? <RequestNotice notice={notice} /> : null}
      </section>

      {/* A new project gets its thread at once, and that thread's first turn reads the
          folders and says hello. The model for it is chosen here; the thread's own
          picker changes it afterwards, so an existing project has no row for it. */}
      {mode !== 'create' ? null : (
        <FormField label="Project thread model" custom>
          {/* Plain dropdowns, as on the Auto mode rules page: the composer's model menu is
              taller than this dialog and would hang out of it. */}
          <div className="flex items-center gap-2">
            <div className="w-[132px] flex-none">
              <Select
                label="Provider"
                value={thread.driver}
                options={THREAD_PROVIDERS.filter((option) => option.value === thread.driver || hasModelOn(option.value, off))}
                disabled={busy}
                onChange={(driver) => {
                  const model = MODELS[driver].some((option) => option.value === thread.model) ? thread.model : landingModel(driver, off) ?? MODELS[driver][0]?.value ?? ''
                  setThread(driver, model, thread.effort)
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <Select
                label="Model"
                value={thread.model}
                options={modelOptionsFor(thread.driver, off, thread.model)}
                disabled={busy}
                onChange={(model) => setThread(thread.driver, model, thread.effort)}
              />
            </div>
            <div className="w-[116px] flex-none">
              <Select
                label="Reasoning"
                value={thread.effort}
                options={effortsFor(thread.driver, thread.model)}
                disabled={busy}
                onChange={(effort: Effort) => setThread(thread.driver, thread.model, effort)}
              />
            </div>
          </div>
        </FormField>
      )}

      {/* The server refused, and nothing was written. The dialog stays exactly as
          it was so the name and the folders are still there to fix. */}
      {notice === null || notice.text === refused ? null : <RequestNotice notice={notice} />}

      <ModalFooter>
        {armed && onDelete !== undefined ? (
          <ConfirmStrip
            question={`Delete “${draft.name.trim() || 'this project'}”, with its thread, Sessions and chats?`}
            wrap
            onConfirm={() => {
              setArmed(false)
              onDelete()
            }}
            onCancel={() => setArmed(false)}
          />
        ) : (
          <div className="flex items-center gap-2 pt-0.5">
            {mode === 'edit' && onDelete !== undefined ? (
              <DeleteButton label="Delete project thread" onArm={() => setArmed(true)} />
            ) : null}
            <div className="flex flex-1 justify-end gap-2">
              <Button onClick={onCancel}>Cancel</Button>
              <Button variant="primary" onClick={submit} disabled={!canSubmit}>
                {mode === 'create'
                  ? busy
                    ? 'Creating…'
                    : 'Create project thread'
                  : busy
                    ? 'Saving…'
                    : 'Save changes'}
              </Button>
            </div>
          </div>
        )}
      </ModalFooter>
    </Modal>
  )
}

interface PickerProps {
  dirs: DirBrowse
  typed: string
  onTyped: (value: string) => void
  onWalk: (path?: string) => void
  onPick: (path: string) => void
  onDone: () => void
}

/**
 * The walk. One directory at a time, exactly what the server said is there, with
 * no marker while the next listing is in flight: the path in the head always
 * names the entries under it, so a listing that has not arrived yet leaves the
 * previous one standing rather than blinking the list away. Same trade the chat
 * switch makes, and it keeps a fast local listing from flickering.
 */
export function Picker({ dirs, typed, onTyped, onWalk, onPick, onDone }: PickerProps) {
  const { listing, asking } = dirs

  const parent = listing === null ? null : listing.parent

  const commitTyped = () => {
    const clean = typed.trim()
    // The server has the last word on whether it is a folder; it answers the
    // write with a notice when it is not.
    if (clean !== '') onPick(clean)
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`${quietButtonClass} text-muted enabled:hover:text-text`}
          disabled={parent === null}
          title="Up one folder"
          onClick={() => parent !== null && onWalk(parent)}
        >
          Up
        </button>
        <span className="min-w-0 flex-1 font-mono text-[12px] text-muted [overflow-wrap:anywhere]">
          {listing === null ? 'Home' : listing.path}
        </span>
      </div>

      {listing === null ? (
        <p className="m-0 px-1 py-2.5 text-[12px] text-dim">
          {asking ? (
            'Asking the server…'
          ) : (
            <>
              Nothing came back.{' '}
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted underline [font:inherit]"
                onClick={() => onWalk()}
              >
                Ask again
              </button>
            </>
          )}
        </p>
      ) : listing.entries.length === 0 ? (
        <p className="m-0 px-1 py-2.5 text-[12px] text-dim">No folders in here.</p>
      ) : (
        <ul className="m-0 max-h-[190px] list-none overflow-y-auto border-y border-line p-0">
          {listing.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="w-full cursor-pointer rounded-md border-0 bg-transparent px-2 py-[5px] text-left text-[13px] text-text hover:bg-user-bg [font:inherit]"
                onClick={() => onWalk(entry.path)}
              >
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={`${quietButtonClass} text-muted enabled:hover:text-text`}
          onClick={onDone}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`${quietButtonClass} bg-user-bg text-text`}
          disabled={listing === null}
          onClick={() => listing !== null && onPick(listing.path)}
        >
          Add this folder
        </button>
      </div>

      {/* The fast route when the path is already known: Finder's Option-rightclick
          “Copy as Pathname”, then paste it here. */}
      <div className="flex items-center gap-2 pt-0.5">
        <input
          className={formInputClass}
          value={typed}
          placeholder="/absolute/path/to/folder"
          aria-label="Paste an absolute folder path"
          onChange={(event) => onTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commitTyped()
          }}
        />
        <button
          type="button"
          className={`${quietButtonClass} text-muted enabled:hover:text-text`}
          disabled={typed.trim() === ''}
          onClick={commitTyped}
        >
          Add
        </button>
      </div>
    </div>
  )
}
