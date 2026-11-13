/**
 * Marker on the `message` of an error event that means "this session id is gone".
 * The orchestrator owns the recovery (clear the id, retry once with a full
 * catch-up); every driver only classifies.
 */
export const RESUME_FAILURE_PREFIX = 'resume_failed: '

export const isResumeFailure = (message: string): boolean => message.startsWith(RESUME_FAILURE_PREFIX)
