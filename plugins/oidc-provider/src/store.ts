/**
 * DB CRUD for oidc-provider plugin.
 */

import type { DbClient } from '@instatic/plugin-sdk/host'

export type ClientType = 'confidential' | 'public'
export type GrantType = 'authorization_code' | 'refresh_token' | 'client_credentials'

export interface OidcClient {
  id: string
  clientId: string
  clientSecretHash: string | null
  name: string
  description: string
  redirectUris: string[]
  allowedScopes: string[]
  allowedGrantTypes: GrantType[]
  clientType: ClientType
  requirePkce: boolean
  requireConsent: boolean
  logoUrl: string | null
  homepageUrl: string | null
  metadata: Record<string, unknown>
  disabledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AuthCode {
  codeHash: string
  clientId: string
  userId: string
  redirectUri: string
  scopes: string[]
  codeChallenge: string | null
  codeChallengeMethod: string | null
  nonce: string | null
  authTime: string
  consumedAt: string | null
  expiresAt: string
  createdAt: string
}

export interface AccessToken {
  tokenHash: string
  clientId: string
  userId: string | null
  scopes: string[]
  expiresAt: string
  revokedAt: string | null
  createdAt: string
  lastUsedAt: string | null
}

export interface RefreshToken {
  tokenHash: string
  accessTokenHash: string | null
  clientId: string
  userId: string | null
  scopes: string[]
  expiresAt: string
  revokedAt: string | null
  rotatedFrom: string | null
  createdAt: string
  lastUsedAt: string | null
}

export interface Consent {
  id: string
  userId: string
  clientId: string
  scopes: string[]
  grantedAt: string
  revokedAt: string | null
}

interface ClientRow {
  id: string
  client_id: string
  client_secret_hash: string | null
  name: string
  description: string
  redirect_uris_json: string | unknown[]
  allowed_scopes_json: string | unknown[]
  allowed_grant_types_json: string | unknown[]
  client_type: string
  require_pkce: boolean | number
  require_consent: boolean | number
  logo_url: string | null
  homepage_url: string | null
  metadata_json: string | unknown
  disabled_at: string | null
  created_at: string
  updated_at: string
}

function parseJson<T>(value: string | T): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value
}

