import { z } from 'zod'

const responseSchema = z.object({
  answers: z.record(z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
  })),
})

export type TypesafeChoiceResult =
  | { choice: string; confidence: number }
  | { reason: 'missing_key' | 'timeout' | 'api_error' | 'http_error' | 'invalid_response' | 'unknown_choice' | 'low_confidence'; confidence?: number; httpStatus?: number }

/**
 * One bounded request. Missing credentials and provider failures leave the caller's fallback in charge.
 * `minConfidence` is per caller: Jev's scores run low, so a router whose wrong pick is cheap can accept more.
 */
export async function typesafeChoice(
  apiKey: string | undefined,
  state: unknown,
  instructions: string,
  criteria: Record<string, string>,
  minConfidence = 0.7,
): Promise<TypesafeChoiceResult> {
  const key = apiKey?.trim()
  if (!key) return { reason: 'missing_key' }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<TypesafeChoiceResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ reason: 'timeout' })
      controller.abort()
    }, 1_000)
  })
  const evaluate = async (): Promise<TypesafeChoiceResult> => {
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'jev-latest',
        state,
        questions: { route: { type: 'choice', instructions, criteria } },
      }),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { reason: 'http_error', httpStatus: response.status }
    }
    const parsed = responseSchema.safeParse(await response.json().catch(() => undefined))
    const route = parsed.success ? parsed.data.answers.route : undefined
    if (route === undefined) return { reason: 'invalid_response' }
    if (!Object.hasOwn(criteria, route.choice)) return { reason: 'unknown_choice' }
    if (route.confidence < minConfidence) return { reason: 'low_confidence', confidence: route.confidence }
    return { choice: route.choice, confidence: route.confidence }
  }
  try {
    // Provider errors and bodies can contain chat text or credentials. Never log them.
    return await Promise.race([evaluate().catch((): TypesafeChoiceResult => ({ reason: 'api_error' })), timedOut])
  } finally {
    clearTimeout(timer)
  }
}
