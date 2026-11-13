import { describe, expect, it, vi } from 'vitest'
import { InteractionBroker, type UserInputRecorder } from '../src/interactionBroker.js'
import { POSTED_SECRET_NOTE, SecretRequests, runWithSecret, secretScrubber, type SecretRequestDeps } from '../src/secretRequests.js'
import { until } from './helpers.js'
import type { UserInputQuestion } from '@manor/contracts'

const SENTINEL = 'sentinel+Value/9=='
const context = { chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', commandCwd: process.cwd() }
const commandInput = { label: 'API token', reason: 'To call the API.', target: 'command' as const, command: 'printf "%s" "$API_TOKEN"', env: 'API_TOKEN' }

function harness(deps: Partial<SecretRequestDeps> = {}) {
  const recorded: { asked: UserInputQuestion[][]; answers: unknown[] } = { asked: [], answers: [] }
  const ids: string[] = []
  const recorder: UserInputRecorder = {
    request: async (_context, requestId, questions) => {
      ids.push(requestId)
      recorded.asked.push(questions)
      return true
    },
    response: async (_context, _requestId, answers) => {
      recorded.answers.push(answers)
      return true
    },
  }
  const interactions = new InteractionBroker(recorder)
  const secrets = new SecretRequests({
    interactions,
    passwordPage: async () => { throw new Error('No page.') },
    ...deps,
  })
  const card = async () => {
    await until(() => ids.length > 0, 'the card')
    return ids.at(-1)!
  }
  return { secrets, interactions, recorded, card }
}

describe('SecretRequests', () => {
  it('asks one value on a card that names the command, and only Manor can shape it', async () => {
    const { secrets, recorded, card } = harness()
    const asked = secrets.request(context, commandInput, false)
    secrets.answer('chat_1', await card(), undefined)
    await asked
    expect(recorded.asked).toEqual([[expect.objectContaining({
      header: 'API token',
      question: 'To call the API.',
      optionsOnly: true,
      desktopOnly: true,
      secret: { target: 'command', command: commandInput.command, env: 'API_TOKEN' },
    })]])
  })

  it('runs the command with the value, tells the agent the scrubbed outcome and records only a label', async () => {
    const { secrets, recorded, card } = harness()
    const asked = secrets.request(context, commandInput, false)
    expect(secrets.answer('chat_1', await card(), SENTINEL)).toBe(true)
    const result = await asked
    expect(JSON.parse(result)).toEqual({ status: 'used', exitCode: 0, output: '[secret hidden]' })
    expect(recorded.answers).toEqual([{ secret: 'Used once' }])
  })

  it('reports a failing command with its exit code and no value', async () => {
    const { secrets, card } = harness()
    const asked = secrets.request(context, { ...commandInput, command: 'echo "bad $API_TOKEN" >&2; exit 3' }, false)
    secrets.answer('chat_1', await card(), SENTINEL)
    expect(JSON.parse(await asked)).toEqual({ status: 'used', exitCode: 3, output: 'bad [secret hidden]\n' })
  })

  it('gives the child nothing else from the server environment', async () => {
    vi.stubEnv('MANOR_TEST_PRIVATE', 'do-not-pass')
    const { secrets, card } = harness()
    const asked = secrets.request(context, { ...commandInput, command: 'echo "[$MANOR_TEST_PRIVATE]"' }, false)
    secrets.answer('chat_1', await card(), SENTINEL)
    expect(JSON.parse(await asked)).toMatchObject({ output: '[]\n' })
    vi.unstubAllEnvs()
  })

  it('tells the agent not to ask again after a decline', async () => {
    const { secrets, recorded, card } = harness()
    const asked = secrets.request(context, commandInput, false)
    secrets.answer('chat_1', await card(), undefined)
    expect(JSON.parse(await asked)).toMatchObject({ status: 'declined', note: expect.stringContaining('Do not ask') })
    expect(recorded.answers).toEqual([{ secret: 'Declined' }])
  })

  it('times out with a clear result and closes the card', async () => {
    const { secrets, recorded, card } = harness({ timeoutMs: 5 })
    const asked = secrets.request(context, commandInput, false)
    const requestId = await card()
    expect(JSON.parse(await asked)).toMatchObject({ status: 'timed_out' })
    expect(recorded.answers).toEqual([{ secret: 'Timed out' }])
    expect(secrets.answer('chat_1', requestId, SENTINEL)).toBe(false)
  })

  it('takes one answer only, in its own chat', async () => {
    const { secrets, card } = harness()
    const asked = secrets.request(context, commandInput, false)
    const requestId = await card()
    expect(secrets.answer('another_chat', requestId, SENTINEL)).toBe(false)
    expect(secrets.answer('chat_1', requestId, SENTINEL)).toBe(true)
    expect(secrets.answer('chat_1', requestId, SENTINEL)).toBe(false)
    await asked
  })

  it('refuses an ordinary answer, so a value cannot enter the transcript as one', async () => {
    const { secrets, interactions, card } = harness()
    const asked = secrets.request(context, commandInput, false)
    const requestId = await card()
    await expect(interactions.answer('chat_1', requestId, { secret: SENTINEL })).resolves.toBe(false)
    secrets.answer('chat_1', requestId, undefined)
    await asked
  })

  it('says a request is gone rather than taking a value for it, as after a restart', () => {
    expect(harness().secrets.answer('chat_1', 'from_before_the_restart', SENTINEL)).toBe(false)
  })

  it('Stop ends a waiting card', async () => {
    const { secrets, interactions, card } = harness()
    const asked = secrets.request(context, commandInput, false)
    const requestId = await card()
    interactions.closeTurn('turn_1')
    secrets.closeTurn('turn_1')
    await expect(asked).rejects.toThrow('The turn ended')
    expect(secrets.answer('chat_1', requestId, SENTINEL)).toBe(false)
  })

  it('Stop ends a command that holds the value', async () => {
    const { secrets, interactions, card } = harness()
    const asked = secrets.request(context, { ...commandInput, command: 'sleep 30' }, false)
    const requestId = await card()
    secrets.answer('chat_1', requestId, SENTINEL)
    interactions.closeTurn('turn_1')
    secrets.closeTurn('turn_1')
    await expect(asked).rejects.toThrow('The turn ended')
    expect(secrets.answer('chat_1', requestId, SENTINEL)).toBe(false)
  })

  it('stops a command that outlives its limit', async () => {
    const { secrets, card } = harness({ commandTimeoutMs: 20 })
    const asked = secrets.request(context, { ...commandInput, command: 'sleep 30' }, false)
    secrets.answer('chat_1', await card(), SENTINEL)
    expect(JSON.parse(await asked)).toMatchObject({ status: 'used', timedOut: true })
  })

  it('a posted card returns at once and hands the result to the next attempt', async () => {
    const { secrets, interactions, card } = harness()
    await expect(secrets.request(context, commandInput, true)).resolves.toBe(POSTED_SECRET_NOTE)
    secrets.answer('chat_1', await card(), SENTINEL)
    await until(() => !interactions.waiting('turn_1'), 'the outcome')
    const [answered] = interactions.takeAnswered('turn_1')
    expect(JSON.parse(answered?.toolResult ?? '')).toMatchObject({ status: 'used', output: '[secret hidden]' })
  })

  it('refuses a turn without the user, a turn without a shell and a bad env name before any card', async () => {
    const { secrets, recorded } = harness()
    await expect(secrets.request({ ...context, canApprove: false }, commandInput, false)).rejects.toThrow('Nobody is here')
    const { commandCwd: _shell, ...noShell } = context
    await expect(secrets.request(noShell, commandInput, false)).rejects.toThrow('no shell')
    await expect(secrets.request(context, { ...commandInput, env: 'path; rm' }, false)).rejects.toThrow('env name')
    expect(recorded.asked).toEqual([])
  })

  it('names the page on a browser card and scrubs a failed fill', async () => {
    const fill = vi.fn(async (value: string) => { throw new Error(`Could not fill ${value}`) })
    const { secrets, recorded, card } = harness({ passwordPage: async () => ({ site: 'github.com', fill }) })
    const asked = secrets.request(context, { label: 'Password', reason: 'To sign in.', target: 'browser' }, false)
    secrets.answer('chat_1', await card(), SENTINEL)
    const result = await asked
    expect(recorded.asked[0]?.[0]?.secret).toEqual({ target: 'browser', site: 'github.com' })
    expect(fill).toHaveBeenCalledWith(SENTINEL)
    expect(result).not.toContain(SENTINEL)
    expect(JSON.parse(result)).toMatchObject({ status: 'failed', reason: 'Could not fill [secret hidden]' })
    expect(recorded.answers).toEqual([{ secret: 'Not delivered' }])
  })

  it('does not hang the turn when the outcome cannot be recorded', async () => {
    const recorder: UserInputRecorder = {
      request: async () => true,
      response: async () => { throw new Error('Disk full.') },
    }
    const interactions = new InteractionBroker(recorder)
    const ask = vi.spyOn(interactions, 'ask')
    const secrets = new SecretRequests({ interactions, passwordPage: async () => { throw new Error('No page.') }, timeoutMs: 5 })
    await expect(secrets.request(context, commandInput, false)).rejects.toThrow('could not be recorded')
    expect(ask).toHaveBeenCalledOnce()
  })
})

describe('secretScrubber', () => {
  it('hides the plain value and the encodings a tool commonly prints', () => {
    const scrub = secretScrubber(SENTINEL)
    const bytes = Buffer.from(SENTINEL)
    const text = [SENTINEL, encodeURIComponent(SENTINEL), bytes.toString('base64'), bytes.toString('base64url')].join(' ')
    expect(scrub(text)).toBe('[secret hidden] [secret hidden] [secret hidden] [secret hidden]')
  })
})

describe('runWithSecret', () => {
  const run = (command: string, value: string) => runWithSecret({
    command,
    env: 'API_TOKEN',
    cwd: process.cwd(),
    value,
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  })

  it('hides a long encoded value split across writes and past the output limit', async () => {
    const value = 'x'.repeat(16_000)
    const encoded = Buffer.from(value).toString('base64')
    const { output } = await run(
      `printf %s "$API_TOKEN" | base64 | tr -d '\\n' > /tmp/manor-secret-$$; head -c 9000 /tmp/manor-secret-$$; sleep 0.1; tail -c +9001 /tmp/manor-secret-$$; rm /tmp/manor-secret-$$`,
      value,
    )
    expect(output).toBe('[secret hidden]')
    expect(output).not.toContain(encoded.slice(-100))
  })

  it('ends what the command left running, so the value does not outlive it', async () => {
    const { output } = await run('sleep 30 >/dev/null 2>&1 & echo $!', 'long-enough')
    const pid = Number(output.trim())
    expect(pid).toBeGreaterThan(1)
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 'the background process to end')
  })
})
