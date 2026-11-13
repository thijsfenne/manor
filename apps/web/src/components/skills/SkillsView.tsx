import { useEffect, useMemo, useState } from 'react'
import { BoxIcon, Download04Icon, Search01Icon } from '@hugeicons/core-free-icons'
import type { AgentConfig, SkillCandidate, SkillConfig } from '@manor/contracts'
import type { Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { ConfirmStrip } from '../Confirm'
import { Icon } from '../Icon'
import { Markdown } from '../Markdown'
import { Modal, ModalFooter } from '../Modal'
import { Button } from '../ui/Button'
import { formInputClass } from '../ui/FormField'
import { Select } from '../ui/Select'

export type SkillSort = 'uses' | 'name' | 'recent'

const SORT_OPTIONS: ReadonlyArray<{ value: SkillSort; label: string }> = [
  { value: 'uses', label: 'Uses' },
  { value: 'name', label: 'A–Z' },
  { value: 'recent', label: 'Recent' },
]

export const availableSkillSortOptions = (skills: readonly SkillConfig[]) => {
  const canSortByUses = skills.some((skill) => skill.usageCount !== undefined)
  const canSortByRecent = skills.some((skill) => skill.lastUsedAt !== undefined)
  return SORT_OPTIONS.filter((option) =>
    option.value === 'name' ||
    (option.value === 'uses' && canSortByUses) ||
    (option.value === 'recent' && canSortByRecent),
  )
}

interface SkillsViewProps {
  agents: AgentConfig[]
  skills: SkillConfig[]
  candidates: SkillCandidate[] | null
  notice: Notice | null
  requestEvents: RequestEvents
  onListCandidates: () => boolean
  onImport: (candidateId: string, requestId: string) => boolean
  onDelete: (skillId: string, requestId: string) => boolean
  onDismissNotice: () => void
  onDialogChange: (open: boolean) => void
}

/** Manor's import-only registry. Complete skill folders are owned copies, never live paths. */
export function SkillsView({
  agents,
  skills,
  candidates,
  notice,
  requestEvents,
  onListCandidates,
  onImport,
  onDelete,
  onDismissNotice,
  onDialogChange,
}: SkillsViewProps) {
  const [importing, setImporting] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  const [pendingCandidate, setPendingCandidate] = useState<string | null>(null)
  const [pendingSkill, setPendingSkill] = useState<string | null>(null)
  const { start, cancel } = useRequest(requestEvents)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SkillSort>('name')
  const sortOptions = availableSkillSortOptions(skills)
  const canSortByUses = sortOptions.some((option) => option.value === 'uses')
  const canSortByRecent = sortOptions.some((option) => option.value === 'recent')

  useEffect(() => {
    if ((sort === 'uses' && !canSortByUses) || (sort === 'recent' && !canSortByRecent)) {
      setSort('name')
    }
  }, [canSortByRecent, canSortByUses, sort])

  useEffect(() => {
    onDialogChange(importing || viewing !== null)
    return () => onDialogChange(false)
  }, [importing, viewing, onDialogChange])

  useEffect(() => {
    if (viewing !== null && !skills.some((skill) => skill.id === viewing)) setViewing(null)
  }, [skills, viewing])

  const openImport = () => {
    onDismissNotice()
    setImporting(true)
    setPendingCandidate(null)
    onListCandidates()
  }

  const closeDialogs = () => {
    onDismissNotice()
    cancel()
    setImporting(false)
    setViewing(null)
    setPendingCandidate(null)
    setPendingSkill(null)
  }

  const selected = viewing === null ? undefined : skills.find((skill) => skill.id === viewing)
  const visibleSkills = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = needle === '' ? skills : skills.filter((skill) => {
      const holders = agents
        .filter((agent) => (agent.skillIds ?? []).includes(skill.id))
        .map((agent) => agent.name)
      return `${skill.name} ${skill.id} ${skill.description} ${holders.join(' ')}`
        .toLowerCase()
        .includes(needle)
    })
    return sortSkills(matches, sort)
  }, [agents, query, skills, sort])

  return (
    <main className="h-full min-h-0 overflow-y-auto">
      <section className="mx-auto w-full max-w-page px-8 pt-10 pb-10 max-[720px]:px-5 max-[720px]:pt-7 max-[720px]:pb-7">
        <div className="flex items-end justify-between gap-6 max-[640px]:flex-col max-[640px]:items-stretch max-[640px]:gap-4">
          <div>
            <h1 className="m-0 font-display text-[24px] leading-tight font-semibold tracking-[-0.02em]">Skills</h1>
            <p className="mt-1 mb-0 max-w-[590px] text-[16px] leading-relaxed text-muted">
              Reusable instructions your agents can call on.
            </p>
          </div>
          <Button variant="primary" className="inline-flex flex-none items-center gap-2 max-[640px]:self-start" onClick={openImport}>
            <Icon icon={Download04Icon} size={14} />
            Import skill
          </Button>
        </div>

        {skills.length === 0 ? (
          <div className="mt-8 rounded-xl border border-dashed border-line px-6 py-12 text-center">
            <h2 className="m-0 text-[16px] font-semibold">No skills yet</h2>
            <p className="mt-1.5 mb-5 text-[13px] text-muted">
              Import a SKILL.md from the server’s Claude or Codex home.
            </p>
            <Button variant="primary" onClick={openImport}>Import skill</Button>
          </div>
        ) : (
          <>
            <div className="mt-8 flex items-center gap-3 max-[640px]:flex-col max-[640px]:items-stretch">
              <div className="relative min-w-0 flex-1">
                <Icon
                  icon={Search01Icon}
                  size={15}
                  className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-dim"
                />
                <input
                  className={`${formInputClass} pl-10`}
                  value={query}
                  type="search"
                  aria-label="Filter skills"
                  placeholder="Filter skills by name, description, or agent"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="w-[132px] flex-none max-[640px]:self-end">
                <Select label="Sort skills" value={sort} options={sortOptions} onChange={setSort} />
              </div>
            </div>
            <p className="mt-2 mb-0 text-meta text-dim" role="status">
              {query.trim() === ''
                ? `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`
                : `${visibleSkills.length} of ${skills.length} skills`}
            </p>
            {visibleSkills.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-line px-6 py-10 text-center">
                <h2 className="m-0 text-[16px] font-semibold">No matching skills</h2>
                <p className="mt-1.5 mb-0 text-[13px] text-muted">Try a name, description, or attached agent.</p>
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 max-[760px]:grid-cols-1">
                {visibleSkills.map((skill) => {
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      aria-label={`Open ${skill.name}`}
                      className="flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border-0 bg-transparent px-2 py-2 text-left outline-none duration-150 ease-fade hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary motion-safe:transition-colors"
                      onClick={() => setViewing(skill.id)}
                    >
                      <span className="grid size-10 flex-none place-items-center rounded-lg bg-surface text-[var(--color-skill)]">
                        <Icon icon={BoxIcon} size={20} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[16px] font-semibold text-text">{skill.name}</span>
                        <span className="truncate text-label text-muted">
                          {skill.description || 'No description yet'}
                        </span>
                      </span>
                      {skill.usageCount === undefined ? null : (
                        <span className="flex-none text-meta tabular-nums text-dim">
                          {skill.usageCount} {skill.usageCount === 1 ? 'use' : 'uses'}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </section>

      {importing ? (
        <ImportDialog
          candidates={candidates}
          notice={notice}
          pendingCandidate={pendingCandidate}
          onRefresh={onListCandidates}
          onImport={(candidateId) => {
            const sent = start((requestId) => onImport(candidateId, requestId), {
              onAck: () => setPendingCandidate(null),
              onNotice: () => setPendingCandidate(null),
            })
            if (sent) setPendingCandidate(candidateId)
          }}
          onClose={closeDialogs}
        />
      ) : null}

      {selected === undefined ? null : (
        <SkillDialog
          skill={selected}
          holders={agents
            .filter((agent) => (agent.skillIds ?? []).includes(selected.id))
            .map((agent) => agent.name)}
          notice={notice}
          pending={pendingSkill === selected.id}
          onDelete={() => {
            const sent = start((requestId) => onDelete(selected.id, requestId), {
              onAck: () => {
                setPendingSkill(null)
                setViewing(null)
              },
              onNotice: () => setPendingSkill(null),
            })
            if (sent) setPendingSkill(selected.id)
            return sent
          }}
          onClose={closeDialogs}
        />
      )}
    </main>
  )
}

function ImportDialog({
  candidates,
  notice,
  pendingCandidate,
  onRefresh,
  onImport,
  onClose,
}: {
  candidates: SkillCandidate[] | null
  notice: Notice | null
  pendingCandidate: string | null
  onRefresh: () => boolean
  onImport: (candidateId: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = needle === '' ? candidates ?? [] : (candidates ?? []).filter((candidate) =>
      `${candidate.name} ${candidate.slug} ${candidate.description}`.toLowerCase().includes(needle),
    )
    return [...matches].sort(compareByName)
  }, [candidates, query])

  return (
    <Modal title="Import skill" width="wide" onClose={onClose}>
      <p className="m-0 text-[12px] leading-relaxed text-muted">
        Manor copies the complete skill folder into its private storage. Local source folders can disappear after import.
      </p>
      <input
        autoFocus
        className={formInputClass}
        value={query}
        placeholder="Search local skills"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="max-h-[430px] overflow-y-auto rounded-lg border border-line bg-surface-2">
        {candidates === null ? (
          <p className="m-0 px-4 py-8 text-center text-[12px] text-dim">Scanning local skill folders…</p>
        ) : visible.length === 0 ? (
          <p className="m-0 px-4 py-8 text-center text-[12px] text-dim">
            {query.trim() === '' ? 'Every local skill is already imported.' : 'No local skill matches that search.'}
          </p>
        ) : (
          visible.map((candidate) => (
            <div key={candidate.candidateId} className="flex items-center gap-4 border-b border-line px-3.5 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-[13px] font-medium text-text">{candidate.name}</span>
                  <span className="flex-none font-mono text-meta text-dim">${candidate.slug}</span>
                </div>
                <p className="mt-0.5 mb-0 truncate text-meta text-muted">{candidate.description || 'No description'}</p>
                <p className="mt-1 mb-0 text-meta text-dim">
                  {sourceLabel(candidate.sources)} · {bundleLabel(candidate.fileCount, candidate.bundleBytes)}
                </p>
              </div>
              <Button
                size="small"
                disabled={pendingCandidate !== null}
                onClick={() => onImport(candidate.candidateId)}
              >
                {pendingCandidate === candidate.candidateId ? 'Importing…' : 'Import'}
              </Button>
            </div>
          ))
        )}
      </div>
      {notice === null ? null : (
        <p className={`m-0 text-label ${notice.kind === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
          {notice.text}
        </p>
      )}
      <ModalFooter>
        <div className="flex justify-between gap-2">
          <Button onClick={onRefresh}>Refresh</Button>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </ModalFooter>
    </Modal>
  )
}

export function SkillDialog({
  skill,
  holders,
  notice,
  pending,
  onDelete,
  onClose,
}: {
  skill: SkillConfig
  holders: readonly string[]
  notice: Notice | null
  pending: boolean
  onDelete: () => boolean
  onClose: () => void
}) {
  const [armed, setArmed] = useState(false)

  return (
    <Modal title={skill.name} width="wide" onClose={onClose}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-meta text-dim">
        <span className="font-mono">${skill.id}</span>
        <span>
          {sourceLabel(skill.sources)} · {bundleLabel(skill.fileCount, skill.bundleBytes)} ·{' '}
          {holders.length === 0 ? 'attached to nobody' : `attached to ${holders.join(', ')}`}
        </span>
      </div>
      {skill.description ? <p className="m-0 text-[12px] text-muted">{skill.description}</p> : null}
      <div className="max-h-[480px] overflow-y-auto rounded-lg border border-line bg-bg px-4 py-3 text-[13px] leading-relaxed">
        <Markdown text={skill.instructions} variant="document" />
      </div>
      {notice === null ? null : <p className="m-0 text-label text-danger">{notice.text}</p>}
      <ModalFooter>
        {armed ? (
          <ConfirmStrip
            question={`Delete $${skill.id}? It will also be detached from every agent.`}
            onConfirm={() => {
              setArmed(false)
              onDelete()
            }}
            onCancel={() => setArmed(false)}
          />
        ) : (
          <div className="flex justify-between gap-2">
            <Button variant="danger" disabled={pending} onClick={() => setArmed(true)}>{pending ? 'Deleting…' : 'Delete'}</Button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        )}
      </ModalFooter>
    </Modal>
  )
}

const sourceLabel = (sources: readonly string[]) => sources.map((source) => source === 'claude' ? 'Claude' : 'Codex').join(' + ')

const bundleLabel = (fileCount = 0, bytes = 0) => {
  if (fileCount === 0) return 'instructions only'
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${size}`
}

const compareByName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })

export const sortSkills = (skills: readonly SkillConfig[], sort: SkillSort): SkillConfig[] =>
  [...skills].sort((left, right) => {
    if (sort === 'name') return compareByName(left, right)

    if (sort === 'uses') {
      if (left.usageCount === undefined) return right.usageCount === undefined ? compareByName(left, right) : 1
      if (right.usageCount === undefined) return -1
      return right.usageCount - left.usageCount || compareByName(left, right)
    }

    if (left.lastUsedAt === undefined) return right.lastUsedAt === undefined ? compareByName(left, right) : 1
    if (right.lastUsedAt === undefined) return -1
    return Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt) || compareByName(left, right)
  })
