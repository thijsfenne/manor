import { z } from 'zod'

export const AuthLoginRequestSchema = z.object({ email: z.string().max(320), password: z.string().max(1024) })
export const AuthRefreshRequestSchema = z.object({ refresh_token: z.string().min(20).max(256) })
/** Opaque credentials issued by the owner's Manor server, shared by desktop and phone. */
export const ManorSessionSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(20).max(256),
  expires_at: z.number().int().nonnegative(),
  user: z.object({ id: z.string().uuid(), email: z.string().email() }),
})
export type ManorSession = z.infer<typeof ManorSessionSchema>
export const AuthErrorSchema = z.object({ error: z.string() })
export const AuthLogoutResponseSchema = z.object({ ok: z.literal(true) })
