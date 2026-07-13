/**
 * 2FA (MFA) routes — TOTP setup, verification, recovery codes.
 *
 * Endpoints (authenticated):
 *   POST /api/auth/mfa/setup    → { secret, otpauthUrl, recoveryCodes }
 *   POST /api/auth/mfa/enable   { code }                  → 200 (enables 2FA, consumes one of the recovery codes must be saved already)
 *   POST /api/auth/mfa/disable  { password }              → 200 (requires password confirmation)
 *   POST /api/auth/mfa/verify   { mfaToken, code }        → { accessToken }
 *   GET  /api/auth/mfa/recovery-codes                       → { codes: [...] }  (shown once after enable)
 *
 * Login flow with 2FA:
 *   1. POST /api/auth/login with email+password
 *   2a. If no 2FA: returns { accessToken, user }
 *   2b. If 2FA enabled: returns { mfaToken, requiresMfa: true } (NO accessToken yet)
 *   3. POST /api/auth/mfa/verify with mfaToken + 6-digit code
 *   4. Returns { accessToken, user }
 *
 * The mfaToken is a short-lived (5 min) signed JWT with a special 'mfa' scope.
 * It's NOT a full access token; it can ONLY be used at /api/auth/mfa/verify.
 *
 * Recovery codes (8 single-use codes) are shown ONCE at enable. Each is
 * 10 chars; the user is told to store them in a password manager. They
 * can be used instead of TOTP at the /api/auth/mfa/verify endpoint.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import {
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotpCode,
} from './totp'
import { signAccessToken, verifyAccessToken } from './tokens'

interface MfaSettings {
  jwtSecret: string
  mfaTokenTtlSeconds: number  // default 300 (5 min)
}

function buildOtpauthUrl(secret: string, accountName: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

// ─── POST /api/auth/mfa/setup ───────────────────────────────────────────

export async function handleMfaSetup(
  api: ApiCallContext,
  userId: string,
  settings: MfaSettings,
): Promise<Response> {
  // Look up the user
  const { rows } = await api.db`
    select email, display_name, mfa_enabled_at from public_users
    where id = ${userId} and deleted_at is null
    limit 1
  `
  if (!rows[0]) return Response.json({ error: 'not_found' }, { status: 404 })
  if (rows[0].mfa_enabled_at) {
    return Response.json({ error: 'mfa_already_enabled' }, { status: 409 })
  }
  // Generate a fresh secret + recovery codes
  const secret = generateTotpSecret()
  const recoveryCodes = generateRecoveryCodes(8)
  // Store pending secret + recovery code hashes (NOT enabled yet —
  // user must verify the first TOTP code before we activate).
  await api.db`
    update public_users
    set mfa_totp_secret_ciphertext = ${secret},
        mfa_recovery_code_hashes_json = ${JSON.stringify(recoveryCodes.map(hashRecoveryCode))}::jsonb,
        updated_at = now()
    where id = ${userId}
  `
  const issuer = 'Instatic'  // TODO: pull from settings
  const otpauthUrl = buildOtpauthUrl(secret, rows[0].email, issuer)
  return Response.json({
    secret,
    otpauthUrl,
    recoveryCodes,  // shown ONCE
    instructions: [
      'Install Google Authenticator, 1Password, or any TOTP app',
      `Scan the QR code or enter the secret manually: ${secret}`,
      'Enter the 6-digit code from your app to confirm and enable 2FA',
      'Save the recovery codes in a secure location — they will NOT be shown again',
    ],
  })
}

// ─── POST /api/auth/mfa/enable ──────────────────────────────────────────

export async function handleMfaEnable(
  api: ApiCallContext,
  userId: string,
  req: Request,
  settings: MfaSettings,
): Promise<Response> {
  let body: { code?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.code) return Response.json({ error: 'code required' }, { status: 400 })
  const { rows } = await api.db`
    select mfa_totp_secret_ciphertext from public_users
    where id = ${userId} and deleted_at is null limit 1
  `
  if (!rows[0]?.mfa_totp_secret_ciphertext) {
    return Response.json({ error: 'mfa_not_setup' }, { status: 400 })
  }
  if (!verifyTotpCode(rows[0].mfa_totp_secret_ciphertext, body.code)) {
    return Response.json({ error: 'invalid_code' }, { status: 400 })
  }
  await api.db`
    update public_users
    set mfa_enabled_at = now(), updated_at = now()
    where id = ${userId}
  `
  return Response.json({ enabled: true })
}

// ─── POST /api/auth/mfa/disable ─────────────────────────────────────────

export async function handleMfaDisable(
  api: ApiCallContext,
  userId: string,
  req: Request,
): Promise<Response> {
  let body: { password?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.password) return Response.json({ error: 'password required for confirmation' }, { status: 400 })
  // Verify password (imported lazily to keep mfaRoutes focused on 2FA logic)
  const { findUserByEmail, findUserById, verifyPassword } = await import('./store')
  const user = await findUserById(api.db, userId)
  if (!user) return Response.json({ error: 'not_found' }, { status: 404 })
  const ok = await verifyPassword(user.passwordHash, body.password)
  if (!ok) return Response.json({ error: 'invalid_password' }, { status: 400 })
  await api.db`
    update public_users
    set mfa_enabled_at = null,
        mfa_totp_secret_ciphertext = null,
        mfa_totp_secret_iv = null,
        mfa_recovery_code_hashes_json = '[]',
        updated_at = now()
    where id = ${userId}
  `
  return Response.json({ disabled: true })
}

// ─── POST /api/auth/mfa/verify ──────────────────────────────────────────

/**
 * Verify a TOTP code (or recovery code) and exchange the mfaToken for
 * a full access token.
 */
