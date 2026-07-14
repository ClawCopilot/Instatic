/**
 * DB CRUD for social-login.
 */

import { createHash as _createHash, randomBytes } from 'node:crypto'
import type { DbClient } from '@instatic/plugin-sdk/host'

export interface SocialIdentity {
  id: string
  userId: string
  provider: string
  providerUserId: string
  providerEmail: string | null
  providerDisplayName: string | null
  providerAvatarUrl: string | null
  accessToken: string | null
  refreshToken: string | null
  tokenExpiresAt: string | null
  rawProfile: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

interface IdentityRow {
  id: string
  user_id: string
  provider: string
  provider_user_id: string
  provider_email: string | null
  provider_display_name: string | null
  provider_avatar_url: string | null
  access_token: string | null
  refresh_token: string | null
  token_expires_at: string | null
  raw_profile_json: string | unknown
  created_at: string
  updated_at: string
}

function parseJson<T>(value: string | T): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value
}

function rowToIdentity(row: IdentityRow): SocialIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    providerEmail: row.provider_email,
    providerDisplayName: row.provider_display_name,
    providerAvatarUrl: row.provider_avatar_url,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
    rawProfile: parseJson<Record<string, unknown>>(row.raw_profile_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function findIdentityByProviderUser(
  db: DbClient,
  provider: string,
  providerUserId: string,
): Promise<SocialIdentity | null> {
  const { rows } = await db<IdentityRow>`
    select * from social_identities
    where provider = ${provider} and provider_user_id = ${providerUserId}
    limit 1
  `
  return rows[0] ? rowToIdentity(rows[0]) : null
}

export async function findIdentityByProviderEmail(
  db: DbClient,
  provider: string,
  email: string,
): Promise<SocialIdentity | null> {
  const { rows } = await db<IdentityRow>`
    select * from social_identities
    where provider = ${provider} and provider_email = ${email}
    limit 1
  `
  return rows[0] ? rowToIdentity(rows[0]) : null
}

export async function upsertIdentity(
  db: DbClient,
  args: Omit<SocialIdentity, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<SocialIdentity> {
  const id = `si_${randomBytes(8).toString('hex')}`
  const { rows } = await db<IdentityRow>`
    insert into social_identities (
      id, user_id, provider, provider_user_id,
      provider_email, provider_display_name, provider_avatar_url,
      access_token, refresh_token, token_expires_at, raw_profile_json
    ) values (
      ${id}, ${args.userId}, ${args.provider}, ${args.providerUserId},
      ${args.providerEmail}, ${args.providerDisplayName}, ${args.providerAvatarUrl},
      ${args.accessToken}, ${args.refreshToken}, ${args.tokenExpiresAt},
      ${JSON.stringify(args.rawProfile)}::jsonb
    )
    on conflict (provider, provider_user_id) do update
    set user_id = excluded.user_id,
        provider_email = excluded.provider_email,
        provider_display_name = excluded.provider_display_name,
        provider_avatar_url = excluded.provider_avatar_url,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_expires_at = excluded.token_expires_at,
        raw_profile_json = excluded.raw_profile_json,
        updated_at = now()
    returning *
  `
  return rowToIdentity(rows[0])
}

export async function listIdentitiesForUser(
  db: DbClient,
  userId: string,
): Promise<SocialIdentity[]> {
  const { rows } = await db<IdentityRow>`
    select * from social_identities where user_id = ${userId} order by created_at
  `
  return rows.map(rowToIdentity)
}

export async function unlinkIdentity(
  db: DbClient,
  userId: string,
  provider: string,
): Promise<void> {
  await db`delete from social_identities where user_id = ${userId} and provider = ${provider}`
}

// ─── State tokens (CSRF defense) ─────────────────────────────────────────

export async function createState(
  db: DbClient,
  args: { state: string; provider: string; redirectTo: string; nonce: string; expiresAt: string },
): Promise<void> {
  await db`
    insert into social_auth_states (state, provider, redirect_to, nonce, expires_at)
    values (${args.state}, ${args.provider}, ${args.redirectTo}, ${args.nonce}, ${args.expiresAt})
  `
}

export async function consumeState(
  db: DbClient,
  state: string,
): Promise<{ provider: string; redirectTo: string; nonce: string } | null> {
  const { rows } = await db`
    update social_auth_states
    set consumed_at = now()
    where state = ${state} and consumed_at is null and expires_at > now()
    returning provider, redirect_to, nonce
  `
  return rows[0] ? {
    provider: rows[0].provider,
    redirectTo: rows[0].redirect_to,
    nonce: rows[0].nonce,
  } : null
}

export function generateState(): string {
  return randomBytes(32).toString('base64url')
}

// ─── Token 更新（用于 refresh token 轮换） ─────────────────────────────

/**
 * 更新已有社交身份的 token 信息（refresh token 轮换后使用）。
 */
export async function updateIdentityTokens(
  db: DbClient,
  userId: string,
  provider: string,
  tokens: { accessToken: string; refreshToken?: string | null; tokenExpiresAt?: string | null },
): Promise<void> {
  await db`
    update social_identities
    set access_token = ${tokens.accessToken},
        refresh_token = ${tokens.refreshToken ?? null},
        token_expires_at = ${tokens.tokenExpiresAt ?? null},
        updated_at = now()
    where user_id = ${userId} and provider = ${provider}
  `
}