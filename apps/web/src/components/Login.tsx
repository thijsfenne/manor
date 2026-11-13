import { useState, type FormEvent } from 'react'

interface LoginProps {
  /** Resolves to the message to show, or null when the sign-in worked. */
  onSubmit: (email: string, password: string) => Promise<string | null>
}

/**
 * One card, centred, nothing else. This screen is seen once on a new machine and
 * then never again, so it gets no decoration and no marketing: the house asks who
 * you are and gets out of the way.
 */
export function Login({ onSubmit }: LoginProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canSubmit = email.trim() !== '' && password !== '' && !busy

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    void onSubmit(email.trim(), password)
      .then((message) => {
        // On success this form unmounts; only a failure has anything to say.
        setError(message)
      })
      .catch(() => setError('Could not reach the sign-in service.'))
      .finally(() => setBusy(false))
  }

  return (
    <main className="grid h-full place-items-center p-6 text-[13px] text-dim">
      <form
        className="flex w-full max-w-[320px] flex-col gap-3 rounded-xl border border-line bg-surface p-6"
        onSubmit={submit}
      >
        <h1 className="m-0 font-display text-[16px] font-semibold tracking-[0.02em] text-text">Manor</h1>
        <p className="mt-[-8px] mb-1 text-[12px] text-dim">Sign in to your workspace.</p>

        <label className="flex flex-col gap-[5px]">
          <span className="text-label text-muted">Email</span>
          <input
            className="w-full rounded-lg border border-line bg-surface-2 px-2.5 py-[7px] text-[13px] text-text outline-none focus:border-dim [font:inherit]"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="flex flex-col gap-[5px]">
          <span className="text-label text-muted">Password</span>
          <input
            className="w-full rounded-lg border border-line bg-surface-2 px-2.5 py-[7px] text-[13px] text-text outline-none focus:border-dim [font:inherit]"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {/* The local server's own wording, verbatim: a guessed message hides the real cause. */}
        {error === null ? null : (
          <p className="m-0 text-[12px] text-danger" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="mt-1 cursor-pointer rounded-button border border-transparent bg-primary px-3.5 py-[7px] text-[13px] font-medium text-on-primary hover:bg-primary-hover disabled:cursor-default disabled:opacity-[0.45]"
          disabled={!canSubmit}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
