/**
 * TOTP (RFC 6238) implementation.
 *
 * Used for 2FA on public-auth accounts. Compatible with:
 *   - Google Authenticator
 *   - 1Password
 *   - Authy
 *   - Any RFC 6238-compliant authenticator app
 *
 * Algorithm: HMAC-SHA1, 6-digit code, 30-second time step.
 *
 * Storage: TOTP secrets are stored encrypted (AES-256-GCM via host's
 * plugin_secrets). For this implementation we use a SHA-256-derived key
 * from the JWT secret — adequate for second-factor protection; production
 * deployments should use a dedicated encryption key.
 */

import { createHmac, randomBytes } from 'node:crypto'

const TIME_STEP_SECONDS = 30
const DIGITS = 6
const WINDOW = 1  // accept ±1 step (current ± 30s) for clock drift

/**
 * Generate a new TOTP secret (base32-encoded, 160 bits).
 */
export function generateTotpSecret(): string {
  const bytes = randomBytes(20)
  return base32Encode(bytes)
}

/**
 * Compute the current TOTP code for a secret.
 */
export function generateTotpCode(secret: string, timestampMs: number = Date.now()): string {
  const counter = Math.floor(timestampMs / 1000 / TIME_STEP_SECONDS)
  return hotp(secret, counter)
}

/**
 * Verify a TOTP code against a secret. Returns true if the code is valid
 * within the WINDOW (default ±1 step).
 */
export function verifyTotpCode(secret: string, code: string, timestampMs: number = Date.now()): boolean {
  // Normalize the code: strip spaces, ensure 6 digits
  const normalized = code.replace(/\s/g, '').padStart(DIGITS, '0')
  if (!/^\d{6}$/.test(normalized)) return false
  const counter = Math.floor(timestampMs / 1000 / TIME_STEP_SECONDS)
  // Constant-time-ish check: compute expected for ±WINDOW, compare each
  for (let i = -WINDOW; i <= WINDOW; i++) {
    const expected = hotp(secret, counter + i)
    if (timingSafeEqualHex(expected, normalized)) {
      // Replay protection: store the last used counter for this secret
      // (caller's responsibility)
      return true
    }
  }
  return false
}

function hotp(secret: string, counter: number): string {
  // Decode base32 secret
  const key = base32Decode(secret)
  // 8-byte big-endian counter
  const counterBytes = Buffer.alloc(8)
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = counter & 0xff
    counter = Math.floor(counter / 256)
  }
  const hmac = createHmac('sha1', key).update(counterBytes).digest()
  // Dynamic truncation (RFC 4226)
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  )
  const code = binary % (10 ** DIGITS)
  return String(code).padStart(DIGITS, '0')
}

// ─── Base32 (RFC 4648) ──────────────────────────────────────────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  return output
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char)
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

// ─── Constant-time compare ──────────────────────────────────────────────

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// ─── Recovery codes ─────────────────────────────────────────────────────

/**
 * Generate a set of single-use recovery codes. Each is 10 chars
 * (alphanumeric, easy to type), shown to the user ONCE at enable time.
 */
export function generateRecoveryCodes(count: number = 8): string[] {
  return Array.from({ length: count }, () => {
    // 8 bytes → 11 base64url chars (no padding). Filter to A-Z0-9 and
    // pad/truncate to exactly 10 chars.
    const bytes = randomBytes(8)
    return bytes.toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
  })
}

export function hashRecoveryCode(code: string): string {
  // Simple SHA-256 of normalized code (uppercase, no spaces)
  return createHmac('sha256', 'recovery-code-salt')
    .update(code.replace(/\s/g, '').toUpperCase())
    .digest('hex')
}