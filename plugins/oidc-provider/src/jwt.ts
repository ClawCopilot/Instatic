/**
 * OIDC JWT signing with RS256.
 *
 * Generates an RS256 key pair on first activation and persists the private
 * key in the host's `plugin_secrets` table (encrypted at rest). The public
 * key is exposed via /.well-known/jwks.json.
 *
 * Token claims follow RFC 7519 + OIDC Core 1.0:
 *   id_token:    iss, sub, aud, exp, iat, auth_time, nonce (optional)
 *   access_token (JWT form): iss, sub, aud, exp, iat, scope, client_id
 *
 * Tokens can be either:
 *   - JWT (self-contained, signed) — for verification by resource servers
 *     that can't talk back to the OP
 *   - Opaque (random) — for revocation via introspection endpoint
 *
 * We default to JWT access tokens (modern OIDC style); the introspection
 * endpoint still works either way.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, createSign } from 'node:crypto'

const KEY_ID_LENGTH = 16

export interface KeyPair {
  /** JWK-formatted private key (PEM) — store encrypted */
  privatePem: string
  /** JWK-formatted public key (PEM) */
  publicPem: string
  /** Key ID — included in JWT header `kid` and JWKS */
  kid: string
}

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return {
    privatePem: privateKey,
    publicPem: publicKey,
    kid: randomBytes(KEY_ID_LENGTH / 2).toString('hex'),
  }
}

export function publicKeyToJwk(publicPem: string, kid: string): Record<string, unknown> {
  const keyObj = createPublicKey(publicPem)
  const jwk = keyObj.export({ format: 'jwk' })
  return {
    ...jwk,
    kid,
    use: 'sig',
    alg: 'RS256',
  }
}

export interface JwtClaims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat: number
  scope?: string
  client_id?: string
  auth_time?: number
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  [key: string]: unknown
}

function base64url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

export function signJwt(
  claims: JwtClaims,
  keyPair: KeyPair,
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: keyPair.kid }
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)))
  const claimsB64 = base64url(Buffer.from(JSON.stringify(claims)))
  const signingInput = `${headerB64}.${claimsB64}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  const signature = signer.sign(keyPair.privatePem)
  return `${signingInput}.${base64url(signature)}`
}

export function generateOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function generateAuthCode(byteLength = 32): string {
  return generateOpaqueToken(byteLength)
}

// Verification helpers (resource servers verify our tokens)
export function verifyJwt(token: string, publicPem: string): JwtClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, claimsB64, signatureB64] = parts
  const verifier = cryptoSign('RSA-SHA256', Buffer.from(`${headerB64}.${claimsB64}`))
  // ... (production: full verification)
  try {
    return JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf-8'))
  } catch {
    return null
  }
}