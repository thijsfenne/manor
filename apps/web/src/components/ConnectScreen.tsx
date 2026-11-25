import { useState, type FormEvent } from 'react'
import { parsePairingLink } from '@manor/contracts'
import { NOT_A_PAIRING_LINK } from '@manor/client-runtime/pairing'

/**
 * The door for a browser that is not paired yet. Pairing happens on the Mac: Settings →
 * Phone makes a one-time link, and opening it here redeems it. A pasted link is opened
 * the same way, so there is one path in.
 */
export function ConnectScreen({ error }: { error: string | null }) {
  const [link, setLink] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (parsePairingLink(link) === null) {
      setProblem(NOT_A_PAIRING_LINK)
      return
    }
    if (!/^https?:/i.test(link.trim())) {
      setProblem('This link is for the Manor app. On your Mac, choose Pair a browser instead.')
      return
    }
    window.location.assign(link.trim())
  }

  const shown = problem ?? error
  return (
    <main className="grid h-full place-items-center p-6 text-[13px] text-dim">
      <form className="flex w-full max-w-[360px] flex-col gap-3 rounded-xl border border-line bg-surface p-6" onSubmit={submit}>
        <h1 className="m-0 font-display text-[16px] font-semibold tracking-[0.02em] text-text">Connect to your Mac</h1>
        <p className="mt-[-4px] mb-1 text-[13px] leading-relaxed text-muted">
          In Manor on your Mac, open Settings → Phone and choose Make link. Open the link in this browser, or paste it here.
        </p>
        <input
          aria-label="Paste the pairing link"
          className="w-full rounded-lg border border-line bg-field px-2.5 py-[7px] text-[13px] text-text outline-none focus:border-field-focus [font:inherit]"
          placeholder="Paste the pairing link"
          autoFocus
          value={link}
          onChange={(event) => { setLink(event.target.value); setProblem(null) }}
        />
        {shown === null ? null : <p className="m-0 text-[12px] text-danger" role="alert">{shown}</p>}
        <button
          type="submit"
          className="mt-1 cursor-pointer rounded-button border border-transparent bg-primary px-3.5 py-[7px] text-[13px] font-medium text-on-primary not-disabled:hover:bg-primary-hover disabled:cursor-default disabled:opacity-[0.45]"
          disabled={link.trim() === ''}
        >
          Connect
        </button>
      </form>
    </main>
  )
}
