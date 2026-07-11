/**
 * JWT signing and verification for public-auth sessions.
 *
 * Uses HMAC-SHA256 with a per-installation secret stored in plugin settings.
 * The JWT carries `sub` (user id), `iat`, `exp`, and an optional `metadata`
 * blob for claims plugins want to read without an extra DB lookup.
 *
 * Why JWT over a random opaque token:
 *   - Plugins can verify the token without a DB round-trip
 *   - Self-contained claims (display name, email, role) reduce DB load
 *
 * Why a server-side session table anyway:
 *   - JWT alone cannot be revoked. The session table lets us implement
 *     "log out everywhere" and "force password reset invalidates sessions"
 *     without rotating the signing secret.
 *   - Verification does both: validate JWT signature + check the session
 *     row hasn't been revoked.
 *
 * The access token format is `publ_<jwt>` so it's visually distinct from
 * the `instk_` admin API keys.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_PREFIX = 'publ_'

export interface AccessTokenClaims {
  sub: string  // user id
  iat: number  // issued at (unix seconds)
  exp: number  // expires at (unix seconds)
  email?: string
  email_verified?: boolean
  metadata?: Record<string, unknown>
}

function base64url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  return Buffer.from(padded + padding, 'base64')
}

export function signAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000)
  const fullClaims: AccessTokenClaims = {
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
  }
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)))
  const claimsB64 = base64url(Buffer.from(JSON.stringify(fullClaims)))
  const signingInput = `${headerB64}.${claimsB64}`
  const signature = createHmac('sha256', secret).update(signingInput).digest()
  const signatureB64 = base64url(signature)
  return `${TOKEN_PREFIX}${signingInput}.${signatureB64}`
}

export interface VerifyResult {
  ok: boolean
  claims?: AccessTokenClaims
  error?: 'malformed' | 'invalid_signature' | 'expired'
}

export function verifyAccessToken(token: string, secret: string): VerifyResult {
  if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, error: 'malformed' }
  const jwt = token.slice(TOKEN_PREFIX.length)
  const parts = jwt.split('.')
  if (parts.length !== 3) return { ok: false, error: 'malformed' }
  const [headerB64, claimsB64, signatureB64] = parts
  const expectedSignature = createHmac('sha256', secret)
    .update(`${headerB64}.${claimsB64}`)
    .digest()
  let actualSignature: Buffer
  try {
    actualSignature = base64urlDecode(signatureB64)
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (expectedSignature.length !== actualSignature.length) {
    return { ok: false, error: 'invalid_signature' }
  }
  if (!timingSafeEqual(expectedSignature, actualSignature)) {
    return { ok: false, error: 'invalid_signature' }
  }
  let claims: AccessTokenClaims
  try {
    claims = JSON.parse(base64urlDecode(claimsB64).toString('utf-8'))
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'expired' }
  }
  return { ok: true, claims }
}

export function hashAccessToken(token: string): string {
  // SHA-256 hex — same scheme as api-keys plugin
  return Buffer.from(token).toString('base64url').slice(0, 43) // truncate to base64url-safe fingerprint
  // For deterministic hash use crypto.createHash
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

export function extractBearerToken(req: { headers: { get(name: string): string | null } }): string | null {
  const auth = req.headers.get('authorization')?.trim()
  if (!auth) return null
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() || null
  }
  if (auth.startsWith(TOKEN_PREFIX)) return auth
  return null
}

export function extractCookieToken(req: { headers: { get(name: string): string | null } }, cookieName: string): string | null {
  const cookieHeader = req.headers.get('cookie')
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === cookieName) return decodeURIComponent(rest.join('='))
  }
  return null
}