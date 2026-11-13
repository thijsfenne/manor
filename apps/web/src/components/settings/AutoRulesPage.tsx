import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Delete02Icon, FlashIcon, PlusSignIcon } from '@hugeicons/core-free-icons'
import { FlashIcon as FlashSolidIcon } from '@manor/client-runtime/solid-icons'
import {
  AUTO_RULE_DEFER_KEY,
  AutoRuleKeySchema,
  AutoRuleSchema,
  supportsFastMode,
  type AutoRule,
  type AutoRules,
  type AutoRulesDraft,
  type DriverName,
  type Effort,
} from '@manor/contracts'
import { INSTANT, SPRING_PANEL } from '../../motion'
import { MODELS, PROVIDERS, defaultModel, effortsFor } from '../../runtimes'
import type { Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { formInputClass } from '../ui/FormField'
import { IconButton } from '../ui/IconButton'
import { RequestNotice } from '../ui/RequestNotice'
import { Select } from '../ui/Select'
import { SaveBar, SettingsPage, useUnsavedGuard } from './SettingsLayout'

const AutoRulesConfigContext = createContext<(() => void) | null>(null)

/**
 * One way to open the rule file, for every Auto mode toggle on the screen. The
 * toggle sits inside popovers that unmount the moment something outside them is
 * pressed, so the page cannot be reached from where the gear is; this hands the gear
 * the way into Settings, Auto mode rules.
 */
export function AutoRulesConfigProvider({ open, children }: { open: () => void; children: ReactNode }) {
  return <AutoRulesConfigContext.Provider value={open}>{children}</AutoRulesConfigContext.Provider>
}

/** Null where no provider sits above, and then the toggle simply has no gear. */
export const useAutoRulesConfig = (): (() => void) | null => useContext(AutoRulesConfigContext)

/** A rule while it is being edited. The id survives a renamed key, the key does not. */
export interface RuleRow {
  id: string
  key: string
  rule: AutoRule
}

/** What is wrong with one row, per field, in the server's own words. */
type RuleProblems = Partial<Record<'key' | 'description' | 'driver' | 'model' | 'effort' | 'speed', string>>

/** Auto never picks the mock, so the form never offers it. */
const RULE_PROVIDERS = PROVIDERS.filter((option) => option.value !== 'mock')

const newRule = (): AutoRule => ({
  description: '',
  driver: 'claude',
  model: defaultModel('claude') ?? '',
  effort: 'high',
})

/**
 * The file as rows. A key the form already shows keeps its row's id, so seeding the
 * same rules again (on the way in, after a save) moves no row out and back in.
 */
const rowsFrom = (rules: AutoRules, shown: readonly RuleRow[] = []): RuleRow[] =>
  Object.entries(rules).map(([key, rule]) => ({ id: shown.find((row) => row.key === key)?.id ?? crypto.randomUUID(), key, rule }))

/** Builds the file-shaped rule while making Fast an explicit on/off choice. */
export const ruleWithFastMode = (rule: AutoRule, fast: boolean): AutoRule => ({
  description: rule.description.trim(),
  driver: rule.driver,
  model: rule.model,
  effort: rule.effort,
  ...(fast ? { speed: 'fast' as const } : {}),
})

/** Exactly the five fields the file holds, trimmed, with no key carrying `undefined`. */
const cleanRule = (rule: AutoRule): AutoRule => ruleWithFastMode(rule, rule.speed === 'fast')

/**
 * Drops an effort or a speed the runtime underneath has stopped offering. A form
 * left showing Max under a model that runs High is the same lie the composer's
 * menus refuse to tell, so the field follows the model rather than waiting for the
 * server to refuse the save.
 */
export const settled = (rule: AutoRule): AutoRule => ruleWithFastMode(
  {
    ...rule,
    effort: effortsFor(rule.driver, rule.model).some((option) => option.value === rule.effort) ? rule.effort : 'high',
  },
  rule.speed === 'fast' && supportsFastMode(rule.driver, rule.model),
)

const payloadFrom = (rows: RuleRow[]): AutoRulesDraft =>
  Object.fromEntries(rows.map((row) => [row.key.trim(), cleanRule(row.rule)]))

/**
 * Every row's problems, checked against the schemas the server saves with, so the
 * words under a field are the words the refusal would have used. Duplicate keys are
 * this side's own check: two rows with one key collapse into a single entry, which a
 * whole-file parse can only see as the rule that survived.
 */
export function problemsFor(rows: RuleRow[]): Map<string, RuleProblems> {
  const uses = new Map<string, number>()
  for (const row of rows) uses.set(row.key.trim(), (uses.get(row.key.trim()) ?? 0) + 1)

  const problems = new Map<string, RuleProblems>()
  for (const row of rows) {
    const found: RuleProblems = {}
    const key = row.key.trim()
    const parsedKey = AutoRuleKeySchema.safeParse(key)
    if (key === '') found.key = 'a rule needs a key'
    else if (!parsedKey.success) found.key = parsedKey.error.issues[0]?.message ?? 'not a usable key'
    else if ((uses.get(key) ?? 0) > 1) found.key = 'another rule already uses this key'

    const parsed = AutoRuleSchema.safeParse(cleanRule(row.rule))
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]
        if (field === 'description' || field === 'driver' || field === 'model' || field === 'effort' || field === 'speed') {
          found[field] = issue.message
        }
      }
    }
    if (Object.keys(found).length > 0) problems.set(row.id, found)
  }
  return problems
}

