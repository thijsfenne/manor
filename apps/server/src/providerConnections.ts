import { spawn } from 'node:child_process'
import type { Driver, ProviderConnection, ProviderSignIn, ServerMessage } from '@manor/contracts'

/**
 * Which provider CLIs are installed and signed in, and the one action a new user
 * needs here: sign in. Knows no CLI. It asks each driver about its own runtime and
 * account, and starts the sign-in command the driver hands it. That command opens
 * the browser on the Mac; no credential ever passes through Manor.
 */

type Provider = ProviderConnection['provider']

/** Reading order of the rows, everywhere they show. */
const ORDER: readonly Provider[] = ['claude', 'codex', 'grok', 'cursor']
const NAMES: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', cursor: 'Cursor' }
/** A browser sign-in somebody walked away from is given up on after this long. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000

/** An install downloads a few hundred megabytes; past this it is stuck, not slow. */
const INSTALL_TIMEOUT_MS = 15 * 60_000

/** The one state a row shows. Not installed wins, then a sign-in under way, then what the CLI said. */
export function connectionState(facts: { installed: boolean; signedIn: boolean | null; signingIn: boolean; installing?: boolean }): ProviderConnection['state'] {
  if (!facts.installed) return facts.installing === true ? 'installing' : 'install'
  if (facts.signingIn) return 'signing_in'
  if (facts.signedIn === true) return 'ready'
  return facts.signedIn === false ? 'sign_in' : 'attention'
}

export interface SignInProcess {
  /** Called once, with the exit code or null when the command could not run or was stopped. */
  onExit(listener: (code: number | null) => void): void
  stop(): void
}
export type StartSignIn = (signIn: ProviderSignIn) => SignInProcess

const startSignInProcess: StartSignIn = ({ command, args, env }) => {
  const child = spawn(command, args, { env, stdio: 'ignore' })
  return {
    onExit: (listener) => {
      let told = false
      const tell = (code: number | null) => {
        if (told) return
        told = true
        listener(code)
      }
      child.once('error', () => tell(null))
      child.once('exit', tell)
    },
    stop: () => { child.kill('SIGTERM') },
  }
}

export interface ProviderConnectionOptions {
  drivers: Partial<Record<Provider, Driver>>
  broadcast: (message: ServerMessage) => void
  /** Starts a provider command, the sign-in or the installer. Injected by tests. */
  startSignIn?: StartSignIn
  signInTimeoutMs?: number
  installTimeoutMs?: number
}

export class ProviderConnectionService {
  private readonly rows = new Map<Provider, ProviderConnection>()
  private readonly signingIn = new Map<Provider, { process: SignInProcess; timer: NodeJS.Timeout }>()
  private readonly installing = new Map<Provider, { process: SignInProcess; timer: NodeJS.Timeout }>()
  /** Why the last sign-in did not finish; shown until the next attempt or a signed-in check. */
  private readonly failures = new Map<Provider, string>()
  private readonly providers: Provider[]
  private clients = 0
  private asked = new Map<Provider, number>()
  private checking?: Promise<void>

  constructor(private readonly options: ProviderConnectionOptions) {
    this.providers = ORDER.filter((provider) => options.drivers[provider]?.describeRuntime !== undefined)
  }

  message(): Extract<ServerMessage, { type: 'provider_connections' }> {
    return { type: 'provider_connections', providers: this.providers.flatMap((provider) => this.rows.get(provider) ?? []) }
  }

  /** The zero-to-one client edge asks at once, so the first screen never shows a stale row. */
  setClientCount(count: number): void {
    const had = this.clients
    this.clients = count
    if (count > 0 && had === 0) void this.check()
  }

  /** Asks every provider again and tells every client. Calls that overlap share one round. */
  check(): Promise<void> {
    this.checking ??= Promise.all(this.providers.map((provider) => this.probe(provider)))
      .then(() => this.options.broadcast(this.message()))
      .finally(() => { this.checking = undefined })
    return this.checking
  }

  /**
   * Providers worth giving a side job right now, in the fixed order. One that is
   * missing or signed out is skipped; one that was never asked, or that did not say,
   * still counts, so a job is not silently dropped on a guess.
   */
  usable(): Provider[] {
    return this.providers.filter((provider) => {
      const state = this.rows.get(provider)?.state
      return state === undefined || state === 'ready' || state === 'attention'
    })
  }

