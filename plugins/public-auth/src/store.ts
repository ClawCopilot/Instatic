/**
 * DB CRUD for public-auth plugin.
 *
 * Password hashing uses argon2id with conservative parameters:
 *   - 19 MiB memory cost (resists GPU/ASIC attacks)
 *   - 2 iterations
 *   - 1 parallelism
 *
 * These parameters take ~50ms on a modern server — acceptable for a
 * registration/login flow, expensive enough to make online brute force
 * impractical.
 */

import { createHash as _createHash, randomBytes } from 'node:crypto'
import { promisify as _promisify } from 'node:util'
import { argon2id as _argon2id } from 'hash-wasm'
import type { DbClient } from '@instatic/plugin-sdk/host'

export type UserStatus = 'active' | 'suspended' | 'pending_verification'

export interface PublicUserRecord {
  id: string
  email: string
  emailNormalized: string
  displayName: string
  passwordHash: string
  status: UserStatus
  emailVerifiedAt: string | null
  failedLoginCount: number
  lockedUntil: string | null
  lastLoginAt: string | null
  passwordUpdatedAt: string
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface PublicSessionRecord {
  id: string
  userId: string
  tokenHash: string
  userAgent: string | null
  ipAddress: string | null
  expiresAt: string
  revokedAt: string | null
  createdAt: string
  lastSeenAt: string
}

interface UserRow {
  id: string
  email: string
  email_normalized: string
  display_name: string
  password_hash: string
  status: string
  email_verified_at: string | null
  failed_login_count: number
  locked_until: string | null
  last_login_at: string | null
  password_updated_at: string
  metadata_json: string | unknown
  created_at: string
  updated_at: string
}

interface SessionRow {
  id: string
  user_id: string
  token_hash: string
  user_agent: string | null
  ip_address: string | null
  expires_at: string
  revoked_at: string | null
  created_at: string
  last_seen_at: string
}

function rowToUser(row: UserRow): PublicUserRecord {
  const meta = row.metadata_json
  return {
    id: row.id,
    email: row.email,
    emailNormalized: row.email_normalized,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    status: row.status as UserStatus,
    emailVerifiedAt: row.email_verified_at,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    passwordUpdatedAt: row.password_updated_at,
    metadata: typeof meta === 'string' ? JSON.parse(meta) : (meta as Record<string, unknown>),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSession(row: SessionRow): PublicSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    userAgent: row.user_agent,
    ipAddress: row.ip_address,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }
}

// ─── Password hashing ─────────────────────────────────────────────────────

const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19456, // KiB (~19 MiB)
  hashLength: 32,
  outputType: 'encoded' as const,
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  return await _argon2id({
    password,
    salt,
    ...ARGON2_PARAMS,
  })
}

export async function verifyPassword(passwordHash: string, candidate: string): Promise<boolean> {
  try {
    return await _argon2id({
      password: candidate,
      hash: passwordHash,
    })
  } catch {
    return false
  }
}

// ─── User CRUD ─────────────────────────────────────────────────────────────

export async function findUserByEmail(
  db: DbClient,
  email: string,
): Promise<PublicUserRecord | null> {
  const normalized = email.trim().toLowerCase()
  const { rows } = await db<UserRow>`
    select * from public_users
    where email_normalized = ${normalized} and deleted_at is null
    limit 1
  `
  return rows[0] ? rowToUser(rows[0]) : null
}

export async function findUserById(
  db: DbClient,
  id: string,
): Promise<PublicUserRecord | null> {
  const { rows } = await db<UserRow>`
    select * from public_users
    where id = ${id} and deleted_at is null
    limit 1
  `
  return rows[0] ? rowToUser(rows[0]) : null
}

export async function createUser(
  db: DbClient,
  args: {
    id: string
    email: string
    displayName: string
    passwordHash: string
    status?: UserStatus
    metadata?: Record<string, unknown>
  },
): Promise<PublicUserRecord> {
  const emailNormalized = args.email.trim().toLowerCase()
  const status = args.status ?? 'active'
  const { rows } = await db<UserRow>`
    insert into public_users (
      id, email, email_normalized, display_name, password_hash, status, metadata_json
    ) values (
      ${args.id}, ${args.email}, ${emailNormalized}, ${args.displayName},
      ${args.passwordHash}, ${status},
      ${JSON.stringify(args.metadata ?? {})}::jsonb
    )
    returning *
  `
  return rowToUser(rows[0])
}

