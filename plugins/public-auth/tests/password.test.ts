/**
 * public-auth unit tests — covers password validation, email normalization,
 * token signing/verification, and verification token consumption.
 */

import { describe, test, expect } from 'bun:test'
import { validatePassword, normalizeEmail } from '../src/validation'
import { signAccessToken, verifyAccessToken, extractBearerToken, extractCookieToken, hashAccessToken, generateOpaqueToken } from '../src/tokens'

describe('public-auth/password', () => {
  test('validatePassword accepts a strong password', () => {
    expect(validatePassword('SecurePass123')).toBeNull()
    expect(validatePassword('a'.repeat(10) + '1')).toBeNull()
  })

  test('validatePassword rejects too-short passwords', () => {
    expect(validatePassword('Short1')).toMatch(/too short/i)
    expect(validatePassword('')).toMatch(/too short/i)
  })

  test('validatePassword rejects too-long passwords', () => {
    expect(validatePassword('a'.repeat(129) + '1')).toMatch(/too long/i)
  })

  test('validatePassword requires both letter and digit', () => {
    expect(validatePassword('NoDigitsHere')).toMatch(/digit/i)
    expect(validatePassword('1234567890')).toMatch(/letter/i)
  })
})

describe('public-auth/email', () => {
  test('normalizeEmail lowercases and trims', () => {
    expect(normalizeEmail('  USER@Example.COM  ')).toBe('user@example.com')
  })
})

describe('public-auth/tokens', () => {
  const secret = 'test-secret-key-with-enough-entropy-for-hs256'

  test('signAccessToken produces a JWT with the right prefix', () => {
    const token = signAccessToken({ sub: 'user_1', email: 'a@b.com' }, secret, 3600)
    expect(token.startsWith('publ_')).toBe(true)
    const jwt = token.slice(5)
    expect(jwt.split('.').length).toBe(3)
  })

  test('verifyAccessToken accepts a fresh token', () => {
    const token = signAccessToken({ sub: 'user_1' }, secret, 3600)
    const result = verifyAccessToken(token, secret)
    expect(result.ok).toBe(true)
    expect(result.claims?.sub).toBe('user_1')
    expect(result.claims?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  test('verifyAccessToken rejects wrong secret', () => {
    const token = signAccessToken({ sub: 'user_1' }, secret, 3600)
    const result = verifyAccessToken(token, 'wrong-secret')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid_signature')
  })

  test('verifyAccessToken rejects expired token', () => {
    const token = signAccessToken({ sub: 'user_1' }, secret, -1)  // already expired
    const result = verifyAccessToken(token, secret)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('expired')
  })

  test('verifyAccessToken rejects malformed token', () => {
    expect(verifyAccessToken('not-a-jwt', secret).ok).toBe(false)
    expect(verifyAccessToken('publ_abc.def', secret).ok).toBe(false)
    expect(verifyAccessToken('wrong_prefix_abc.def.ghi', secret).ok).toBe(false)
  })

  test('extractBearerToken parses Authorization header', () => {
    const req = { headers: { get: (n: string) => n === 'authorization' ? 'Bearer publ_xyz' : null } }
    expect(extractBearerToken(req)).toBe('publ_xyz')
  })

  test('extractCookieToken parses from Cookie header', () => {
    const req = { headers: { get: (n: string) => n === 'cookie' ? 'public_auth_token=publ_abc; other=val' : null } }
    expect(extractCookieToken(req, 'public_auth_token')).toBe('publ_abc')
    expect(extractCookieToken(req, 'other')).toBe('val')
    expect(extractCookieToken(req, 'missing')).toBeNull()
  })

  test('generateOpaqueToken produces URL-safe random strings', () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 1000; i++) tokens.add(generateOpaqueToken())
    expect(tokens.size).toBe(1000)
    for (const t of tokens) {
      expect(t).toMatch(/^[a-zA-Z0-9_-]+$/)
      expect(t.length).toBeGreaterThanOrEqual(43)  // base64url(32 bytes)
    }
  })

  test('hashAccessToken is deterministic', () => {
    const t = 'publ_test_token_value'
    expect(hashAccessToken(t)).toBe(hashAccessToken(t))
  })
})