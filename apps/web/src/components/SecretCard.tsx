import { useRef, useState, type FormEvent } from 'react'
import { secretCardNote, type UserInputQuestion } from '@manor/contracts'
import { accentStyle } from '../accent'
import { Button } from './ui/Button'
import { SIDE_SURFACE } from './ui/dockPanel'

/**
 * The private card behind `request_secret`. The value lives in this field's state and
 * nowhere else: no draft, no storage, and it is emptied the moment it is sent. Errors are
 * this card's own words, so a typed value can never come back as text.
 */
export function SecretCard({
  question,
  who,
  accent,
  connected,
  onAnswer,
}: {
  question: UserInputQuestion
  /** The persona, or the Session a project thread shows this for. */
  who: string
  accent: string
  connected: boolean
  /** No value declines. False when the socket did not take it. */
  onAnswer: (value?: string) => boolean
}) {
  const destination = question.secret
  const [value, setValue] = useState('')
  const [sent, setSent] = useState<'value' | 'decline' | null>(null)
  const [failed, setFailed] = useState(false)
  // State catches up a render late; a double Enter must not send twice.
  const answered = useRef(false)
  if (destination === undefined) return null

  const answer = (given?: string) => {
    if (answered.current) return
    answered.current = true
    setFailed(false)
    const taken = onAnswer(given)
    setValue('')
    if (taken) setSent(given === undefined ? 'decline' : 'value')
    else {
      answered.current = false
      setFailed(true)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (connected && value !== '') answer(value)
  }

  return (
    <div className={`flex w-full min-w-0 flex-col gap-3 rounded-2xl px-3.5 py-3 ${SIDE_SURFACE}`} style={accentStyle(accent)} role="group" aria-label={question.header ?? 'Secret request'}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-meta text-dim">{who} asks for a secret</span>
        <span className="text-[16px] leading-6 font-medium text-text [overflow-wrap:anywhere]">{question.header}</span>
        <span className="text-[14px] leading-5 text-muted [overflow-wrap:anywhere]">{question.question}</span>
      </div>
      {destination.target === 'command' ? (
        <pre className="m-0 max-h-32 overflow-auto rounded-lg border border-line bg-stage px-2.5 py-2 font-mono text-[12.5px] leading-[18px] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{destination.command}</pre>
      ) : null}
      <p className="m-0 text-[13px] leading-5 text-muted [overflow-wrap:anywhere]">{secretCardNote(destination)}</p>
      {/* No form name, no id and no saved-field hint: nothing here may feed a password
          manager. The form is for Enter alone. */}
      <form className="flex min-w-0 flex-col gap-2.5" autoComplete="off" onSubmit={submit}>
        <input
          type="password"
          aria-label={question.header ?? 'Secret value'}
          autoFocus
          value={value}
          disabled={sent !== null}
          placeholder="Enter the value"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          onChange={(event) => setValue(event.target.value)}
          className="w-full rounded-lg border border-line bg-stage px-2.5 py-[7px] text-[14px] text-text outline-none placeholder:text-dim focus:border-dim disabled:opacity-50"
        />
        <div className="flex min-w-0 items-center justify-end gap-2">
          <span className="min-w-0 flex-1 text-label">
            {!connected ? <span className="text-dim">Reconnecting</span> : null}
            {connected && failed ? <span className="text-warn">Could not send. Try again.</span> : null}
            {sent === 'value' ? <span className="text-dim">Using it once</span> : null}
          </span>
          <Button type="button" variant="ghost" size="compact" disabled={!connected || sent !== null} onClick={() => answer()}>Decline</Button>
          <Button type="submit" variant="primary" size="compact" disabled={!connected || sent !== null || value === ''}>Use once</Button>
        </div>
      </form>
    </div>
  )
}
