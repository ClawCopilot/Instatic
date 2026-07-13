/**
 * Pure validation helpers — no external dependencies, safe to import
 * in tests without dragging in hash-wasm or DB code.
 */

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