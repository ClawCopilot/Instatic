/**
 * Public-facing auth route handlers.
 *
 * Endpoints (mounted under /api/auth/):
 *   POST /api/auth/register    { email, password, displayName } → 201 { userId }
 *   POST /api/auth/login       { email, password }              → 200 { accessToken, user }
 *   POST /api/auth/logout      (auth)                           → 204
 *   POST /api/auth/refresh     (auth)                           → 200 { accessToken }
 *   GET  /api/auth/me          (auth)                           → 200 { user }
 *   POST /api/auth/verify-email { token }                       → 200
 *   POST /api/auth/password-reset/request  { email }           → 200 (always, no enumeration)
 *   POST /api/auth/password-reset/confirm { token, newPassword } → 200
 *
 * Password rules:
 *   - Minimum 10 characters
 *   - At least one letter and one digit
 *   - Maximum 128 characters
 *
 * Lockout policy:
 *   - 5 consecutive failures within lockout window (default 15 minutes)
 *   - Lockout releases automatically after the window
 *   - Admin can unlock via public_users.locked_until = NULL
 *
 * Rate limiting is delegated to a separate plugin (e.g. rate-limit).
 */

import { createHash, randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import {
  signAccessToken,
  verifyAccessToken,
  extractBearerToken,
  extractCookieToken,
  generateOpaqueToken,
} from './tokens'
import {
  consumeVerificationToken,
  createSession,
  createUser,
  createVerificationToken,
  findActiveSession,
  findUserByEmail,
  findUserById,
  hashPassword,
  recordFailedLogin,
  recordSuccessfulLogin,
  revokeAllSessionsForUser,
  revokeSession,
  touchSession,
  updateUserPassword,
  verifyPassword,
} from './store'

interface PublicAuthSettings {
  jwtSecret: string
  accessTokenTtlSeconds: number
  requireEmailVerification: boolean
}

const PASSWORD_MIN_LENGTH = 10
const PASSWORD_MAX_LENGTH = 128

export function validatePassword(pw: string): string | null {
  if (pw.length < PASSWORD_MIN_LENGTH) return 'Password too short (min 10 characters)'
  if (pw.length > PASSWORD_MAX_LENGTH) return 'Password too long (max 128 characters)'
  if (!/[a-zA-Z]/.test(pw)) return 'Password must contain a letter'
  if (!/[0-9]/.test(pw)) return 'Password must contain a digit'
  return null
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function jsonError(message: string, status: number, code?: string): Response {
  return Response.json({ error: code ?? message, message }, { status })
}

function hashForStorage(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ─── POST /api/auth/register ──────────────────────────────────────────────

export async function handleRegister(
  api: ApiCallContext,
  req: Request,
  settings: PublicAuthSettings,
): Promise<Response> {
  let body: { email?: string; password?: string; displayName?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return jsonError('invalid_json', 400)
  }
  if (!body.email || !body.password || !body.displayName) {
    return jsonError('email, password, displayName required', 400)
  }
  const passwordError = validatePassword(body.password)
  if (passwordError) return jsonError(passwordError, 400)
  const normalized = normalizeEmail(body.email)
  const existing = await findUserByEmail(api.db, normalized)
  if (existing) return jsonError('email_in_use', 409)
  const passwordHash = await hashPassword(body.password)
  const status = settings.requireEmailVerification ? 'pending_verification' : 'active'
  const user = await createUser(api.db, {
    id: nanoid(),
    email: body.email,
    displayName: body.displayName,
    passwordHash,
    status,
  })
  if (settings.requireEmailVerification) {
    const verificationToken = randomBytes(32).toString('base64url')
    await createVerificationToken(api.db, {
      id: nanoid(),
      userId: user.id,
      purpose: 'email_verification',
      tokenHash: hashForStorage(verificationToken),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
    // Email sending is delegated to a notifications plugin; the consumer
    // subscribes to the `public-auth.userRegistered` hook event.
    await api.hooks.emit('public-auth.userRegistered', {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      verificationToken,
    })
    return Response.json({
      userId: user.id,
      status: 'pending_verification',
      message: 'Check your email to verify your account.',
    }, { status: 201 })
  }
  await api.hooks.emit('public-auth.userRegistered', {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
  })
  return Response.json({ userId: user.id, status: 'active' }, { status: 201 })
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────

export async function handleLogin(
  api: ApiCallContext,
  req: Request,
  settings: PublicAuthSettings,
): Promise<Response> {
  let body: { email?: string; password?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return jsonError('invalid_json', 400)
  }
  if (!body.email || !body.password) return jsonError('email and password required', 400)
  const user = await findUserByEmail(api.db, normalizeEmail(body.email))
  // Constant-time-ish: always run hash verification even on missing user
  // to prevent user-enumeration timing oracle.
  const dummyHash = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const ok = await verifyPassword(user?.passwordHash ?? dummyHash, body.password)
  if (!user) return jsonError('invalid_credentials', 401)
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    return jsonError('account_locked', 423)
  }
  if (user.status === 'suspended') return jsonError('account_suspended', 403)
  if (settings.requireEmailVerification && !user.emailVerifiedAt) {
    return jsonError('email_not_verified', 403)
  }
  if (!ok) {
    await recordFailedLogin(api.db, user.id)
    return jsonError('invalid_credentials', 401)
  }
  await recordSuccessfulLogin(api.db, user.id)
  const token = await issueSession(api, user.id, req, settings)
  await api.hooks.emit('public-auth.userLoggedIn', {
    userId: user.id,
    sessionId: token.sessionId,
  })
  return Response.json({
    accessToken: token.value,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: !!user.emailVerifiedAt,
    },
    expiresAt: token.expiresAt,
  })
}

interface IssuedToken {
  value: string
  sessionId: string
  expiresAt: string
}

async function issueSession(
  api: ApiCallContext,
  userId: string,
  req: Request,
  settings: PublicAuthSettings,
): Promise<IssuedToken> {
  const user = await findUserById(api.db, userId)
  if (!user) throw new Error('User not found')
  const expiresAt = new Date(Date.now() + settings.accessTokenTtlSeconds * 1000).toISOString()
  const token = signAccessToken(
    { sub: user.id, email: user.email, email_verified: !!user.emailVerifiedAt },
    settings.jwtSecret,
    settings.accessTokenTtlSeconds,
  )
  await createSession(api.db, {
    id: nanoid(),
    userId: user.id,
    tokenHash: hashForStorage(token),
    userAgent: req.headers.get('user-agent'),
    ipAddress: req.headers.get('x-forwarded-for'),
    expiresAt,
  })
  return { value: token, sessionId: token.slice(0, 16), expiresAt }
}

// ─── POST /api/auth/logout ────────────────────────────────────────────────

export async function handleLogout(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  const token = extractBearerToken(req) ?? extractCookieToken(req, 'public_auth_token')
  if (token) await revokeSession(api.db, hashForStorage(token))
  const response = new Response(null, { status: 204 })
  response.headers.append('set-cookie', 'public_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  return response
}

// ─── POST /api/auth/refresh ────────────────────────────────────────────────

export async function handleRefresh(
  api: ApiCallContext,
  req: Request,
  settings: PublicAuthSettings,
): Promise<Response> {
  const token = extractBearerToken(req) ?? extractCookieToken(req, 'public_auth_token')
  if (!token) return jsonError('unauthorized', 401)
  const session = await findActiveSession(api.db, hashForStorage(token))
  if (!session) return jsonError('unauthorized', 401)
  const verified = verifyAccessToken(token, settings.jwtSecret)
  if (!verified.ok) return jsonError('unauthorized', 401)
  // Rotate: revoke the old session, issue a new one.
  await revokeSession(api.db, hashForStorage(token))
  const issued = await issueSession(api, session.userId, req, settings)
  return Response.json({ accessToken: issued.value, expiresAt: issued.expiresAt })
}

// ─── GET /api/auth/me ─────────────────────────────────────────────────────

export async function handleMe(
  api: ApiCallContext,
  req: Request,
  settings: PublicAuthSettings,
): Promise<Response> {
  const user = await resolveUserFromRequest(api, req, settings)
  if (!user) return jsonError('unauthorized', 401)
  return Response.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: !!user.emailVerifiedAt,
      status: user.status,
    },
  })
}

// ─── POST /api/auth/verify-email ──────────────────────────────────────────

export async function handleVerifyEmail(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: { token?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return jsonError('invalid_json', 400)
  }
  if (!body.token) return jsonError('token required', 400)
  const consumed = await consumeVerificationToken(api.db, hashForStorage(body.token))
  if (!consumed || consumed.purpose !== 'email_verification') {
    return jsonError('invalid_token', 400)
  }
  await api.db`
    update public_users
    set email_verified_at = now(),
        status = case when status = 'pending_verification' then 'active' else status end,
        updated_at = now()
    where id = ${consumed.userId}
  `
  return Response.json({ verified: true })
}

// ─── POST /api/auth/password-reset/request ────────────────────────────────

export async function handlePasswordResetRequest(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: { email?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return jsonError('invalid_json', 400)
  }
  // Always return 200 even if the email doesn't exist — prevents enumeration.
  if (!body.email) return Response.json({ ok: true })
  const user = await findUserByEmail(api.db, normalizeEmail(body.email))
  if (user) {
    const resetToken = randomBytes(32).toString('base64url')
    await createVerificationToken(api.db, {
      id: nanoid(),
      userId: user.id,
      purpose: 'password_reset',
      tokenHash: hashForStorage(resetToken),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),  // 30 min
    })
    await api.hooks.emit('public-auth.passwordResetRequested', {
      userId: user.id,
      email: user.email,
      resetToken,
    })
  }
  return Response.json({ ok: true })
}

// ─── POST /api/auth/password-reset/confirm ────────────────────────────────

export async function handlePasswordResetConfirm(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: { token?: string; newPassword?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return jsonError('invalid_json', 400)
  }
  if (!body.token || !body.newPassword) return jsonError('token and newPassword required', 400)
  const passwordError = validatePassword(body.newPassword)
  if (passwordError) return jsonError(passwordError, 400)
  const consumed = await consumeVerificationToken(api.db, hashForStorage(body.token))
  if (!consumed || consumed.purpose !== 'password_reset') {
    return jsonError('invalid_token', 400)
  }
  const newHash = await hashPassword(body.newPassword)
  await updateUserPassword(api.db, consumed.userId, newHash)
  // Force logout everywhere for security.
  await revokeAllSessionsForUser(api.db, consumed.userId)
  return Response.json({ reset: true })
}

// ─── Shared resolver used by routes AND the viewerContext provider ────────

export async function resolveUserFromRequest(
  api: ApiCallContext,
  req: Request,
  settings: PublicAuthSettings,
) {
  const token = extractBearerToken(req) ?? extractCookieToken(req, 'public_auth_token')
  if (!token) return null
  const session = await findActiveSession(api.db, hashForStorage(token))
  if (!session) return null
  const verified = verifyAccessToken(token, settings.jwtSecret)
  if (!verified.ok) return null
  await touchSession(api.db, session.id)
  return await findUserById(api.db, session.userId)
}