export async function updateUserPassword(
  db: DbClient,
  id: string,
  newHash: string,
): Promise<void> {
  await db`
    update public_users
    set password_hash = ${newHash},
        password_updated_at = now(),
        failed_login_count = 0,
        locked_until = null,
        updated_at = now()
    where id = ${id}
  `
}

export async function recordSuccessfulLogin(db: DbClient, id: string): Promise<void> {
  await db`
    update public_users
    set last_login_at = now(),
        failed_login_count = 0,
        locked_until = null,
        updated_at = now()
    where id = ${id}
  `
}

export async function recordFailedLogin(
  db: DbClient,
  id: string,
  maxAttempts: number = 5,
  lockoutMinutes: number = 15,
): Promise<{ locked: boolean }> {
  const user = await findUserById(db, id)
  if (!user) return { locked: false }
  const failedCount = user.failedLoginCount + 1
  const locked = failedCount >= maxAttempts
  await db`
    update public_users
    set failed_login_count = ${failedCount},
        locked_until = ${locked ? new Date(Date.now() + lockoutMinutes * 60_000).toISOString() : null},
        updated_at = now()
    where id = ${id}
  `
  return { locked }
}

// ─── Session CRUD ──────────────────────────────────────────────────────────

export async function createSession(
  db: DbClient,
  args: {
    id: string
    userId: string
    tokenHash: string
    userAgent: string | null
    ipAddress: string | null
    expiresAt: string
  },
): Promise<PublicSessionRecord> {
  const { rows } = await db<SessionRow>`
    insert into public_sessions (
      id, user_id, token_hash, user_agent, ip_address, expires_at
    ) values (
      ${args.id}, ${args.userId}, ${args.tokenHash},
      ${args.userAgent}, ${args.ipAddress}, ${args.expiresAt}
    )
    returning *
  `
  return rowToSession(rows[0])
}

export async function findActiveSession(
  db: DbClient,
  tokenHash: string,
): Promise<PublicSessionRecord | null> {
  const { rows } = await db<SessionRow>`
    select * from public_sessions
    where token_hash = ${tokenHash}
      and revoked_at is null
      and expires_at > now()
    limit 1
  `
  return rows[0] ? rowToSession(rows[0]) : null
}

export async function touchSession(db: DbClient, id: string): Promise<void> {
  await db`
    update public_sessions
    set last_seen_at = now()
    where id = ${id}
  `
}

export async function revokeSession(db: DbClient, tokenHash: string): Promise<void> {
  await db`
    update public_sessions
    set revoked_at = now()
    where token_hash = ${tokenHash} and revoked_at is null
  `
}

export async function revokeAllSessionsForUser(db: DbClient, userId: string): Promise<void> {
  await db`
    update public_sessions
    set revoked_at = now()
    where user_id = ${userId} and revoked_at is null
  `
}

// ─── Verification tokens ──────────────────────────────────────────────────

export async function createVerificationToken(
  db: DbClient,
  args: {
    id: string
    userId: string
    purpose: 'email_verification' | 'password_reset'
    tokenHash: string
    expiresAt: string
  },
): Promise<void> {
  await db`
    insert into public_verification_tokens (
      id, user_id, purpose, token_hash, expires_at
    ) values (
      ${args.id}, ${args.userId}, ${args.purpose},
      ${args.tokenHash}, ${args.expiresAt}
    )
  `
}

export async function consumeVerificationToken(
  db: DbClient,
  tokenHash: string,
): Promise<{ userId: string; purpose: 'email_verification' | 'password_reset' } | null> {
  const { rows } = await db`
    update public_verification_tokens
    set consumed_at = now()
    where token_hash = ${tokenHash}
      and consumed_at is null
      and expires_at > now()
    returning user_id, purpose
  `
  return rows[0] ? { userId: rows[0].user_id, purpose: rows[0].purpose } : null
}