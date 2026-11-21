import { randomUUID } from 'node:crypto'
import {
  USER_INPUT_ANSWER_MAX,
  userInputAnswerText,
  type PreferenceSource,
  type UserInputAnswers,
  type UserInputQuestion,
} from '@manor/contracts'
import type { UserInputContext } from './interactionCapability.js'
import type { TurnIdleGate } from './drivers/turnTimers.js'

interface PendingRequest extends UserInputContext {
  questions: UserInputQuestion[]
  answering: boolean
  /** The provider waits on this call, so the turn's idle clock stays paused. */
  held: boolean
  /** No provider call waits any more; the answer goes to the turn's next attempt. */
  detached: boolean
  /** The user steered past it: still answerable, but the turn no longer waits for it. */
  superseded: boolean
  resolve(answered: GivenAnswer): void
  reject(error: Error): void
}

/** An answer, and the preference line when Manor gave it instead of the user. */
export interface GivenAnswer {
  answers: UserInputAnswers
  fromPreference?: PreferenceSource
  /** What the agent reads instead of the answers, for a card that did the work itself. */
  toolResult?: string
}

/** A question whose answer arrived after the provider stopped waiting for it. */
export interface AnsweredQuestion extends GivenAnswer {
  requestId: string
  questions: UserInputQuestion[]
}

/** Closes every account of an answer Manor gave from a preference, live or replayed. */
export const PREFERENCE_ANSWER_GUARD =
  'The user did not pick this; Manor applied their standing preference. Never report it as their choice or as a new preference. If they want another answer, their own message will say so.'

/**
 * What the asking agent reads when Manor answered from a preference, the same words
 * whether its driver held the call or reads the answer on its next attempt.
 */
export const preferenceAnswerText = (
  questions: readonly UserInputQuestion[],
  answers: UserInputAnswers,
  source: PreferenceSource,
): string => [
  ...questions.map((question) => {
    const answer = answers[question.id]
    const chose = `Manor chose ${answer === undefined ? '(none)' : userInputAnswerText(answer)}, from ${source.file}: ${source.quote}`
    return questions.length === 1 ? chose : `${question.question}\n${chose}`
  }),
  PREFERENCE_ANSWER_GUARD,
].join('\n')

/**
 * What the turn runner needs to carry a question across provider attempts. A driver
 * that cannot hold a tool call open asks with `post`, and any attempt that ends with
 * its question still open leaves the answer to the next attempt of the same turn.
 */
export interface OpenQuestions {
  /** The attempt has ended: its open questions now wait for the next one. */
  detachTurn(turnId: string): void
  /**
   * A steering addition answered in words: the open questions stay answerable while
   * the turn runs, but the turn no longer waits on them once the provider is done. A
   * call the provider still holds stays held; it may yet return the answer itself.
   */
  supersede(turnId: string): void
  /** True while a question of this turn waits for an answer and holds the turn. */
  waiting(turnId: string): boolean
  /** Answers no provider has read yet, oldest first; taking them hands them over. */
  takeAnswered(turnId: string): AnsweredQuestion[]
  /** Resolves the next time a question of this turn is answered or closed. */
  changed(turnId: string): Promise<void>
}

export interface UserInputRecorder {
  request(context: UserInputContext, requestId: string, questions: UserInputQuestion[]): Promise<boolean>
  response(
    context: UserInputContext,
    requestId: string,
    answers: UserInputAnswers,
    fromPreference?: PreferenceSource,
  ): Promise<boolean>
  /** Open questions stopped holding their turn, so `pendingAsks` changed without an event. */
  superseded?(): void
}

export const answersMatch = (questions: readonly UserInputQuestion[], answers: UserInputAnswers): boolean => {
  if (Object.keys(answers).length !== questions.length) return false
  for (const question of questions) {
    const value = answers[question.id]
    if (value === undefined) return false
    if (typeof value === 'string') {
      if (value.trim().length === 0 || value.length > USER_INPUT_ANSWER_MAX) return false
      continue
    }
    if (question.multi !== true || !Array.isArray(value)) return false
    const unique = new Set(value)
    if (
      unique.size !== value.length ||
      value.length > question.options.length + 1 ||
      value.some((line) => line.trim().length === 0 || line.length > USER_INPUT_ANSWER_MAX)
    ) {
      return false
    }
  }
  return true
}

