/**
 * Route handlers for the api-keys plugin.
 *
 * Admin endpoints (mounted under `/admin/api/cms/api-keys/`):
 *   GET    /                — list caller's active keys
 *   POST   /                — create a new key
 *   DELETE /:id             — revoke a key (soft delete)
 *
 * Public endpoints (mounted under `/api/keys/`):
 *   GET    /me              — resolve the caller's key identity from bearer token
 *
 * The create endpoint returns the plaintext token EXACTLY ONCE — the host
 * never has it again. The client is responsible for storing it securely.
 */

import { Type } from '@sinclair/typebox'
import { nanoid } from 'nanoid'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import { generateApiKey } from './tokens'
import {
  createApiKey,
  findApiKeyByHash,
  listApiKeys,
  recordApiKeyUsage,
  revokeApiKey,
} from './store'

const CreateKeyBody = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 200 }),
  scope: Type.Union([Type.Literal('admin'), Type.Literal('public')]),
  capabilities: Type.Optional(Type.Array(Type.String())),
  expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
})

export async function handleListKeys(api: ApiCallContext): Promise<Response> {
  const user = api.user
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const keys = await listApiKeys(api.db, user.id)
  // Strip the hash from the response — never leak it to the browser.
  return Response.json({
    keys: keys.map(({ tokenHash: _hash, ...rest }) => rest),
  })
}

export async function handleCreateKey(api: ApiCallContext, req: Request): Promise<Response> {
  const user = api.user
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = CreateKeyBody.safeParse?.(body) ?? { success: false }
  if (!('success' in parsed) || !parsed.success) {
    return Response.json({
      error: 'invalid_body',
      required: ['label', 'scope', 'capabilities?', 'expiresInDays?'],
    }, { status: 400 })
  }
  const data = (parsed as { success: true; data: typeof CreateKeyBody.static }).data
  const generated = generateApiKey()
  const expiresAt = data.expiresInDays
    ? new Date(Date.now() + data.expiresInDays * 86_400_000).toISOString()
    : null
  const capabilities = data.scope === 'public'
    ? (data.capabilities ?? [])
    : (data.capabilities ?? user.capabilities)
  const key = await createApiKey(api.db, {
    id: nanoid(),
    ownerUserId: user.id,
    label: data.label,
    scope: data.scope,
    tokenPrefix: generated.visiblePrefix,
    tokenHash: generated.hash,
    capabilities,
    expiresAt,
  })
  return Response.json({
    key: { ...key, tokenHash: undefined },
    token: generated.token,  // plaintext — only returned here
  }, { status: 201 })
}

export async function handleRevokeKey(api: ApiCallContext, keyId: string): Promise<Response> {
  const user = api.user
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const ok = await revokeApiKey(api.db, keyId, user.id)
  if (!ok) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json({ revoked: true })
}

/**
 * Public `/api/keys/me` endpoint — resolves the caller's identity from
 * the Bearer token. Useful for client-side code to verify an API key
 * is valid before storing it, or to introspect capabilities.
 */
export async function handleResolveMe(api: ApiCallContext, req: Request): Promise<Response> {
  const token = api.extractBearerToken(req)
  if (!token) return Response.json({ error: 'missing_token' }, { status: 401 })
  const key = await findApiKeyByHash(api.db, api.hashToken(token))
  if (!key) return Response.json({ error: 'invalid_token' }, { status: 401 })
  await recordApiKeyUsage(api.db, key.id, req.headers.get('x-forwarded-for'))
  return Response.json({
    id: key.id,
    label: key.label,
    scope: key.scope,
    capabilities: key.capabilities,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
  })
}