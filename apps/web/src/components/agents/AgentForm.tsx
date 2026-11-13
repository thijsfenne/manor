import { Cancel01Icon, ColorPickerIcon, FlashIcon, Upload01Icon } from '@hugeicons/core-free-icons'
import { FlashIcon as FlashSolidIcon } from '@manor/client-runtime/solid-icons'
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { palette } from '@manor/blobatar'
import { supportsFastMode, type AgentConfig, type AgentDraft, type McpServerConfig, type SkillConfig, type SubagentPolicy } from '@manor/contracts'
import { accentHue } from '../../accent'
import { AVATAR_ACCEPT, shrinkToAvatar } from '../../avatar'
import { BLOB_SHAPES, BLOB_TONES, DEFAULT_BLOB_TONE } from '../../blobShapes'
import { attachedServers, attachmentCost } from '../../mcp'
import { cleanDraft, cosOf, fastFor, personaColorChoices, safeHex } from '../../persona'
import { MODELS, PROVIDERS, defaultModel, effortsFor } from '../../runtimes'
import { CHAT_LIST_PIN_LIMIT, type Notice } from '../../state'
import { Avatar } from '../Avatar'
import { ConfirmStrip } from '../Confirm'
import { Icon } from '../Icon'
import { SaveBar, saveShortcut, useUnsavedGuard } from '../settings/SettingsLayout'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { FormField, formInputClass } from '../ui/FormField'
import { IconButton } from '../ui/IconButton'
import { Pill } from '../ui/Pill'
import { Select, type SelectOption } from '../ui/Select'
import { McpSection } from './McpSection'
import { SkillsSection } from './SkillsSection'
import { SubagentsSection, type PersonaSubagents } from './SubagentsSection'
import { ToolsetSection } from './ToolsetSection'

/**
 * The shell every face choice wears, so a grid of look-alike tiles reads as one
 * set of options and the ring that marks the picked one is the only difference.
 * A fixed circle that the 1.25x blob sits in the middle of, so the ring is a
 * frame around the face rather than padding the slot the overflow then escapes.
 */
const pickTileClass =
  'grid size-[58px] cursor-pointer place-items-center rounded-full border p-0 leading-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-45'

/** The same shell, sized for a colour: the swatch carries the hue, the border marks the pick. */
const colorTileClass =
  'grid size-7 cursor-pointer place-items-center rounded-full border outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

/** How the ring states "this is the one", shared by both grids. */
const pickedClass = 'border-[var(--color-text)]'
const unpickedClass = 'border-transparent hover:border-dim'

/** A request that never left the browser. Nothing changed, and saying so is the point. */
const OFFLINE = 'Nothing was sent, the connection is down. Try again once it is back.'

/**
 * There is no provider default any more, so a persona from before this rule shows the
 * driver's default model the moment her form is open, and what the dropdown says is what
 * saving will write.
 */
const normalised = (initial: AgentDraft): AgentDraft => {
  const model = initial.model ?? defaultModel(initial.driver)
  return { ...initial, model, speed: fastFor(initial.driver, model, initial.speed) }
}

const draftKey = (draft: AgentDraft) => JSON.stringify(cleanDraft(draft))