/**
 * What a question from `ask_user` may be. `optionsOnly`, `desktopOnly` and `secret` are
 * Manor's own: they shape a permission or secret card, so a model asking for them gets an ordinary
 * question back rather than an error.
 */
export const askedByModel = (questions: readonly UserInputQuestion[]): UserInputQuestion[] =>
  questions.map((question) => ({ ...question, optionsOnly: undefined, desktopOnly: undefined, secret: undefined }))

/**
 * Bridges one MCP tool call to durable transcript events and a UI answer. `request`
 * holds the call until the answer is durable; `post` returns once the question is,
 * and its answer reaches the turn through `OpenQuestions`.
 */
export class InteractionBroker implements OpenQuestions {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly answered = new Map<string, AnsweredQuestion[]>()
  private readonly watchers = new Map<string, Set<() => void>>()

  constructor(
    private readonly recorder: UserInputRecorder,
    private readonly idleGate?: Pick<TurnIdleGate, 'hold' | 'release'>,
  ) {}

  /**
   * Live waits, keyed by chat. What the directory listing reports as Waiting. A
   * superseded question stays answerable but no longer holds its turn, so it is left
   * out: a reconnecting client would otherwise read a working Session as waiting.
   */
  pendingAsks(): Record<string, string[]> {
    const byChat: Record<string, string[]> = {}
    for (const [requestId, pending] of this.pending) {
      if (pending.superseded) continue
      const held = byChat[pending.chatId]
      if (held === undefined) byChat[pending.chatId] = [requestId]
      else held.push(requestId)
    }
    return byChat
  }

  /** Holds the call until the answer is durable; Manor's own approvals read only the answers. */
  async request(context: UserInputContext, questions: UserInputQuestion[]): Promise<UserInputAnswers> {
    return (await this.ask(context, questions)).answers
  }

  /** `request` for `ask_user`, which also hears when Manor answered from a preference. */
  async ask(context: UserInputContext, questions: UserInputQuestion[], requestId: string = randomUUID()): Promise<GivenAnswer> {
    const answer = this.open(requestId, context, questions, false)
    try {
      if (!(await this.recorder.request(context, requestId, questions))) {
        throw new Error('This turn is no longer waiting for user input.')
      }
    } catch (error: unknown) {
      this.reject(requestId, error instanceof Error ? error : new Error('The question could not be recorded.'))
    }
    return await answer
  }

  /**
   * Records the question and returns without waiting, for a driver whose tool calls
   * time out long before the user answers. The card stays open until its turn ends.
   */
  async post(context: UserInputContext, questions: UserInputQuestion[], requestId: string = randomUUID()): Promise<void> {
    const answer = this.open(requestId, context, questions, true)
    // Nobody awaits a posted question's promise; its answer travels through `takeAnswered`.
    answer.catch(() => undefined)
    let recorded = false
    try {
      recorded = await this.recorder.request(context, requestId, questions)
    } catch (error: unknown) {
      this.reject(requestId, error instanceof Error ? error : new Error('The question could not be recorded.'))
      throw error
    }
    if (!recorded) {
      this.reject(requestId, new Error('This turn is no longer waiting for user input.'))
      throw new Error('This turn is no longer waiting for user input.')
    }
  }

