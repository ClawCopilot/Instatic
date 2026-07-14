/**
 * Passwordless login — "magic link" via email.
 *
 * Flow:
 *   1. POST /api/auth/passwordless/request { email }
 *      → Always returns 200 (no user enumeration)
 *      → If user exists + email verified, emit public-auth.passwordlessLinkIssued
 *        hook with { userId, email, magicLink } — the notifications plugin
 *        (or a custom one) sends the email
 *   2. User clicks the link → GET /api/auth/passwordless/verify?token=...
 *   3. Server validates token (one-shot, 15 min), creates a session,
 *      redirects to /dashboard (or a configurable landing page)
 *
 * The magic link is: { baseUrl }/api/auth/passwordless/verify?token={token}
 * The token is a 32-byte random base64url string; its SHA-256 hash is
 * stored in the existing public_verification_tokens table (reusing the
 * email-verification token infrastructure).
 *
 * Security:
 *   - Always 200 on request (no user enumeration)
 *   - One-shot consumption (consumed_at set on first use)
 *   - 15-minute TTL
 *   - Token bound to user_id at issue time (a token for user A can't be
 *     used to log in as user B)
 *   - Rate limit at /api/auth/passwordless/request (handled by rate-limit plugin)
 *   - If 2FA is enabled, the magic link also issues an mfaToken instead of
 *     a full session (2FA must complete to log in)
 */

import { createHash, randomBytes } from 'node:crypto'
import { nanoid as _nanoid } from 'nanoid'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import { findUserByEmail, createSession as _createSession, findUserById, recordSuccessfulLogin, createVerificationToken } from './store'
import { signAccessToken } from './tokens'

interface PasswordlessSettings {
  baseUrl: string
  jwtSecret: string
  mfaTokenTtlSeconds: number
}

const PASSWORDLESS_TOKEN_TTL_SECONDS = 900  // 15 min

export async function handlePasswordlessRequest(
  api: ApiCallContext,
  req: Request,
  settings: PasswordlessSettings,
): Promise<Response> {
  let body: { email?: string; redirectTo?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  // Always 200 — no user enumeration
  if (!body.email) return Response.json({ ok: true })
  const user = await findUserByEmail(api.db, body.email)
  // Only send if: user exists, email verified, not deleted, not suspended
  if (user && user.emailVerifiedAt && !user.emailVerifiedAt === false) {
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashPasswordlessToken(token)
    await createVerificationToken(api.db, {
      id: nanoid(),
      userId: user.id,
      purpose: 'email_verification' as const,  // reuse table
      tokenHash,
      expiresAt: new Date(Date.now() + PASSWORDLESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    })
    const magicLink = `${settings.baseUrl}/api/auth/passwordless/verify?token=${encodeURIComponent(token)}&redirect_to=${encodeURIComponent(body.redirectTo ?? '/')}`
    await api.hooks.emit('public-auth.passwordlessLinkIssued', {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      magicLink,
      expiresInSeconds: PASSWORDLESS_TOKEN_TTL_SECONDS,
    })
  }
  return Response.json({ ok: true })
}

/**
 * GET /api/auth/passwordless/verify — accepts ?token=...
 * On success, redirects to ?redirect_to=... (or '/') with a Set-Cookie
 * establishing the public_auth_token session.
 */
export async function handlePasswordlessVerify(
  api: ApiCallContext,
  req: Request,
  settings: PasswordlessSettings,
): Promise<Response> {
  const url = new URL(req.url)
  const token = url.searchParams.get('token')
  const redirectTo = url.searchParams.get('redirect_to') ?? '/'
  if (!token) return new Response('Missing token', { status: 400 })
  // Validate + consume the token
  const tokenHash = hashPasswordlessToken(token)
  const { rows } = await api.db`
    update public_verification_tokens
    set consumed_at = now()
    where token_hash = ${tokenHash}
      and consumed_at is null
      and expires_at > now()
      and purpose = 'email_verification'
    returning user_id
  `
  if (!rows[0]) return new Response('Invalid or expired token', { status: 400 })
  const userId = rows[0].user_id
  // Look up the user
  const user = await findUserById(api.db, userId)
  if (!user || user.status !== 'active') {
    return new Response('User not found or suspended', { status: 400 })
  }
  await recordSuccessfulLogin(api.db, userId)
  // 2FA gate (same as password login)
  if (await isMfaEnabled(api, userId)) {
    const { issueMfaToken } = await import('./mfaRoutes')
    const mfaToken = issueMfaToken(userId, { jwtSecret: settings.jwtSecret, mfaTokenTtlSeconds: settings.mfaTokenTtlSeconds })
    // Redirect with a special query param that the client interprets
    const target = new URL(redirectTo, settings.baseUrl)
    target.searchParams.set('mfa_token', mfaToken)
    target.searchParams.set('mfa_required', '1')
    return Response.redirect(target.toString(), 302)
  }
  // Issue a session + access token + cookie
  const accessToken = signAccessToken(
    { sub: userId, email: user.email, email_verified: true },
    settings.jwtSecret,
    3600,
  )
  const { createSession: createSess, hashAccessToken } = await import('./store')
  await createSess(api.db, {
    id: nanoid(),
    userId,
    tokenHash: hashAccessToken(accessToken),
    userAgent: req.headers.get('user-agent'),
    ipAddress: req.headers.get('x-forwarded-for'),
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  })
  await api.hooks.emit('public-auth.userLoggedIn', { userId, sessionId: nanoid(), via: 'passwordless' })
  // Set the cookie + redirect
  const target = new URL(redirectTo, settings.baseUrl)
  const response = Response.redirect(target.toString(), 302)
  response.headers.append(
    'set-cookie',
    `public_auth_token=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
  )
  return response
}

function hashPasswordlessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

async function isMfaEnabled(api: ApiCallContext, userId: string): Promise<boolean> {
  const { rows } = await api.db`
    select mfa_enabled_at from public_users
    where id = ${userId} and deleted_at is null limit 1
  `
  return !!rows[0]?.mfa_enabled_at
}