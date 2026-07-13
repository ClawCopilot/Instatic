/**
 * oidc-provider JWT signing tests.
 */

import { describe, test, expect } from 'bun:test'
import { generateKeyPair, signJwt, publicKeyToJwk } from '../src/jwt'

describe('oidc-provider/jwt', () => {
  test('generateKeyPair produces a valid RSA-2048 key pair', () => {
    const kp = generateKeyPair()
    expect(kp.privatePem).toMatch(/-----BEGIN PRIVATE KEY-----/)
    expect(kp.publicPem).toMatch(/-----BEGIN PUBLIC KEY-----/)
    expect(kp.kid).toHaveLength(16)
  })

  test('generated key pairs are unique', () => {
    const kids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      kids.add(generateKeyPair().kid)
    }
    expect(kids.size).toBe(100)
  })

  test('signJwt produces a 3-part JWT with the right header', () => {
    const kp = generateKeyPair()
    const now = Math.floor(Date.now() / 1000)
    const token = signJwt(
      { iss: 'https://test.example.com', sub: 'user_1', aud: 'client_1', exp: now + 3600, iat: now },
      kp,
    )
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'))
    expect(header.alg).toBe('RS256')
    expect(header.typ).toBe('JWT')
    expect(header.kid).toBe(kp.kid)
  })

  test('signJwt embeds the right claims in the payload', () => {
    const kp = generateKeyPair()
    const now = Math.floor(Date.now() / 1000)
    const token = signJwt(
      {
        iss: 'https://test.example.com',
        sub: 'user_1',
        aud: 'client_1',
        exp: now + 3600,
        iat: now,
        scope: 'openid profile email',
        email: 'a@b.com',
        email_verified: true,
      },
      kp,
    )
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'))
    expect(payload.iss).toBe('https://test.example.com')
    expect(payload.sub).toBe('user_1')
    expect(payload.aud).toBe('client_1')
    expect(payload.scope).toBe('openid profile email')
    expect(payload.email).toBe('a@b.com')
    expect(payload.email_verified).toBe(true)
  })

  test('publicKeyToJwk produces a JWKS-compatible object', () => {
    const kp = generateKeyPair()
    const jwk = publicKeyToJwk(kp.publicPem, kp.kid)
    expect(jwk.kty).toBe('RSA')
    expect(jwk.use).toBe('sig')
    expect(jwk.alg).toBe('RS256')
    expect(jwk.kid).toBe(kp.kid)
    expect(jwk.n).toBeDefined()  // modulus
    expect(jwk.e).toBeDefined()  // exponent
  })
})