/**
 * api-keys plugin unit tests — covers token generation, hashing, verification,
 * and bearer extraction. These tests don't need a DB.
 */

import { describe, test, expect } from 'bun:test'
import { generateApiKey, hashToken, verifyToken, extractBearerToken } from '../src/tokens'

describe('api-keys/tokens', () => {
  test('generateApiKey produces a 42-character token (instk_XXXX_YYYY... format)', () => {
    const { token, visiblePrefix, hash } = generateApiKey()
    expect(token).toMatch(/^instk_[a-f0-9]{8}_[a-f0-9]{32}$/)
    expect(visiblePrefix).toMatch(/^instk_[a-f0-9]{8}$/)
    expect(visiblePrefix.length).toBe(14)  // "instk_" (6) + 8 hex
    expect(token.startsWith(visiblePrefix)).toBe(true)
    expect(hash).toHaveLength(64)  // SHA-256 hex
  })

  test('generated tokens are unique', () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      tokens.add(generateApiKey().token)
    }
    expect(tokens.size).toBe(1000)  // zero collisions
  })

  test('hashToken is deterministic', () => {
    const t = 'instk_a1b2c3d4_e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4'
    expect(hashToken(t)).toBe(hashToken(t))
    expect(hashToken(t)).toHaveLength(64)
  })

  test('verifyToken accepts correct token, rejects wrong token', () => {
    const { token, hash } = generateApiKey()
    expect(verifyToken(token, hash)).toBe(true)
    expect(verifyToken(token + 'x', hash)).toBe(false)
    expect(verifyToken('instk_00000000_0000000000000000000000000000000000', hash)).toBe(false)
  })

  test('verifyToken rejects malformed hash lengths without throwing', () => {
    const { token } = generateApiKey()
    expect(verifyToken(token, 'short')).toBe(false)
    expect(verifyToken(token, '')).toBe(false)
  })

  test('extractBearerToken parses Bearer scheme', () => {
    const req = { headers: { get: (n: string) => n.toLowerCase() === 'authorization' ? 'Bearer instk_abc_def123' : null } }
    expect(extractBearerToken(req)).toBe('instk_abc_def123')
  })

  test('extractBearerToken accepts raw token without Bearer prefix', () => {
    const req = { headers: { get: (n: string) => n.toLowerCase() === 'authorization' ? 'instk_abc_def' : null } }
    expect(extractBearerToken(req)).toBe('instk_abc_def')
  })

  test('extractBearerToken returns null when no token', () => {
    const req = { headers: { get: () => null } }
    expect(extractBearerToken(req)).toBeNull()
    const req2 = { headers: { get: (n: string) => n === 'authorization' ? '' : null } }
    expect(extractBearerToken(req2)).toBeNull()
  })

  test('extractBearerToken is case-insensitive on scheme', () => {
    const req = { headers: { get: (n: string) => n === 'authorization' ? 'bearer instk_lower' : null } }
    expect(extractBearerToken(req)).toBe('instk_lower')
  })
})