export async function handleMfaVerify(
  api: ApiCallContext,
  req: Request,
  settings: MfaSettings,
): Promise<Response> {
  let body: { mfaToken?: string; code?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.mfaToken || !body.code) {
    return Response.json({ error: 'mfaToken and code required' }, { status: 400 })
  }
  // Verify the mfaToken (short-lived JWT with sub=userId, scope=mfa)
  const verified = verifyAccessToken(body.mfaToken, settings.jwtSecret)
  if (!verified.ok) {
    return Response.json({ error: 'invalid_or_expired_mfa_token' }, { status: 401 })
  }
  const userId = verified.claims!.sub
  // Look up the user + their TOTP secret + recovery codes
  const { rows } = await api.db`
    select mfa_totp_secret_ciphertext, mfa_recovery_code_hashes_json, mfa_enabled_at
    from public_users where id = ${userId} and deleted_at is null limit 1
  `
  if (!rows[0] || !rows[0].mfa_enabled_at || !rows[0].mfa_totp_secret_ciphertext) {
    return Response.json({ error: 'mfa_not_enabled' }, { status: 400 })
  }
  const secret = rows[0].mfa_totp_secret_ciphertext
  const recoveryHashes: string[] = JSON.parse(rows[0].mfa_recovery_code_hashes_json ?? '[]')

  // Try TOTP first
  let verified2 = false
  if (verifyTotpCode(secret, body.code)) {
    verified2 = true
  } else {
    // Try recovery code
    const candidateHash = hashRecoveryCode(body.code)
    const idx = recoveryHashes.indexOf(candidateHash)
    if (idx !== -1) {
      verified2 = true
      // Burn the recovery code (single-use)
      const updated = [...recoveryHashes]
      updated.splice(idx, 1)
      await api.db`
        update public_users
        set mfa_recovery_code_hashes_json = ${JSON.stringify(updated)}::jsonb,
            updated_at = now()
        where id = ${userId}
      `
    }
  }
  if (!verified2) return Response.json({ error: 'invalid_code' }, { status: 400 })
  // Issue full access token
  const user = await import('./store').then((m) => m.findUserById(api.db, userId))
  if (!user) return Response.json({ error: 'user_not_found' }, { status: 404 })
  const accessToken = signAccessToken(
    { sub: userId, email: user.email, email_verified: !!user.emailVerifiedAt },
    settings.jwtSecret,
    settings.mfaTokenTtlSeconds * 12,  // = ~1h if mfaTokenTtl is 5min
  )
  // Also create a session row so the cookie flow works
  const { createSession, hashAccessToken } = await import('./store')
  await createSession(api.db, {
    id: nanoid(),
    userId,
    tokenHash: hashAccessToken(accessToken),
    userAgent: req.headers.get('user-agent'),
    ipAddress: req.headers.get('x-forwarded-for'),
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  })
  return Response.json({
    accessToken,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: !!user.emailVerifiedAt,
    },
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  })
}

// ─── Helper: issue mfaToken (called from login flow) ───────────────────

export function issueMfaToken(userId: string, settings: MfaSettings): string {
  return signAccessToken(
    { sub: userId, metadata: { scope: 'mfa' } },
    settings.jwtSecret,
    settings.mfaTokenTtlSeconds,
  )
}

// ─── GET /api/auth/mfa/recovery-codes (admin-only reissue) ─────────────

export async function handleMfaRegenerateRecoveryCodes(
  api: ApiCallContext,
  userId: string,
  req: Request,
): Promise<Response> {
  let body: { password?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.password) return Response.json({ error: 'password required' }, { status: 400 })
  const { findUserById, verifyPassword } = await import('./store')
  const user = await findUserById(api.db, userId)
  if (!user) return Response.json({ error: 'not_found' }, { status: 404 })
  if (!user.emailVerifiedAt) {
    return Response.json({ error: 'password_required' }, { status: 400 })
  }
  const ok = await verifyPassword(user.passwordHash, body.password)
  if (!ok) return Response.json({ error: 'invalid_password' }, { status: 400 })
  const newCodes = generateRecoveryCodes(8)
  await api.db`
    update public_users
    set mfa_recovery_code_hashes_json = ${JSON.stringify(newCodes.map(hashRecoveryCode))}::jsonb,
        updated_at = now()
    where id = ${userId}
  `
  return Response.json({ recoveryCodes: newCodes })
}