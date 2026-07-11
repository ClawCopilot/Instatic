/**
 * API key token generation and verification.
 *
 * Format: `instk_<prefix>_<secret>` where:
 *   - `instk_` — fixed prefix for visual identification in logs / docs
 *   - `<prefix>` — 8-character random hex, stored plaintext alongside the hash
 *                 so admins can identify a key without exposing its secret
 *   - `<secret>` — 32-character random hex, the only part that authenticates
 *
 * We store SHA-256(token) and never the token itself. On verification we
 * recompute the hash and look it up; the plaintext token is only ever
 * returned once, at creation time.
 *
 * Why SHA-256 (not bcrypt/argon2)? API keys are 256 bits of entropy from
 * a CSPRNG. The threat model is "attacker steals the DB" — SHA-256 of a
 * 256-bit random value cannot be brute-forced in any realistic time
 * frame. Slow KDFs are only needed when the input has low entropy
 * (human-chosen passwords).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_PREFIX = 'instk_'
const PREFIX_LENGTH = 8
const SECRET_LENGTH = 32

export interface GeneratedToken {
  /** The full plaintext token. Returned to the user ONCE. */
  token: string
  /** The short visible prefix (instk_a1b2c3d4). Stored plaintext for display. */
  visiblePrefix: string
  /** SHA-256 of the full token. Stored in the DB. */
  hash: string
}

export function generateApiKey(): GeneratedToken {
  const prefix = randomBytes(PREFIX_LENGTH / 2).toString('hex')
  const secret = randomBytes(SECRET_LENGTH / 2).toString('hex')
  const token = `${TOKEN_PREFIX}${prefix}_${secret}`
  const visiblePrefix = `${TOKEN_PREFIX}${prefix}`
  return { token, visiblePrefix, hash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Constant-time comparison — defends against timing-attack fingerprinting
 * even though SHA-256 hashing makes the input space astronomical.
 */
export function verifyToken(presented: string, storedHash: string): boolean {
  const presentedHash = hashToken(presented)
  if (presentedHash.length !== storedHash.length) return false
  return timingSafeEqual(Buffer.from(presentedHash, 'hex'), Buffer.from(storedHash, 'hex'))
}

/**
 * Extract an API key from a request's Authorization header.
 * Accepts "Bearer <token>" or the raw token.
 * Returns null if no token is present.
 */
export function extractBearerToken(req: { headers: { get(name: string): string | null } }): string | null {
  const auth = req.headers.get('authorization')?.trim()
  if (!auth) return null
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() || null
  }
  if (auth.startsWith(TOKEN_PREFIX)) return auth
  return null
}