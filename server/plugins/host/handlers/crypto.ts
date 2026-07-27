/**
 * Cryptographic operation handlers — implements crypto.digest,
 * crypto.signHmac, crypto.generateKeyPair, crypto.signRsa, and
 * crypto.publicKeyToJwk api-calls.
 *
 * No permission gate on any crypto target. Crypto is pure computation (no
 * I/O, no privilege escalation) — same model as Math/JSON exposure. Inputs
 * are size-bounded by the protocol schema.
 *
 * digest / signHmac use Bun's native `crypto.subtle` (the WHATWG Web Crypto
 * API). The three RSA operations (generateKeyPair, signRsa, publicKeyToJwk)
 * bridge to Node's `crypto` module because Web Crypto's async key-import
 * dance is incompatible with the synchronous call shape plugin code expects
 * (`generateKeyPairSync(...)`, `createSign(...).sign(...)`).
 *
 * NOTE: in normal operation these RSA targets are dispatched synchronously
 * inside the QuickJS worker via `__hostCallSync` (see `quickjs/vm.ts`). The
 * async handlers here exist so the host dispatch table has one entry per
 * schema target — the architecture gate in
 * `plugin-rpc-target-registry.test.ts` enforces that invariant.
 */

import {
  generateKeyPairSync as nodeGenerateKeyPairSync,
  createSign as nodeCreateSign,
  createPublicKey as nodeCreatePublicKey,
} from 'node:crypto'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../apiReplies'
import { bytesToBase64, base64ToBytes } from '../../protocol/bodyEncoding'
import type { HostPluginRecord } from '../types'

export async function handleCryptoDigest(
  msg: ApiCallFor<'crypto.digest'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ algorithm, data }] = msg.args
  const dataBytes = base64ToBytes(data)
  const digest = await crypto.subtle.digest(algorithm, dataBytes)
  replyApiOk(msg.pluginId, msg.correlationId, bytesToBase64(new Uint8Array(digest)))
}

export async function handleCryptoSignHmac(
  msg: ApiCallFor<'crypto.signHmac'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ hash, key, data }] = msg.args
  const keyBuffer = base64ToBytes(key)
  const dataBuffer = base64ToBytes(data)
  const importedKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign({ name: 'HMAC' }, importedKey, dataBuffer)
  replyApiOk(msg.pluginId, msg.correlationId, bytesToBase64(new Uint8Array(signature)))
}

/**
 * Generate an RSA key pair. Mirrors Node's `generateKeyPairSync('rsa', ...)`.
 * Used by OIDC / social-login plugins that need to mint JWTs or Apple
 * client secrets.
 */
export async function handleCryptoGenerateKeyPair(
  msg: ApiCallFor<'crypto.generateKeyPair'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ type: keyType, modulusLength, publicKeyEncoding, privateKeyEncoding }] = msg.args
  const { publicKey, privateKey } = nodeGenerateKeyPairSync(keyType, {
    modulusLength,
    publicKeyEncoding: publicKeyEncoding as { type: 'spki'; format: 'pem' },
    privateKeyEncoding: privateKeyEncoding as { type: 'pkcs8'; format: 'pem' },
  })
  replyApiOk(msg.pluginId, msg.correlationId, {
    publicKey: String(publicKey),
    privateKey: String(privateKey),
  })
}

/**
 * Sign data with an RSA private key. Mirrors Node's
 * `createSign(algorithm).update(data).sign(privateKeyPem)`.
 */
export async function handleCryptoSignRsa(
  msg: ApiCallFor<'crypto.signRsa'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ algorithm, privateKeyPem, data }] = msg.args
  const dataBuf = base64ToBytes(data)
  const signer = nodeCreateSign(algorithm)
  signer.update(dataBuf)
  const signature = signer.sign(privateKeyPem)
  replyApiOk(msg.pluginId, msg.correlationId, bytesToBase64(signature))
}

/**
 * Convert a PEM-encoded public key to a JWK (JSON Web Key). Used by
 * plugins that expose JWKS endpoints for OIDC / social login.
 */
export async function handleCryptoPublicKeyToJwk(
  msg: ApiCallFor<'crypto.publicKeyToJwk'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ publicKeyPem }] = msg.args
  const keyObj = nodeCreatePublicKey(publicKeyPem)
  const jwk = keyObj.export({ format: 'jwk' })
  replyApiOk(msg.pluginId, msg.correlationId, jwk)
}