interface AgentFormProps {
  /** The persona as she stands, or a blank draft for a new one. */
  initial: AgentDraft
  /** The household, for the two things the form must state rather than assume. */
  agents: AgentConfig[]
  /** The MCP registry this persona can attach from. One list for the household. */
  registry: McpServerConfig[]
  /** Imported Manor skills this persona can be made eligible for. */
  skills: SkillConfig[]
  /** Her runtime pinned in her DM ("Sonnet 5.5 · Medium"), when it differs from this form's. */
  dmRuntime?: string
  /** The server's answer to this save. An error means nothing changed. */
  notice: Notice | null
  /** A save or a delete is out and unanswered; a second one would be a second act. */
  pending: 'save' | 'delete' | null
  /**
   * Counts this form's landed saves. Each moves the baseline to what the server stored,
   * by then on `initial`, and keeps whatever was typed while the save was out.
   */
  saved?: number
  /**
   * Both return false when the socket was down and nothing left the house. A save's
   * follow-up goes out only after the persona itself was accepted.
   */
  onSave: (draft: AgentDraft, followUp?: { send: (requestId: string) => boolean; onUnsent: () => void }) => boolean
  onDelete: () => boolean
  /** Every edit makes the server's last answer stale; it was about the draft as it was. */
  onDismissNotice: () => void
  /** Whether the form holds an edit not saved yet, for the guard on every way out. */
  onDirtyChange: (dirty: boolean) => void
  /**
   * The house's subagent policy, which holds this persona's narrowing. Null until read.
   * Absent for a persona not created yet, who has no id to narrow under.
   */
  subagentPolicy?: SubagentPolicy | null
  /** Writes the whole policy back with this persona's entry changed. False when offline. */
  onSaveSubagentPolicy?: (policy: SubagentPolicy, requestId: string) => boolean
}

/**
 * One persona, whole: who she is, what she runs on, what she may touch, and where she
 * works. The only editor there is, from Settings and from the Agents view alike. The
 * instructions are the main event and get the room to prove it, because they are the
 * entire system prompt and someone will paste pages into them.
 *
 * The form holds its own values so a refused save keeps every one of them.
 */