  detachTurn(turnId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.turnId !== turnId) continue
      pending.detached = true
      this.unhold(pending)
    }
  }

  supersede(turnId: string): void {
    let changed = false
    for (const pending of this.pending.values()) {
      if (pending.turnId !== turnId || pending.superseded) continue
      pending.superseded = true
      changed = true
    }
    if (changed) this.recorder.superseded?.()
  }

  waiting(turnId: string): boolean {
    for (const pending of this.pending.values()) if (pending.turnId === turnId && !pending.superseded) return true
    return false
  }

  takeAnswered(turnId: string): AnsweredQuestion[] {
    const answered = this.answered.get(turnId) ?? []
    this.answered.delete(turnId)
    return answered
  }

  changed(turnId: string): Promise<void> {
    return new Promise((resolve) => {
      const watchers = this.watchers.get(turnId) ?? new Set()
      watchers.add(resolve)
      this.watchers.set(turnId, watchers)
    })
  }

  /**
   * First valid answer wins; persistence lands before the provider process resumes.
   * `fromPreference` is set only when the project thread answers from a quoted line.
   */
  async answer(chatId: string, requestId: string, answers: UserInputAnswers, fromPreference?: PreferenceSource): Promise<boolean> {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.chatId !== chatId || pending.answering) return false
    // A secret card answers only through `claimSecret`, so a typed value can never land
    // in the transcript as an answer, and no project thread answers one from a preference.
    if (!answersMatch(pending.questions, answers) || pending.questions.some((question) => question.secret !== undefined)) return false

    pending.answering = true
    return this.settle(requestId, pending, { answers, ...(fromPreference === undefined ? {} : { fromPreference }) })
  }

  /** Takes a waiting secret card off the table for its one answer. False when nothing waits. */
  claimSecret(chatId: string, requestId: string): boolean {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.chatId !== chatId || pending.answering) return false
    if (!pending.questions.some((question) => question.secret !== undefined)) return false
    pending.answering = true
    return true
  }

  /** Records how a claimed secret card ended. Only the outcome label reaches the transcript. */
  async closeSecret(requestId: string, outcome: string, toolResult: string): Promise<boolean> {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.questions[0] === undefined) return false
    pending.answering = true
    try {
      return await this.settle(requestId, pending, { answers: { [pending.questions[0].id]: outcome }, toolResult })
    } catch {
      // Nothing can retry this card, so the turn must not wait on it.
      this.reject(requestId, new Error('The outcome of the secret request could not be recorded.'))
      return false
    }
  }

  private async settle(requestId: string, pending: PendingRequest, given: GivenAnswer): Promise<boolean> {
    const { answers, fromPreference } = given
    const context = { chatId: pending.chatId, agentId: pending.agentId, turnId: pending.turnId }
    try {
      if (!(await this.recorder.response(context, requestId, answers, fromPreference))) {
        this.reject(requestId, new Error('This turn is no longer waiting for user input.'))
        return false
      }
      // The turn closed while the answer was being written: it is in the transcript,
      // but no attempt is left to read it, so nothing is kept for one.
      if (this.pending.get(requestId) !== pending) return true
      this.pending.delete(requestId)
      this.unhold(pending)
      if (pending.detached) {
        this.answered.set(pending.turnId, [
          ...this.answered.get(pending.turnId) ?? [],
          { requestId, questions: pending.questions, ...given },
        ])
      }
      pending.resolve(given)
      this.notify(pending.turnId)
      return true
    } catch (error: unknown) {
      pending.answering = false
      throw error
    }
  }

  closeTurn(turnId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.turnId === turnId) this.reject(requestId, new Error('The turn ended before the question was answered.'))
    }
    this.answered.delete(turnId)
    this.notify(turnId)
  }

  closeChat(chatId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.chatId === chatId) this.reject(requestId, new Error('The chat closed before the question was answered.'))
    }
  }

  private open(requestId: string, context: UserInputContext, questions: UserInputQuestion[], posted: boolean): Promise<GivenAnswer> {
    // A posted question holds no provider call, so nothing it pauses would resume.
    if (!posted) this.idleGate?.hold(context.chatId, context.agentId)
    return new Promise<GivenAnswer>((resolve, reject) => {
      this.pending.set(requestId, { ...context, questions, answering: false, held: !posted, detached: posted, superseded: false, resolve, reject })
    })
  }

  private unhold(pending: PendingRequest): void {
    if (!pending.held) return
    pending.held = false
    this.idleGate?.release(pending.chatId, pending.agentId)
  }

  private notify(turnId: string): void {
    const watchers = this.watchers.get(turnId)
    this.watchers.delete(turnId)
    for (const resolve of watchers ?? []) resolve()
  }

  private reject(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    this.unhold(pending)
    pending.reject(error)
    this.notify(pending.turnId)
  }
}
