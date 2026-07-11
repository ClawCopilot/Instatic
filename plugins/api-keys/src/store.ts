/**
 * DB CRUD for api_keys plugin.
 *
 * All queries are parameterised; the plugin never builds SQL with string
 * concatenation. The store API returns plain objects — handler code is
 * responsible for serialising into Response bodies.
 */

import type { DbClient } from '@instatic/plugin-sdk/host'

export type ApiKeyScope = 'admin' | 'public'

export interface ApiKeyRecord {
  id: string
  ownerUserId: string
  label: string
  scope: ApiKeyScope
  tokenPrefix: string
  tokenHash: string
  capabilities: string[]
  expiresAt: string | null
  lastUsedAt: string | null
  lastUsedIp: string | null
  revokedAt: string | null
  createdAt: string
  updatedAt: string
}

interface DbRow {
  id: string
  owner_user_id: string
  label: string
  scope: string
  token_prefix: string
  token_hash: string
  capabilities_json: string | unknown[]
  expires_at: string | null
  last_used_at: string | null
  last_used_ip: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
}

function rowToRecord(row: DbRow): ApiKeyRecord {
  const caps = row.capabilities_json
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    label: row.label,
    scope: row.scope as ApiKeyScope,
    tokenPrefix: row.token_prefix,
    tokenHash: row.token_hash,
    capabilities: Array.isArray(caps) ? (caps as string[]) : JSON.parse(String(caps)),
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createApiKey(
  db: DbClient,
  args: {
    id: string
    ownerUserId: string
    label: string
    scope: ApiKeyScope
    tokenPrefix: string
    tokenHash: string
    capabilities: string[]
    expiresAt: string | null
  },
): Promise<ApiKeyRecord> {
  const { rows } = await db<DbRow>`
    insert into api_keys (
      id, owner_user_id, label, scope, token_prefix, token_hash,
      capabilities_json, expires_at
    ) values (
      ${args.id}, ${args.ownerUserId}, ${args.label}, ${args.scope},
      ${args.tokenPrefix}, ${args.tokenHash},
      ${JSON.stringify(args.capabilities)}::jsonb,
      ${args.expiresAt}
    )
    returning *
  `
  return rowToRecord(rows[0])
}

export async function listApiKeys(
  db: DbClient,
  ownerUserId: string,
): Promise<ApiKeyRecord[]> {
  const { rows } = await db<DbRow>`
    select * from api_keys
    where owner_user_id = ${ownerUserId}
      and revoked_at is null
    order by created_at desc
  `
  return rows.map(rowToRecord)
}

export async function findApiKeyByHash(
  db: DbClient,
  tokenHash: string,
): Promise<ApiKeyRecord | null> {
  const { rows } = await db<DbRow>`
    select * from api_keys
    where token_hash = ${tokenHash}
      and revoked_at is null
      and (expires_at is null or expires_at > now())
    limit 1
  `
  return rows[0] ? rowToRecord(rows[0]) : null
}

export async function revokeApiKey(
  db: DbClient,
  id: string,
  ownerUserId: string,
): Promise<boolean> {
  const { rows } = await db`
    update api_keys
    set revoked_at = now(), updated_at = now()
    where id = ${id} and owner_user_id = ${ownerUserId} and revoked_at is null
    returning id
  `
  return rows.length > 0
}

export async function recordApiKeyUsage(
  db: DbClient,
  id: string,
  ip: string | null,
): Promise<void> {
  await db`
    update api_keys
    set last_used_at = now(), last_used_ip = ${ip}
    where id = ${id}
  `
}