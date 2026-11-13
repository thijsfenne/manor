import type { BrowserToolName } from '@manor/contracts'
import { z } from 'zod'

const Page = z.object({
  url: z.string().url(),
  title: z.string(),
  visibleText: z.string(),
  focusedSelector: z.string().nullable().optional(),
  interactiveElements: z.array(z.object({
    selector: z.string(),
    tag: z.string(),
    role: z.string().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    type: z.string().optional(),
  })),
})

/** Stable page state for resuming a human-approved action; omit console noise and geometry. */
export function browserApprovalSnapshot(snapshot: unknown): unknown {
  return Page.parse(snapshot)
}

/** Keep the exact action and target, but omit console output, geometry and unrelated controls. */
export function browserReviewArguments(tool: BrowserToolName, action: Record<string, unknown>, snapshot: unknown): unknown {
  const parsed = Page.safeParse(snapshot)
  if (!parsed.success) return undefined
  const page = parsed.data
  const selector = tool === 'browser_press' ? page.focusedSelector : action.selector
  const targets = page.interactiveElements.filter((element) => element.selector === selector)
  if ((tool === 'browser_click' || tool === 'browser_type' || tool === 'browser_press') && targets.length !== 1) return undefined
  const target = targets.length === 1 ? targets[0] : undefined
  // Never send typed credentials to the independent review job.
  if (tool === 'browser_type' && target?.type?.toLowerCase() === 'password') return undefined
  return {
    action,
    page: {
      url: page.url,
      title: page.title,
      visibleText: page.visibleText.slice(0, 8_000),
      textTruncated: page.visibleText.length > 8_000,
      ...(tool === 'browser_press' ? { focusedSelector: page.focusedSelector ?? null } : {}),
      ...(target === undefined ? {} : { target }),
    },
  }
}
