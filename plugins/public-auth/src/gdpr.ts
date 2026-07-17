/**
 * GDPR data subject rights — account deletion + data export.
 *
 * GDPR grants every data subject:
 *   - Right to erasure (Art. 17) — DELETE /api/auth/me
 *   - Right to data portability (Art. 20) — GET /api/auth/me/export
 *
 * Deletion strategy: SOFT delete + PII anonymization.
 *   - We never hard-delete rows (breaks FK chains + audit trails)
 *   - Instead, we:
 *       1. Set deleted_at = now()
 *       2. Anonymize email/display_name (replace with deleted-<id>)
 *       3. Wipe password hash, MFA secret, recovery codes
 *       4. Revoke all sessions
 *   - The row is preserved (so existing orders/invoices can still reference
 *     the user id without orphaning history).
 *
 * Export strategy: collect all rows referencing the user across every
 * plugin-owned table and bundle them as a single JSON document.
 *   - This plugin exports: public_users, public_sessions (metadata only,
 *     NOT the session tokens), public_verification_tokens
 *   - Other plugins (commerce, membership, oidc-provider) SHOULD subscribe
 *     to the public-auth.userDataExportRequested hook and contribute their
 *     own slices. This way, the export aggregates data from every plugin
 *     that touches the user.
 *
 * "Cooling-off" period: handleDelete uses scheduleUserDeletion which
 * enforces a 7-day cooling-off period before actual anonymization.
 * During this window the user can cancel via POST /api/auth/me/delete/cancel
 * using the cancelToken returned at scheduling time.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { DbClient } from '@instatic/plugin-sdk/host'

export interface DeletedUserExport {
  user: {
    id: string
    email: string
    displayName: string
    status: string
    createdAt: string
    deletedAt: string
    anonymizedFields: string[]
  }
  sessions: Array<{
    id: string
    createdAt: string
    lastSeenAt: string
    ipAddress: string | null
    userAgent: string | null
  }>
  verificationTokens: Array<{ id: string; purpose: string; createdAt: string; consumedAt: string | null }>
  pluginData: Record<string, unknown>
  exportedAt: string
  exportVersion: string
}

export const EXPORT_VERSION = '1.0.0'

/**
 * Export all data the plugin holds about a user. Returns a JSON-serialisable
 * object — caller serialises to file/email/etc.
 */
export async function exportUserData(
  db: DbClient,
  userId: string,
  pluginData: Record<string, unknown> = {},
): Promise<DeletedUserExport> {
  const { rows: userRows } = await db`
    select id, email, display_name, status, created_at, deleted_at
    from public_users where id = ${userId} limit 1
  `
  if (!userRows[0]) throw new Error('user_not_found')
  const user = userRows[0]
  const { rows: sessions } = await db`
    select id, created_at, last_seen_at, ip_address, user_agent
    from public_sessions
    where user_id = ${userId}
    order by created_at desc
  `
  const { rows: tokens } = await db`
    select id, purpose, created_at, consumed_at
    from public_verification_tokens
    where user_id = ${userId}
    order by created_at desc
  `
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      status: user.status,
      createdAt: user.created_at,
      deletedAt: user.deleted_at,
      anonymizedFields: [],
    },
    sessions: sessions.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      ipAddress: s.ip_address,
      userAgent: s.user_agent,
    })),
    verificationTokens: tokens.map((t) => ({
      id: t.id,
      purpose: t.purpose,
      createdAt: t.created_at,
      consumedAt: t.consumed_at,
    })),
    pluginData,
    exportedAt: new Date().toISOString(),
    exportVersion: EXPORT_VERSION,
  }
}

/**
 * Anonymize the user row + revoke sessions. Idempotent: safe to call
 * twice (second call is a no-op for already-anonymized fields).
 *
 * Strategy:
 *   - email: original@example.com → deleted-{id}@anonymized.invalid
 *   - email_normalized: same (also anonymized so the unique index allows re-creation)
 *   - display_name: "Deleted User {id}"
 *   - password_hash: random unmatchable hash
 *   - mfa_* : cleared
 *   - status: 'suspended'
 *   - deleted_at: now()
 *
 * Note: we don't anonymize the email if it ALREADY contains a deleted-*
 * marker, which lets us call this multiple times safely.
 */