function rowToClient(row: ClientRow): OidcClient {
  return {
    id: row.id,
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    name: row.name,
    description: row.description,
    redirectUris: parseJson<string[]>(row.redirect_uris_json),
    allowedScopes: parseJson<string[]>(row.allowed_scopes_json),
    allowedGrantTypes: parseJson<GrantType[]>(row.allowed_grant_types_json),
    clientType: row.client_type as ClientType,
    requirePkce: !!row.require_pkce,
    requireConsent: !!row.require_consent,
    logoUrl: row.logo_url,
    homepageUrl: row.homepage_url,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ─── Clients ─────────────────────────────────────────────────────────────

export async function findClientByClientId(db: DbClient, clientId: string): Promise<OidcClient | null> {
  const { rows } = await db<ClientRow>`select * from oidc_clients where client_id = ${clientId} and disabled_at is null limit 1`
  return rows[0] ? rowToClient(rows[0]) : null
}

export async function listClients(db: DbClient): Promise<OidcClient[]> {
  const { rows } = await db<ClientRow>`select * from oidc_clients where disabled_at is null order by created_at desc`
  return rows.map(rowToClient)
}

export async function createClient(
  db: DbClient,
  args: Omit<OidcClient, 'createdAt' | 'updatedAt' | 'disabledAt'>,
): Promise<OidcClient> {
  const { rows } = await db<ClientRow>`
    insert into oidc_clients (
      id, client_id, client_secret_hash, name, description,
      redirect_uris_json, allowed_scopes_json, allowed_grant_types_json,
      client_type, require_pkce, require_consent, logo_url, homepage_url, metadata_json
    ) values (
      ${args.id}, ${args.clientId}, ${args.clientSecretHash}, ${args.name}, ${args.description},
      ${JSON.stringify(args.redirectUris)}::jsonb, ${JSON.stringify(args.allowedScopes)}::jsonb,
      ${JSON.stringify(args.allowedGrantTypes)}::jsonb,
      ${args.clientType}, ${args.requirePkce}, ${args.requireConsent},
      ${args.logoUrl}, ${args.homepageUrl}, ${JSON.stringify(args.metadata)}::jsonb
    )
    returning *
  `
  return rowToClient(rows[0])
}

export async function updateClient(
  db: DbClient,
  id: string,
  patch: Partial<OidcClient>,
): Promise<OidcClient | null> {
  const fields: string[] = []
  const values: unknown[] = []
  let i = 1
  for (const [k, v] of Object.entries(patch)) {
    if (['createdAt', 'updatedAt', 'id'].includes(k)) continue
    const col = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
    const value = Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : v
    fields.push(`${col} = $${i++}`)
    values.push(value)
  }
  if (fields.length === 0) return await findClientByClientId(db, id)
  fields.push(`updated_at = now()`)
  const { rows } = await db.unsafe(
    `update oidc_clients set ${fields.join(', ')} where id = $${i} returning *`,
    [...values, id],
  ) as { rows: ClientRow[] }
  return rows[0] ? rowToClient(rows[0]) : null
}

export async function deleteClient(db: DbClient, id: string): Promise<void> {
  await db`update oidc_clients set disabled_at = now() where id = ${id}`
}

// ─── Auth codes ──────────────────────────────────────────────────────────

export async function createAuthCode(
  db: DbClient,
  args: Omit<AuthCode, 'consumedAt' | 'createdAt'>,
): Promise<void> {
  await db`
    insert into oidc_auth_codes (
      code_hash, client_id, user_id, redirect_uri, scopes_json,
      code_challenge, code_challenge_method, nonce, auth_time, expires_at
    ) values (
      ${args.codeHash}, ${args.clientId}, ${args.userId}, ${args.redirectUri},
      ${JSON.stringify(args.scopes)}::jsonb,
      ${args.codeChallenge}, ${args.codeChallengeMethod}, ${args.nonce},
      ${args.authTime}, ${args.expiresAt}
    )
  `
}

export async function consumeAuthCode(
  db: DbClient,
  codeHash: string,
): Promise<AuthCode | null> {
  // One-shot consumption — update is atomic and returns the row only if it
  // was previously unconsumed.
  const { rows } = await db`
    update oidc_auth_codes
    set consumed_at = now()
    where code_hash = ${codeHash}
      and consumed_at is null
      and expires_at > now()
    returning *
  `
  if (!rows[0]) return null
  const row = rows[0]
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    userId: row.user_id,
    redirectUri: row.redirect_uri,
    scopes: parseJson<string[]>(row.scopes_json),
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    nonce: row.nonce,
    authTime: row.auth_time,
    consumedAt: row.consumed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

// ─── Tokens ───────────────────────────────────────────────────────────────

export async function createAccessToken(
  db: DbClient,
  args: Omit<AccessToken, 'revokedAt' | 'createdAt' | 'lastUsedAt'>,
): Promise<void> {
  await db`
    insert into oidc_access_tokens (token_hash, client_id, user_id, scopes_json, expires_at)
    values (${args.tokenHash}, ${args.clientId}, ${args.userId}, ${JSON.stringify(args.scopes)}::jsonb, ${args.expiresAt})
  `
}

export async function findAccessToken(
  db: DbClient,
  tokenHash: string,
): Promise<AccessToken | null> {
  const { rows } = await db`
    select * from oidc_access_tokens
    where token_hash = ${tokenHash} and revoked_at is null and expires_at > now()
    limit 1
  `
  return rows[0] ? rowsToAccessToken(rows[0]) : null
}

function rowsToAccessToken(row: Record<string, unknown>): AccessToken {
  return {
    tokenHash: row.token_hash as string,
    clientId: row.client_id as string,
    userId: (row.user_id as string) ?? null,
    scopes: parseJson<string[]>(row.scopes_json),
    expiresAt: row.expires_at as string,
    revokedAt: (row.revoked_at as string) ?? null,
    createdAt: row.created_at as string,
    lastUsedAt: (row.last_used_at as string) ?? null,
  }
}

export async function touchAccessToken(db: DbClient, tokenHash: string): Promise<void> {
  await db`update oidc_access_tokens set last_used_at = now() where token_hash = ${tokenHash}`
}

export async function revokeAccessToken(db: DbClient, tokenHash: string): Promise<void> {
  await db`update oidc_access_tokens set revoked_at = now() where token_hash = ${tokenHash} and revoked_at is null`
}

export async function createRefreshToken(
  db: DbClient,
  args: Omit<RefreshToken, 'revokedAt' | 'createdAt' | 'lastUsedAt'>,
): Promise<void> {
  await db`
    insert into oidc_refresh_tokens (token_hash, access_token_hash, client_id, user_id, scopes_json, expires_at, rotated_from)
    values (${args.tokenHash}, ${args.accessTokenHash}, ${args.clientId}, ${args.userId},
            ${JSON.stringify(args.scopes)}::jsonb, ${args.expiresAt}, ${args.rotatedFrom})
  `
}

export async function findRefreshToken(
  db: DbClient,
  tokenHash: string,
): Promise<RefreshToken | null> {
  const { rows } = await db`
    select * from oidc_refresh_tokens
    where token_hash = ${tokenHash} and revoked_at is null and expires_at > now()
    limit 1
  `
  return rows[0] ? {
    tokenHash: rows[0].token_hash,
    accessTokenHash: rows[0].access_token_hash,
    clientId: rows[0].client_id,
    userId: rows[0].user_id,
    scopes: parseJson<string[]>(rows[0].scopes_json),
    expiresAt: rows[0].expires_at,
    revokedAt: rows[0].revoked_at,
    rotatedFrom: rows[0].rotated_from,
    createdAt: rows[0].created_at,
    lastUsedAt: rows[0].last_used_at,
  } : null
}

/**
 * Find a refresh token regardless of revocation state.
 * Used by replay detection: if a token was already rotated, the second
 * use is a replay (token theft) → revoke the entire token family.
 */
export async function findRefreshTokenIncludingRevoked(
  db: DbClient,
  tokenHash: string,
): Promise<RefreshToken | null> {
  const { rows } = await db`
    select * from oidc_refresh_tokens
    where token_hash = ${tokenHash}
    limit 1
  `
  return rows[0] ? {
    tokenHash: rows[0].token_hash,
    accessTokenHash: rows[0].access_token_hash,
    clientId: rows[0].client_id,
    userId: rows[0].user_id,
    scopes: parseJson<string[]>(rows[0].scopes_json),
    expiresAt: rows[0].expires_at,
    revokedAt: rows[0].revoked_at,
    rotatedFrom: rows[0].rotated_from,
    createdAt: rows[0].created_at,
    lastUsedAt: rows[0].last_used_at,
  } : null
}

/**
 * Revoke the entire token family rooted at the given refresh token.
 * Walks `rotated_from` chain to find the root, then revokes all tokens
 * in the subtree.
 *
 * Called on replay detection: a refresh token was used twice, which
 * means the second use is by an attacker (or a misbehaving client).
 * The legitimate user's next refresh attempt will also fail, which is
 * the cost we accept for prompt breach notification.
 */
export async function revokeTokenFamily(
  db: DbClient,
  rootTokenHash: string,
): Promise<number> {
  // Walk up to find the root
  let current: string | null = rootTokenHash
  let root: string = rootTokenHash
  for (let i = 0; i < 1000 && current; i++) {  // bounded loop
    const { rows } = await db<{ rotated_from: string | null }>`
      select rotated_from from oidc_refresh_tokens where token_hash = ${current} limit 1
    `
    if (!rows[0]?.rotated_from) break
    root = rows[0].rotated_from
    current = rows[0].rotated_from
  }
  // Revoke the root + all descendants
  const { rows: revoked } = await db`
    with recursive family as (
      select token_hash from oidc_refresh_tokens where token_hash = ${root}
      union all
      select rt.token_hash from oidc_refresh_tokens rt
      join family f on rt.rotated_from = f.token_hash
    )
    update oidc_refresh_tokens
    set revoked_at = now()
    where token_hash in (select token_hash from family) and revoked_at is null
    returning token_hash
  `
  // Also revoke all access tokens issued from this family
  await db`
    update oidc_access_tokens
    set revoked_at = now()
    where user_id in (
      select user_id from oidc_refresh_tokens where token_hash = ${root}
    )
      and client_id in (
        select client_id from oidc_refresh_tokens where token_hash = ${root}
      )
      and created_at > (
        select created_at from oidc_refresh_tokens where token_hash = ${root}
      )
      and revoked_at is null
  `
  return revoked.length
}

export async function rotateRefreshToken(
  db: DbClient,
  oldHash: string,
  newHash: string,
  newAccessTokenHash: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx`
      update oidc_refresh_tokens
      set revoked_at = now()
      where token_hash = ${oldHash}
    `
    await tx`
      insert into oidc_refresh_tokens (token_hash, access_token_hash, rotated_from, client_id, user_id, scopes_json, expires_at)
      select ${newHash}, ${newAccessTokenHash}, ${oldHash}, client_id, user_id, scopes_json, expires_at
      from oidc_refresh_tokens
      where token_hash = ${oldHash}
    `
  })
}

// ─── Consents ────────────────────────────────────────────────────────────

export async function recordConsent(
  db: DbClient,
  args: Omit<Consent, 'id' | 'grantedAt' | 'revokedAt'>,
): Promise<void> {
  await db`
    insert into oidc_consents (id, user_id, client_id, scopes_json)
    values (${`cs_${Math.random().toString(36).slice(2, 10)}`},
            ${args.userId}, ${args.clientId}, ${JSON.stringify(args.scopes)}::jsonb)
    on conflict (user_id, client_id) do update
    set scopes_json = excluded.scopes_json, revoked_at = null, granted_at = now()
  `
}

export async function findConsent(
  db: DbClient,
  userId: string,
  clientId: string,
): Promise<Consent | null> {
  const { rows } = await db`
    select * from oidc_consents
    where user_id = ${userId} and client_id = ${clientId} and revoked_at is null
    limit 1
  `
  return rows[0] ? {
    id: rows[0].id,
    userId: rows[0].user_id,
    clientId: rows[0].client_id,
    scopes: parseJson<string[]>(rows[0].scopes_json),
    grantedAt: rows[0].granted_at,
    revokedAt: rows[0].revoked_at,
  } : null
}