/**
 * TypeBox schemas for `crypto.*` api-call arguments.
 *
 * Inputs are base64-encoded over the wire. We cap them at 8 MB so a runaway
 * plugin can't OOM the host process by sending arbitrarily large hash
 * requests. Real AWS Sigv4 / OAuth signing inputs are < 4 KB; this ceiling
 * is generous defense-in-depth.
 *
 * The RSA schemas cover the asymmetric operations OIDC / social-login plugins
 * need: key-pair generation, RSA signing (JWT / Apple client secret), and
 * public-key → JWK conversion for JWKS endpoints. These are bridged
 * synchronously via `__hostCallSync` so plugin code's synchronous call shape
 * (`generateKeyPairSync(...)`, `createSign(...).sign(...)`) works unchanged.
 */

import { Type } from '@sinclair/typebox'

const HashAlgorithmSchema = Type.Union([
  Type.Literal('SHA-256'),
  Type.Literal('SHA-1'),
  Type.Literal('SHA-512'),
])

/** Max base64 payload — 8 MB after decode. (base64 inflates by 4/3 → ~10.7 MB encoded.) */
const MAX_CRYPTO_PAYLOAD_BASE64 = 12 * 1024 * 1024

export const CryptoDigestArgSchema = Type.Object(
  {
    algorithm: HashAlgorithmSchema,
    data: Type.String({ minLength: 0, maxLength: MAX_CRYPTO_PAYLOAD_BASE64 }),
  },
  { additionalProperties: false },
)

export const CryptoSignHmacArgSchema = Type.Object(
  {
    hash: HashAlgorithmSchema,
    key: Type.String({ minLength: 0, maxLength: MAX_CRYPTO_PAYLOAD_BASE64 }),
    data: Type.String({ minLength: 0, maxLength: MAX_CRYPTO_PAYLOAD_BASE64 }),
  },
  { additionalProperties: false },
)

/** Arguments for `crypto.generateKeyPair` — mirrors Node's generateKeyPairSync('rsa', ...). */
export const CryptoGenerateKeyPairArgSchema = Type.Object(
  {
    /** Key type — currently only 'rsa' is supported. */
    type: Type.Literal('rsa'),
    /** RSA modulus length in bits. 2048 is the modern minimum. */
    modulusLength: Type.Integer({ minimum: 2048, maximum: 4096 }),
    /** Public key encoding. */
    publicKeyEncoding: Type.Object({
      type: Type.Literal('spki'),
      format: Type.Literal('pem'),
    }, { additionalProperties: false }),
    /** Private key encoding. */
    privateKeyEncoding: Type.Object({
      type: Type.Literal('pkcs8'),
      format: Type.Literal('pem'),
    }, { additionalProperties: false }),
  },
  { additionalProperties: false },
)

/** Arguments for `crypto.signRsa` — RSA signing with a PEM private key. */
export const CryptoSignRsaArgSchema = Type.Object(
  {
    /** Signature algorithm, e.g. 'RSA-SHA256', 'sha256'. */
    algorithm: Type.String({ minLength: 1, maxLength: 64 }),
    /** PEM-encoded private key. */
    privateKeyPem: Type.String({ minLength: 1, maxLength: MAX_CRYPTO_PAYLOAD_BASE64 }),
    /** Data to sign, base64-encoded. */
    data: Type.String({ minLength: 0, maxLength: MAX_CRYPTO_PAYLOAD_BASE64 }),
  },
  { additionalProperties: false },
)

/** Arguments for `crypto.publicKeyToJwk` — convert a PEM public key to JWK. */
export const CryptoPublicKeyToJwkArgSchema = Type.Object(
  {
    /** PEM-encoded public key. */
    publicKeyPem: Type.String({ minLength: 1, maxLength: MAX_CRYPTO_PAYLOAD_BASE64 }),
  },
  { additionalProperties: false },
)
