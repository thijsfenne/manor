import type { TodoItem } from '@manor/contracts'

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null

const statusOf = (value: unknown, completed: unknown): TodoItem['status'] => {
  if (completed === true) return 'completed'
  if (value === 'in_progress' || value === 'in-progress' || value === 'doing' || value === 'TODO_STATUS_IN_PROGRESS') return 'in_progress'
  if (value === 'completed' || value === 'complete' || value === 'done' || value === 'TODO_STATUS_COMPLETED') return 'completed'
  return 'pending'
}

function normalize(raw: unknown, textKeys: readonly string[]): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const todos = raw.flatMap((value): TodoItem[] => {
    // A task the agent dropped is no longer part of its plan: Cursor and Grok cancel one
    // when a revised plan leaves it out.
    if (!isRecord(value) || value.status === 'TODO_STATUS_CANCELLED' || value.status === 'cancelled') return []
    const text = textKeys
      .map((key) => value[key])
      .find((candidate): candidate is string => typeof candidate === 'string')
      ?.trim()
    if (text === undefined || text.length === 0) return []
    return [{
      text: text.slice(0, 500),
      status: statusOf(value.status, value.completed),
    }]
  })
  return todos.slice(0, 50)
}

/** Claude and Grok put their full replacement list under tool input `todos`. */
export function todosFromToolInput(input: unknown): TodoItem[] | undefined {
  if (!isRecord(input)) return undefined
  return normalize(input.todos, ['content', 'text', 'subject'])
}

/**
 * Cursor's `updateTodosToolCall` may merge into the list it holds, so the completed
 * call's `result.success.todos` is the snapshot; a replacing call's own args are too.
 * Probed on cursor-agent 2026.10.16-e3cb207.
 */
export function todosFromCursorCall(call: unknown): TodoItem[] | undefined {
  if (!isRecord(call)) return undefined
  const result = isRecord(call.result) && isRecord(call.result.success) ? call.result.success.todos : undefined
  if (result !== undefined) return normalize(result, ['content'])
  const args = isRecord(call.args) ? call.args : undefined
  return args?.merge === true ? undefined : normalize(args?.todos, ['content'])
}