export async function anonymizeUser(
  db: DbClient,
  userId: string,
  options?: { coolingOffDays?: number },
): Promise<{
  anonymizedFields: string[]
  sessionRevokedCount: number
}> {
  const anonymizedFields: string[] = []
  const deletedEmail = `deleted-${userId}@anonymized.invalid`
  const deletedName = `Deleted User ${userId.slice(0, 8)}`
  const randomHash = `$$argon2id$v=19$m=19456,t=2,p=1$${randomBytes(32).toString('base64url')}$${randomBytes(32).toString('base64url')}`

  // Anonymize the main row
  const { rows: current } = await db`
    select email, display_name, deletion_scheduled_at from public_users where id = ${userId} limit 1
  `
  if (!current[0]) throw new Error('user_not_found')

  // 冷静期检查：如果设置了 coolingOffDays，仅当 deletion_scheduled_at 已到期才执行实际删除
  if (options?.coolingOffDays != null) {
    const scheduledAt = new Date(Date.now() + options.coolingOffDays * 86_400_000).toISOString()
    await db`
      update public_users
      set status = 'pending_deletion',
          deletion_scheduled_at = ${scheduledAt},
          updated_at = now()
      where id = ${userId} and deleted_at is null
    `
    return { anonymizedFields: [], sessionRevokedCount: 0 }
  }

  // 如果用户有未到期的 deletion_scheduled_at，不执行删除
  if (current[0].deletion_scheduled_at && new Date(current[0].deletion_scheduled_at) > new Date()) {
    return { anonymizedFields: [], sessionRevokedCount: 0 }
  }
  const newEmail = current[0].email?.startsWith('deleted-') ? current[0].email : deletedEmail
  const newName = current[0].display_name?.startsWith('Deleted User ') ? current[0].display_name : deletedName
  if (newEmail !== current[0].email) anonymizedFields.push('email', 'email_normalized')
  if (newName !== current[0].display_name) anonymizedFields.push('display_name')

  await db`
    update public_users
    set email = ${newEmail},
        email_normalized = ${newEmail.toLowerCase()},
        display_name = ${newName},
        password_hash = ${randomHash},
        status = 'suspended',
        mfa_totp_secret_ciphertext = null,
        mfa_totp_secret_iv = null,
        mfa_totp_secret_key_fingerprint = null,
        mfa_recovery_code_hashes_json = '[]',
        email_verified_at = null,
        metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{anonymized}', 'true'::jsonb),
        deleted_at = coalesce(deleted_at, now()),
        updated_at = now()
    where id = ${userId}
  `
  anonymizedFields.push('password_hash', 'mfa_secrets', 'mfa_recovery_codes', 'email_verified_at')

  // Revoke all sessions
  const { rows: revoked } = await db`
    update public_sessions
    set revoked_at = now()
    where user_id = ${userId} and revoked_at is null
    returning id
  `
  // Mark all unconsumed verification tokens as consumed (effectively cancel them)
  await db`
    update public_verification_tokens
    set consumed_at = now()
    where user_id = ${userId} and consumed_at is null
  `

  return {
    anonymizedFields,
    sessionRevokedCount: revoked.length,
  }
}

/**
 * 调度用户删除（冷静期模式）。设置 deletion_scheduled_at 而非立即删除。
 * 冷静期内用户可以通过 handleCancelDeletion 取消删除。
 */
export async function scheduleUserDeletion(
  db: DbClient,
  userId: string,
  coolingOffDays = 7,
): Promise<{ scheduledAt: string; cancelToken: string }> {
  const cancelToken = randomBytes(16).toString('hex')
  const scheduledAt = new Date(Date.now() + coolingOffDays * 86_400_000).toISOString()
  await db`
    update public_users
    set status = 'pending_deletion',
        deletion_scheduled_at = ${scheduledAt},
        deletion_cancel_token_hash = ${createHash('sha256').update(cancelToken).digest('hex')},
        updated_at = now()
    where id = ${userId} and deleted_at is null
  `
  return { scheduledAt, cancelToken }
}

/**
 * 取消已调度的用户删除（冷静期内）。
 */
export async function cancelScheduledDeletion(
  db: DbClient,
  cancelToken: string,
): Promise<{ ok: boolean; reason?: string }> {
  const tokenHash = createHash('sha256').update(cancelToken).digest('hex')
  const { rows } = await db`
    update public_users
    set status = 'active',
        deletion_scheduled_at = null,
        deletion_cancel_token_hash = null,
        updated_at = now()
    where deletion_cancel_token_hash = ${tokenHash}
      and deletion_scheduled_at > now()
    returning id
  `
  if (!rows[0]) return { ok: false, reason: 'invalid_or_expired_cancel_token' }
  return { ok: true }
}

/**
 * 执行已过冷静期的定时删除任务。返回已处理的用户数。
 */
export async function processScheduledDeletions(db: DbClient): Promise<number> {
  const { rows } = await db`
    select id from public_users
    where status = 'pending_deletion'
      and deletion_scheduled_at is not null
      and deletion_scheduled_at <= now()
  `
  for (const row of rows) {
    await anonymizeUser(db, row.id)
  }
  return rows.length
}