export function AgentForm({
  initial,
  agents,
  registry,
  skills,
  dmRuntime,
  notice,
  pending,
  saved = 0,
  onSave,
  onDelete,
  onDismissNotice,
  onDirtyChange,
  subagentPolicy,
  onSaveSubagentPolicy,
}: AgentFormProps) {
  const [draft, setDraft] = useState(() => normalised(initial))
  // What the form opened on, or last saw saved. The draft is dirty against this.
  const [baseline, setBaseline] = useState(() => draftKey(normalised(initial)))
  const initialKey = draftKey(normalised(initial))
  const dirtyDraft = draftKey(draft) !== baseline
  // A save's echo, or a change from another window while nothing here is edited, moves
  // the form along; a change landing over an edit leaves the edit alone.
  useEffect(() => {
    if (initialKey === baseline) return
    if (!dirtyDraft || draftKey(draft) === initialKey) {
      setDraft(normalised(initial))
      setBaseline(initialKey)
    }
    // Keyed on the incoming persona only; the draft is read as it stands at that moment.
  }, [initialKey])

  // Counted over the others, so unpinning and re-pinning this persona is always allowed.
  const topFull = agents.filter((agent) => agent.id !== initial.id && agent.pinned === true).length >= CHAT_LIST_PIN_LIMIT
  // Something this form knows and the server does not: a picture that would not
  // shrink, or a save that never left the browser.
  const [problem, setProblem] = useState<string | null>(null)
  const [shrinking, setShrinking] = useState(false)
  const [armed, setArmed] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // Her subagent narrowing, seeded from the policy once it arrives and kept apart
  // from the persona draft: it is saved into the house policy, not onto her.
  const agentId = initial.id
  const savedSubagents: PersonaSubagents = agentId === undefined ? undefined : subagentPolicy?.personas[agentId]
  const [subagents, setSubagents] = useState<PersonaSubagents>(savedSubagents)
  const [subagentsTouched, setSubagentsTouched] = useState(false)
  useEffect(() => {
    if (!subagentsTouched) setSubagents(savedSubagents)
  }, [savedSubagents, subagentsTouched])
  const dirtySubagents = subagentsTouched && JSON.stringify(subagents) !== JSON.stringify(savedSubagents)
  const dirty = dirtyDraft || dirtySubagents
  useUnsavedGuard(dirty, onDirtyChange)

  // A save of her landed. What was sent is now the baseline; a draft still saying
  // exactly that takes the server's stored form of it, and typing since stays an edit.
  const submitted = useRef<{ draft: string; subagents: string } | null>(null)
  useEffect(() => {
    const sent = submitted.current
    if (sent === null) return
    submitted.current = null
    setBaseline(initialKey)
    if (draftKey(draft) === sent.draft) setDraft(normalised(initial))
    if (JSON.stringify(subagents) === sent.subagents) setSubagentsTouched(false)
    // Keyed on the landing only; the draft is read as it stands at that moment.
  }, [saved])

  // Counted here rather than inside either control: neither of them alone can say
  // whether this persona has tools, and that is the sentence that has to be true.
  const mcpToolCount = attachmentCost(draft, registry).tools
  const totalTools = draft.allowedTools.length + mcpToolCount
  // A server whose tools are all excluded still counts as attached here: it is still
  // in the config, still costs its instructions block, and saying "no tools at all"
  // over a ticked checkbox is exactly the claim this sentence exists to prevent.
  const attachedCount = attachedServers(draft, registry).length

  // The mock stays offered only to a persona already on it, so she keeps her way out.
  const providerOptions = PROVIDERS.filter((option) => option.value !== 'mock' || initial.driver === 'mock')

  // A model this list does not know, typed before it was a dropdown or added to the
  // CLI since. Offered as itself rather than dropped, so opening the form never
  // silently changes what a persona runs on.
  const known = MODELS[draft.driver]
  const modelOptions: SelectOption<string>[] = [
    ...known,
    ...(draft.model !== undefined && draft.model !== '' && !known.some((model) => model.value === draft.model)
      ? [{ value: draft.model, label: draft.model }]
      : []),
  ]

  const existing = initial.id !== undefined
  const holder = cosOf(agents)
  // The others this persona could be allowed to summon. Excluded by id rather than
  // name, so renaming someone never makes her disappear from her own allowlist.
  // Summons happen in a shared room, which seats only personas of the same placement.
  const sessionPersona = draft.placement === 'session'
  const household = agents.filter((agent) => agent.id !== initial.id &&
    (agent.placement === undefined || draft.placement === undefined || (agent.placement === 'session') === sessionPersona))
  // What the preview is actually painted in, and what the swatch row is checked
  // against, so a colour typed before this palette existed still shows as picked.
  const accent = safeHex(draft.color)
  const colorChoices = personaColorChoices(draft.color)
  const busy = pending !== null
  // A created agent opens as her own record once she lands, so a new form holds still
  // until then rather than taking edits that fresh form would not carry.
  const holding = busy && !existing
  const canSave = draft.name.trim() !== '' && !busy

  const edit = (patch: Partial<AgentDraft>) => {
    if (holding) return
    setProblem(null)
    onDismissNotice()
    setDraft((current) => ({ ...current, ...patch }))
  }

  const toggleSummon = (otherId: string) => {
    const picked = new Set(draft.mentionAllowlist ?? [])
    if (picked.has(otherId)) picked.delete(otherId)
    else picked.add(otherId)
    // Roster order rather than click order, so the saved list reads the same for
    // the same picks and the server's echo matches the draft verbatim.
    edit({ mentionAllowlist: household.filter((other) => picked.has(other.id)).map((other) => other.id) })
  }

  /**
   * Switching provider takes the model with it: a Claude model id left selected
   * under Codex is a label that lies, and the CLI would be handed a model it has
   * never heard of. The new driver's default model steps in rather than nothing,
   * because nothing is not a choice this form offers. Effort survives wherever the
   * new model accepts it: a form left showing a higher level while the CLI runs High
   * is the same lie one field over.
   */
  const editDriver = (driver: AgentConfig['driver']) => {
    const keepsModel = MODELS[driver].some((model) => model.value === draft.model)
    const nextModel = keepsModel ? draft.model : defaultModel(driver)
    const keepsEffort = effortsFor(driver, nextModel).some((option) => option.value === draft.effort)
    edit({
      driver,
      model: nextModel,
      speed: fastFor(driver, nextModel, draft.speed),
      ...(keepsEffort ? {} : { effort: 'high' }),
    })
  }

  const editModel = (model: string) => {
    const keepsEffort = effortsFor(draft.driver, model).some((option) => option.value === draft.effort)
    edit({ model, speed: fastFor(draft.driver, model, draft.speed), ...(keepsEffort ? {} : { effort: 'high' }) })
  }

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Picking the same file twice must fire again, so the input is emptied here
    // rather than left holding the name of the file it just handed over.
    event.target.value = ''
    if (!file) return
    setProblem(null)
    setShrinking(true)
    try {
      edit({ avatar: await shrinkToAvatar(file) })
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'That picture could not be used.')
    } finally {
      setShrinking(false)
    }
  }

  const submit = () => {
    // A new agent is always worth creating; an existing one only once something changed.
    if (!canSave || (existing && !dirty)) return
    setProblem(null)
    // A rule the server holds too, answered here because a round trip to be told
    // the empty box is empty is a round trip for nothing.
    if (draft.character.trim() === '') {
      setProblem('An agent needs instructions. Without them she is the bare harness wearing a name.')
      return
    }
    // Her narrowing lives in the house policy, a second write. It rides behind the
    // persona save so a refused persona leaves the policy as it was.
    let followUp: Parameters<typeof onSave>[1]
    if (agentId !== undefined && subagentPolicy != null && onSaveSubagentPolicy !== undefined && dirtySubagents) {
      const personas = { ...subagentPolicy.personas }
      if (subagents === undefined) delete personas[agentId]
      else personas[agentId] = subagents
      const policy = { ...subagentPolicy, personas }
      followUp = {
        send: (requestId) => onSaveSubagentPolicy(policy, requestId),
        onUnsent: () => setProblem(OFFLINE),
      }
    }
    // Saving an unchanged persona with only her narrowing changed still writes her,
    // which is harmless and keeps the follow-up's ordering rule in one place.
    if (!onSave(cleanDraft(draft), followUp)) setProblem(OFFLINE)
    // A created agent is not followed here: she opens as her own record once she lands.
    else if (existing) submitted.current = { draft: draftKey(draft), subagents: JSON.stringify(subagents) }
  }

  const discard = () => {
    setProblem(null)
    onDismissNotice()
    setDraft(normalised(initial))
    setBaseline(initialKey)
    setSubagentsTouched(false)
    setSubagents(savedSubagents)
  }

  return (
    <div className="flex flex-col gap-10" {...saveShortcut(submit)}>
      <FormSection title="Identity">
        {/* Face, shape and colour, in that order, under the persona as she will
            actually look. No label and no frame: a portrait, a grid of silhouettes and a
            row of colours need no words to say what they are, and the preview is the
            whole answer. */}
        <div className="grid justify-items-center gap-3 py-1">
          {/* The picture as it stands, carrying its own way out in the corner. */}
          <div className="relative">
            <Avatar name={draft.name} color={accent} src={draft.avatar} shape={draft.avatarShape} tone={draft.avatarTone} size={72} />
            {draft.avatar ? (
              <button
                type="button"
                className="absolute -top-0.5 -right-0.5 grid size-[20px] cursor-pointer place-items-center rounded-full border border-line bg-surface-2 text-muted outline-none hover:border-dim hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                aria-label="Remove picture"
                title="Remove picture"
                onClick={() => edit({ avatar: undefined })}
              >
                <Icon icon={Cancel01Icon} size={11} />
              </button>
            ) : null}
          </div>

          {/* Every tile is this persona's own face, so the choice is between ten of
              her rather than between ten strangers. */}
          <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Shape">
            {BLOB_SHAPES.map((option) => {
              const selected = draft.avatarShape === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`${pickTileClass} ${selected ? `${pickedClass} bg-user-bg` : unpickedClass}`}
                  aria-label={`Shape: ${option.label}`}
                  aria-pressed={selected}
                  title={option.label}
                  onClick={() => edit({ avatarShape: option.id })}
                >
                  <Avatar name={draft.name} color={accent} shape={option.id} tone={draft.avatarTone} size={44} center />
                </button>
              )
            })}
          </div>

          <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Avatar tone">
            {BLOB_TONES.map((option) => {
              const selected = (draft.avatarTone ?? DEFAULT_BLOB_TONE) === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`${pickTileClass} ${selected ? `${pickedClass} bg-user-bg` : unpickedClass}`}
                  aria-label={`Tone: ${option.label}`}
                  aria-pressed={selected}
                  title={option.label}
                  disabled={busy || Boolean(draft.avatar)}
                  onClick={() => edit({ avatarTone: option.value })}
                >
                  <span className="size-[44px] rounded-full" style={{ backgroundColor: palette(accentHue(accent) ?? 0, true, option.value).head }} />
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap justify-center gap-1.5 pt-1" role="group" aria-label="Agent colour">
            {colorChoices.map((option) => {
              const selected = option.value.toLowerCase() === accent.toLowerCase()
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`${colorTileClass} ${selected ? pickedClass : unpickedClass}`}
                  aria-label={option.label}
                  aria-pressed={selected}
                  title={option.label}
                  onClick={() => edit({ color: option.value })}
                >
                  {/* The swatch carries the colour, so the ring that marks it stays neutral. */}
                  <span className="size-[22px] rounded-full" style={{ backgroundColor: option.value }} />
                </button>
              )
            })}
            {/* The palette is offered, not imposed. The native picker takes any hex,
                and whatever comes back joins the row as this persona's own colour. */}
            <span
              className={`${colorTileClass} relative border-dashed border-dim text-muted hover:border-[var(--color-text)] hover:text-text focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary`}
              title="Custom colour"
            >
              <Icon icon={ColorPickerIcon} size={14} />
              <input
                className="absolute inset-0 cursor-pointer opacity-0"
                type="color"
                value={accent}
                aria-label="Custom colour"
                onChange={(event) => edit({ color: event.target.value })}
              />
            </span>
          </div>
          {/* Own picture is the exception, not the first option: her face, its shape
              and its colour come first, and this is the way to replace all three. */}
          <Button size="compact" variant="ghost" disabled={shrinking || holding} onClick={() => fileRef.current?.click()}>
            <span className="flex items-center gap-1.5">
              <Icon icon={Upload01Icon} size={13} />
              {shrinking ? 'Resizing…' : draft.avatar ? 'Upload another' : 'Upload a picture'}
            </span>
          </Button>
          <input ref={fileRef} className="hidden" type="file" accept={AVATAR_ACCEPT} tabIndex={-1} onChange={(event) => void pickFile(event)} />
        </div>

        <FormField label="Name">
          <input
            className={formInputClass}
            autoFocus={!existing}
            value={draft.name}
            placeholder="Marlow"
            onChange={(event) => edit({ name: event.target.value })}
          />
        </FormField>

        <FormField label="Role" optional>
          <input
            className={formInputClass}
            value={draft.role}
            placeholder="Engineer"
            onChange={(event) => edit({ role: event.target.value })}
          />
        </FormField>

        <FormField label="Description" hint="Routing reads this. Handoff proposals use it to decide who takes a task.">
          <input
            className={formInputClass}
            value={draft.description}
            placeholder="Engineer. Code, systems, anything that needs a file read."
            onChange={(event) => edit({ description: event.target.value })}
          />
        </FormField>
      </FormSection>

      {/* Named for what it is to whoever fills it in. The field on the wire is still
          `character`, and the placeholder is the only remaining hint that this is a
          whole system prompt rather than a note added to one. */}
      <FormSection title="Instructions">
        <textarea
          className={`${formInputClass} min-h-[260px] resize-y leading-relaxed`}
          aria-label="Instructions"
          value={draft.character}
          placeholder="You are a careful assistant who…"
          onChange={(event) => edit({ character: event.target.value })}
        />
      </FormSection>

      <FormSection title="Model">
        <div className="flex flex-wrap gap-3">
          <FormField label="Provider" custom className="w-[168px] flex-none">
            <Select label="Provider" value={draft.driver} options={providerOptions} onChange={editDriver} />
          </FormField>
          <FormField label="Model" custom className="min-w-[180px] flex-1">
            <Select
              label="Model"
              value={draft.model ?? ''}
              options={modelOptions}
              // The mock driver reaches no provider, so it has no models to offer and
              // this is the one place the field is honestly empty rather than unset.
              disabled={modelOptions.length === 0}
              placeholder={modelOptions.length === 0 ? 'No model' : 'Choose…'}
              onChange={editModel}
            />
          </FormField>
          <FormField label="Effort" custom className="flex-none">
            <div className="flex items-center gap-1">
              <div className="w-[132px]">
                <Select label="Effort" value={draft.effort} options={effortsFor(draft.driver, draft.model)} onChange={(effort) => edit({ effort })} />
              </div>
              {/* Only where the CLI has a fast mode, the same bolt the composer's effort control uses. */}
              {supportsFastMode(draft.driver, draft.model) ? (
                <IconButton
                  icon={draft.speed === 'fast' ? FlashSolidIcon : FlashIcon}
                  solid={draft.speed === 'fast'}
                  swapKey={draft.speed ?? 'standard'}
                  label="Fast mode"
                  selected={draft.speed === 'fast'}
                  aria-pressed={draft.speed === 'fast'}
                  onClick={() => edit({ speed: draft.speed === 'fast' ? undefined : 'fast' })}
                />
              ) : null}
            </div>
          </FormField>
        </div>
        {/* One line: the DM keeps its own pick from the composer, so its value is named
            here only when it differs from this default. */}
        <p className="-mt-1 mb-0 px-0.5 text-label text-dim">
          {dmRuntime === undefined ? (
            'The default for sessions and the DM chat.'
          ) : (
            <>
              The default for sessions. DM chat uses <span className="text-muted">{dmRuntime}</span>.
            </>
          )}
        </p>
      </FormSection>

      <FormSection title="Capabilities">
        <ToolsetSection driver={draft.driver} tools={draft.allowedTools} disabled={busy} onChange={(allowedTools) => edit({ allowedTools })} />
        <McpSection draft={draft} registry={registry} onChange={(mcpServers) => edit({ mcpServers })} />
        <SkillsSection draft={draft} skills={skills} onChange={(skillIds) => edit({ skillIds })} />
        {agentId === undefined || subagentPolicy === undefined ? null : (
          <SubagentsSection
            agentId={agentId}
            driver={draft.driver}
            policy={subagentPolicy}
            own={subagents}
            onChange={(own) => {
              setProblem(null)
              onDismissNotice()
              setSubagentsTouched(true)
              setSubagents(own)
            }}
          />
        )}
        {/* Describes the saved selection, not the tools a provider may add at runtime. */}
        {totalTools === 0 && attachedCount === 0 ? (
          <p className="m-0 px-0.5 text-label text-muted">No built-in tools selected and no connections attached.</p>
        ) : null}
      </FormSection>

      <FormSection title="Placement & access">
        <Toggle
          label="Works in Sessions"
          checked={sessionPersona}
          onChange={(session) =>
            edit(
              session
                ? { placement: 'session', isCos: false, pinned: false, railPinned: false }
                : { placement: 'chat' },
            )
          }
        />

        {sessionPersona ? null : (
          <Toggle
            label="Chief of staff"
            checked={draft.isCos}
            onChange={(isCos) => edit({ isCos })}
            warning={cosWarning(draft.isCos, holder, initial.id)}
          />
        )}

        {/* Two places to pin, independent of each other. The top of the chat list holds
            two cards, so a third pin is refused here rather than silently dropped there. */}
        {sessionPersona ? null : (
          <>
            <Toggle label="Pin to rail" checked={draft.railPinned === true} onChange={(railPinned) => edit({ railPinned })} />
            <Toggle
              label="Pin to top of Agents"
              checked={draft.pinned === true}
              disabled={topFull && draft.pinned !== true}
              warning={topFull && draft.pinned !== true ? `Already ${CHAT_LIST_PIN_LIMIT} pinned there; unpin one first.` : null}
              onChange={(pinned) => edit({ pinned })}
            />
          </>
        )}

        {/* The only summon path there is, the chief of staff's included: each
            picked name makes this persona's @mention of it real, one hop, within
            the per-message budget. Everything else is the user's to bring in. */}
        {household.length > 0 ? (
          <FormField label="May summon in shared rooms" optional custom hint="Private messages aren't restricted.">
            <div className="flex flex-wrap gap-1.5">
              {household.map((other) => (
                <Pill
                  key={other.id}
                  label={`@${other.name}`}
                  on={(draft.mentionAllowlist ?? []).includes(other.id)}
                  onToggle={() => toggleSummon(other.id)}
                />
              ))}
            </div>
          </FormField>
        ) : null}
      </FormSection>

      <FormSection title="Memory">
        <Toggle
          label="Memory"
          hint="Gets your personal memory and her own standing notes with every turn."
          checked={draft.memoryScope}
          onChange={(memoryScope) => edit({ memoryScope })}
        />
      </FormSection>

      {/* The server refused, or the browser did. Either way nothing changed, and
          the form keeps every value so the fix is one edit away. */}
      {notice !== null || problem !== null ? (
        <p className={`m-0 px-0.5 text-label ${notice !== null && notice.kind !== 'error' ? 'text-muted' : 'text-danger'}`} role="status">
          <span className="[overflow-wrap:anywhere]">{notice?.text ?? problem}</span>
        </p>
      ) : null}

      {existing ? (
        <FormSection title="Delete">
          {armed ? (
            <ConfirmStrip
              question={`Delete ${initial.name}? Her past messages stay, labelled by id.`}
              onConfirm={() => {
                setArmed(false)
                if (!onDelete()) setProblem(OFFLINE)
              }}
              onCancel={() => setArmed(false)}
            />
          ) : (
            <div className="flex items-center justify-between gap-6">
              <span className="text-label text-muted">Removes her from every room. Her past messages stay, labelled by id.</span>
              <Button variant="danger" size="small" disabled={busy} onClick={() => setArmed(true)}>
                {pending === 'delete' ? 'Deleting…' : `Delete ${initial.name}`}
              </Button>
            </div>
          )}
        </FormSection>
      ) : null}

      <SaveBar
        dirty={dirty || !existing}
        pending={pending === 'save'}
        canSave={canSave}
        saveLabel={existing ? 'Save' : 'Create agent'}
        {...(existing ? {} : { status: draft.name.trim() === '' ? 'Not created yet. A name comes first.' : 'Not created yet' })}
        onSave={submit}
        onDiscard={discard}
      />
    </div>
  )
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className="flex flex-col gap-4" aria-labelledby={id}>
      <h2 id={id} className="m-0 border-b border-line pb-2 text-[14px] font-medium text-text">{title}</h2>
      {children}
    </section>
  )
}

/**
 * The one thing ticking this box does to somebody else. Everything the box merely
 * describes is gone from this form; taking the flag off whoever holds it is not a
 * description, and the server does it silently on save if this line does not.
 */
function cosWarning(wants: boolean, holder: AgentConfig | null, id: string | undefined): string | null {
  if (!wants || holder === null || holder.id === id) return null
  return `Saving takes it from ${holder.name}; only one persona can hold it.`
}

interface ToggleProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  /** Only ever a warning now. A box that needs explaining is a box named badly. */
  warning?: string | null
  hint?: string
  disabled?: boolean
}

function Toggle({ label, checked, onChange, warning = null, hint, disabled = false }: ToggleProps) {
  return (
    <label className={`flex items-center gap-2.5 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
      <Checkbox checked={checked} size="medium" disabled={disabled} onChange={onChange} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] text-text">{label}</span>
        {hint === undefined ? null : <span className="text-label text-dim">{hint}</span>}
        {warning === null ? null : <span className="text-label text-warn">{warning}</span>}
      </span>
    </label>
  )
}