interface AutoRulesPageProps {
  /** Null until the file has been read. Nothing may be saved over an unread file. */
  rules: AutoRules | null
  notice: Notice | null
  requestEvents: RequestEvents
  onSave: (rules: AutoRulesDraft, requestId: string) => boolean
  onDismissNotice: () => void
  /** Whether the form holds an edit not saved yet, for the guard on every way out. */
  onDirtyChange: (dirty: boolean) => void
  /** Reads the file on the way in: it changes about as often as it is opened. */
  onRequest: () => void
}

/**
 * The Auto mode rule file as a form. Auto reads one description per category to
 * place an assignment, then runs it on the runtime that category names; this is
 * where those categories are written, added and removed.
 *
 * A save replaces the file whole, which is why an unread file disables both Save and
 * Add: a form seeded from nothing would otherwise write its own emptiness over six
 * rules. The server validates again and answers a bad rule with the reason, so the
 * checks here are the same schemas run early rather than a second set of rules.
 */
export function AutoRulesPage({ rules, notice, requestEvents, onSave, onDismissNotice, onDirtyChange, onRequest }: AutoRulesPageProps) {
  const reduce = useReducedMotion() ?? false
  const [rows, setRows] = useState<RuleRow[]>(() => (rules === null ? [] : rowsFrom(rules)))
  // The file arrives after the dialog opens on a first run. It seeds the form only
  // while nothing has been typed: a broadcast landing mid-edit must not take the
  // draft with it.
  const [touched, setTouched] = useState(false)
  const [showProblems, setShowProblems] = useState(false)
  const [addedId, setAddedId] = useState<string | null>(null)
  const request = useRequest(requestEvents)

  useEffect(() => onRequest(), [onRequest])

  useEffect(() => {
    if (touched || rules === null) return
    setRows((current) => rowsFrom(rules, current))
  }, [rules, touched])

  // The rows as they stand when an answer arrives, which may be after more typing.
  const latestRows = useRef(rows)
  latestRows.current = rows

  const problems = problemsFor(rows)
  const dirty = touched && rules !== null && JSON.stringify(payloadFrom(rows)) !== JSON.stringify(rules)
  const canSave = rules !== null && dirty && !request.pending
  useUnsavedGuard(dirty, onDirtyChange)

  const edit = (next: (current: RuleRow[]) => RuleRow[]) => {
    setTouched(true)
    setRows(next)
  }

  const editRule = (id: string, next: (rule: AutoRule) => AutoRule) => {
    edit((current) => current.map((row) => (row.id === id ? { ...row, rule: next(row.rule) } : row)))
  }

  const addRule = () => {
    const id = crypto.randomUUID()
    setAddedId(id)
    edit((current) => [...current, { id, key: '', rule: newRule() }])
  }

  const save = () => {
    if (!canSave) return
    if (rows.length === 0 || problems.size > 0) {
      setShowProblems(true)
      return
    }
    // Once the save lands, the broadcast file seeds the form again, unless typing went
    // on while it was out: those rows stay, now an edit against the file just written.
    const payload = payloadFrom(rows)
    const sent = JSON.stringify(payload)
    request.start((requestId) => onSave(payload, requestId), {
      onAck: () => {
        setShowProblems(false)
        if (JSON.stringify(payloadFrom(latestRows.current)) === sent) setTouched(false)
      },
    })
  }

  const discard = () => {
    setShowProblems(false)
    setTouched(false)
    if (rules !== null) setRows((current) => rowsFrom(rules, current))
  }

  return (
    <SettingsPage
      title="Auto mode rules"
      description="Auto matches an assignment against these descriptions, then runs it on the runtime that rule names. One file for every project."
      onSaveShortcut={save}
    >
      {rules === null ? (
        <p className="m-0 px-0.5 text-label text-muted">Reading the rule file…</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          <AnimatePresence initial={false}>
            {rows.map((row, index) => (
              <motion.li
                key={row.id}
                className="m-0 overflow-hidden"
                // Only a rule someone just added grows into place. The file's own rules
                // arrive after this list has mounted, so `AnimatePresence initial` cannot
                // see them, and six rows springing open read as the dialog assembling
                // itself rather than as anything anyone did.
                initial={row.id === addedId && !reduce ? { height: 0, opacity: 0 } : false}
                animate={{ height: 'auto', opacity: 1 }}
                exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                transition={reduce ? INSTANT : { height: SPRING_PANEL, opacity: { duration: 0.24 } }}
              >
                <RuleFields
                  row={row}
                  first={index === 0}
                  autoFocus={row.id === addedId}
                  problems={showProblems ? problems.get(row.id) ?? {} : {}}
                  onKeyChange={(key) => edit((current) => current.map((item) => (item.id === row.id ? { ...item, key } : item)))}
                  onRuleChange={(next) => editRule(row.id, next)}
                  onRemove={() => edit((current) => current.filter((item) => item.id !== row.id))}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {/* The one refusal with no field to hang it on, so the line that states the
          requirement is the line that turns when a save is tried against nothing. */}
      {rules !== null && rows.length === 0 ? (
        <p className={`m-0 px-0.5 text-label ${showProblems ? 'text-danger' : 'text-muted'}`}>
          No rules. Auto has nothing to choose from until there is at least one.
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <Button
          variant="secondary"
          size="small"
          className="flex items-center gap-1.5 self-start"
          disabled={rules === null}
          onClick={addRule}
        >
          <Icon icon={PlusSignIcon} size={13} />
          Add a rule
        </Button>
        {/* Fixed, because the classifier owns it: the key exists whatever this file
            says, and a form that silently refuses the word is worse than one that
            says who already has it. */}
        <p className="m-0 px-0.5 text-label text-dim">
          “{AUTO_RULE_DEFER_KEY}” is the classifier’s own answer when no rule fits, so no rule may be called that.
        </p>
      </div>

      {notice === null ? null : <RequestNotice notice={notice} onDismiss={onDismissNotice} />}

      <SaveBar dirty={dirty} pending={request.pending} canSave={canSave} saveLabel="Save rules" onSave={save} onDiscard={discard} />
    </SettingsPage>
  )
}

/**
 * One rule: what the classifier matches on, and the runtime it lands on. The runtime
 * fields are the persona form's row of Provider, Model and Effort, under the smaller
 * labels the runtime menus use for the same three words, because this row repeats
 * once per rule and the dialog's own label size read as six stacked forms.
 */
function RuleFields({
  row,
  first,
  autoFocus,
  problems,
  onKeyChange,
  onRuleChange,
  onRemove,
}: {
  row: RuleRow
  first: boolean
  autoFocus: boolean
  problems: RuleProblems
  onKeyChange: (key: string) => void
  onRuleChange: (next: (rule: AutoRule) => AutoRule) => void
  onRemove: () => void
}) {
  const { rule } = row
  const models = MODELS[rule.driver]
  const fastCapable = supportsFastMode(rule.driver, rule.model)

  return (
    <div className={`flex flex-col gap-3 ${first ? '' : 'mt-5 border-t border-line pt-5'}`}>
      <div className="flex items-end gap-3">
        <Field label="Key" problem={problems.key} className="w-[220px] flex-none">
          <input
            className={formInputClass}
            value={row.key}
            placeholder="bug-fix-performance"
            autoFocus={autoFocus}
            aria-label="Rule key"
            onChange={(event) => onKeyChange(event.target.value)}
          />
        </Field>
        <div className="flex flex-1 justify-end">
          <IconButton
            icon={Delete02Icon}
            label={`Remove ${row.key.trim() === '' ? 'this rule' : row.key.trim()}`}
            onClick={onRemove}
          />
        </div>
      </div>

      <Field label="When Auto should pick it" problem={problems.description}>
        <textarea
          className={`${formInputClass} min-h-[92px] resize-y leading-relaxed`}
          value={rule.description}
          placeholder="Diagnose or fix a defect, investigate performance, iterate against a concrete technical check."
          aria-label="Rule description"
          onChange={(event) => {
            const description = event.target.value
            onRuleChange((current) => ({ ...current, description }))
          }}
        />
      </Field>

      <div className="flex items-end gap-3">
        <Field label="Provider" problem={problems.driver} className="w-[168px] flex-none">
          <Select
            label="Provider"
            value={rule.driver}
            options={RULE_PROVIDERS}
            onChange={(driver: DriverName) =>
              onRuleChange((current) =>
                settled({
                  ...current,
                  driver,
                  model: MODELS[driver].some((option) => option.value === current.model)
                    ? current.model
                    : defaultModel(driver) ?? '',
                }),
              )
            }
          />
        </Field>
        <Field label="Model" problem={problems.model} className="min-w-0 flex-1">
          <Select
            label="Model"
            value={rule.model}
            options={models}
            onChange={(model) => onRuleChange((current) => settled({ ...current, model }))}
          />
        </Field>
        <Field label="Reasoning" problem={problems.effort} className="flex-none">
          <div className="flex items-center gap-1">
            <div className="w-[132px]">
              <Select
                label="Reasoning"
                value={rule.effort}
                options={effortsFor(rule.driver, rule.model)}
                onChange={(effort: Effort) => onRuleChange((current) => ({ ...current, effort }))}
              />
            </div>
            {/* Only where the CLI has one. A Fast bolt on a model without a fast mode is a
                setting that would be refused on save. */}
            {fastCapable ? (
              <IconButton
                icon={rule.speed === 'fast' ? FlashSolidIcon : FlashIcon}
                solid={rule.speed === 'fast'}
                swapKey={rule.speed ?? 'standard'}
                label="Fast mode"
                selected={rule.speed === 'fast'}
                aria-pressed={rule.speed === 'fast'}
                onClick={() => onRuleChange((current) => ruleWithFastMode(current, current.speed !== 'fast'))}
              />
            ) : null}
          </div>
        </Field>
      </div>
    </div>
  )
}

/**
 * A field in a repeated row: the compact label the runtime menus give the same
 * words, and the server's reason under it once a save has been tried.
 */
function Field({
  label,
  problem,
  className = '',
  children,
}: {
  label: string
  problem?: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <span className="text-meta font-medium text-dim">{label}</span>
      {children}
      {problem === undefined ? null : <span className="text-label text-danger">{problem}</span>}
    </div>
  )
}