  private async probe(provider: Provider): Promise<ProviderConnection> {
    // Probes overlap: a check that began before a sign-in finished can answer after
    // the probe that saw the login. Only the newest one asked may write the row.
    const asked = (this.asked.get(provider) ?? 0) + 1
    this.asked.set(provider, asked)
    const driver = this.options.drivers[provider]
    const runtime = await driver?.describeRuntime?.().catch(() => undefined)
    const installed = runtime?.version != null
    const account = installed ? await driver?.describeAccount?.().catch(() => undefined) ?? { signedIn: null } : { signedIn: null }
    if (account.signedIn === true) this.failures.delete(provider)
    const state = connectionState({ installed, signedIn: account.signedIn, signingIn: this.signingIn.has(provider), installing: this.installing.has(provider) })
    const message = state === 'attention'
      ? `${NAMES[provider]} is installed, but it did not say whether it is signed in.`
      : state === 'sign_in' || state === 'install' ? this.failures.get(provider) : undefined
    const row: ProviderConnection = {
      provider,
      installed,
      version: runtime?.version ?? null,
      signedIn: account.signedIn,
      ...(account.account === undefined ? {} : { account: account.account }),
      ...(account.plan === undefined ? {} : { plan: account.plan }),
      state,
      ...(message === undefined ? {} : { message }),
      canSignIn: installed && driver?.signInCommand !== undefined,
      canInstall: !installed && driver?.installCommand !== undefined,
    }
    // The caller still gets what this probe read: the install and sign-in exits decide from it.
    if (this.asked.get(provider) === asked) this.rows.set(provider, row)
    return row
  }

  private async refresh(provider: Provider): Promise<ProviderConnection> {
    const row = await this.probe(provider)
    this.options.broadcast(this.message())
    return row
  }

  /** Starts the provider's own sign-in. A second request while one is open does nothing. */
  async signIn(provider: Provider): Promise<void> {
    if (this.signingIn.has(provider) || !this.providers.includes(provider)) return
    this.failures.delete(provider)
    const command = await this.options.drivers[provider]?.signInCommand?.().catch(() => null)
    if (command == null) {
      this.failures.set(provider, `${NAMES[provider]} cannot be signed in from here yet.`)
      await this.refresh(provider)
      return
    }
    if (this.signingIn.has(provider)) return
    const process = (this.options.startSignIn ?? startSignInProcess)(command)
    const timer = setTimeout(() => process.stop(), this.options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS)
    timer.unref?.()
    this.signingIn.set(provider, { process, timer })
    process.onExit(() => {
      clearTimeout(timer)
      this.signingIn.delete(provider)
      // The exit code is not the answer; the CLI's own status afterwards is.
      void this.probe(provider).then(async (row) => {
        if (row.signedIn !== true) {
          this.failures.set(provider, 'Sign in did not finish. Try again.')
          await this.probe(provider)
        }
        this.options.broadcast(this.message())
      })
    })
    await this.refresh(provider)
  }

  /**
   * Runs the provider's own installer for a CLI that is missing, on the user's click.
   * Whether it worked is read from the CLI afterwards, not from the exit code.
   */
  async install(provider: Provider): Promise<void> {
    if (this.installing.has(provider) || !this.providers.includes(provider)) return
    const driver = this.options.drivers[provider]
    if (driver?.installCommand === undefined) return
    // Asked again here: a CLI that appeared meanwhile is not installed a second time.
    if ((await this.probe(provider)).installed) {
      this.options.broadcast(this.message())
      return
    }
    this.failures.delete(provider)
    const command = await driver.installCommand().catch(() => null)
    if (command === null || this.installing.has(provider)) return
    const process = (this.options.startSignIn ?? startSignInProcess)(command)
    const timer = setTimeout(() => process.stop(), this.options.installTimeoutMs ?? INSTALL_TIMEOUT_MS)
    timer.unref?.()
    this.installing.set(provider, { process, timer })
    process.onExit(() => {
      clearTimeout(timer)
      this.installing.delete(provider)
      void this.probe(provider).then(async (row) => {
        if (!row.installed) {
          this.failures.set(provider, `${NAMES[provider]} did not install. Check the connection and try again.`)
          await this.probe(provider)
        }
        this.options.broadcast(this.message())
      })
    })
    await this.refresh(provider)
  }

  /** Stops waiting for a sign-in, or stops an install, the user gave up on. */
  cancel(provider: Provider): void {
    this.signingIn.get(provider)?.process.stop()
    this.installing.get(provider)?.process.stop()
  }

  stop(): void {
    for (const { process, timer } of [...this.signingIn.values(), ...this.installing.values()]) {
      clearTimeout(timer)
      process.stop()
    }
  }
}
