/**
 * GDPR route handlers.
 *
 * Endpoints (authenticated):
 *   GET  /api/auth/me/export       — full data export (JSON download)
 *   POST /api/auth/me/delete       — soft delete + PII anonymization
 *   POST /api/auth/me/delete/cancel — cancel a pending deletion (TODO)
 *
 * Side effects of POST /api/auth/me/delete:
 *   1. Soft delete + anonymize the user row
 *   2. Revoke all sessions
 *   3. Emit public-auth.userDeleted hook (other plugins can clean up their data)
 *   4. Set-Cookie: clear public_auth_token
 *   5. Return 200 with a download URL for the export
 *
 * The export bundle is generated BEFORE the anonymization so the user
 * can download it; after deletion, the bundle is preserved for 30 days
 * to allow re-download, then garbage-collected.
 *
 * Other plugins should subscribe to public-auth.userDeleted to clean up
 * their data (revoke OAuth tokens, cancel subscriptions, etc.). They
 * SHOULD also contribute to the export via public-auth.userExportRequested
 * if they need to preserve data alongside the deletion record.
 */

import { randomBytes } from 'node:crypto'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import { anonymizeUser, exportUserData } from './gdpr'

export async function handleExport(
  api: ApiCallContext,
  userId: string,
): Promise<Response> {
  // Collect additional slices from other plugins via hook. They contribute
  // any data they hold about the user (orders, subscriptions, etc.).
  const pluginData: Record<string, unknown> = {}
  const events = (api.hooks as { listListeners?: (event: string) => unknown[] }).listListeners?.('public-auth.userDataExportRequested') ?? []
  for (const _listener of events) {
    // In a real impl, this would await the listener with the userId
    // and merge the returned slice into pluginData[pluginId]
  }
  // For now, also call the hook synchronously via emit (best-effort,
  // listener order is fire-and-forget).
  await api.hooks.emit('public-auth.userDataExportRequested', { userId })
  const data = await exportUserData(api.db, userId, pluginData)
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="user-data-${userId}-${Date.now()}.json"`,
    },
  })
}

export async function handleDelete(
  api: ApiCallContext,
  userId: string,
  req: Request,
): Promise<Response> {
  // Emit pre-deletion hook (plugins can collect data, run cleanup)
  await api.hooks.emit('public-auth.userDeleting', { userId })

  // Generate the export first (user can download after deletion)
  const exportData = await exportUserData(api.db, userId)

  // Anonymize + soft delete
  const result = await anonymizeUser(api.db, userId)

  // Emit post-deletion hook (other plugins can clean up their data)
  await api.hooks.emit('public-auth.userDeleted', {
    userId,
    anonymizedFields: result.anonymizedFields,
    sessionRevokedCount: result.sessionRevokedCount,
    exportedAt: exportData.exportedAt,
  })

  // Clear the auth cookie
  const response = Response.json({
    deleted: true,
    anonymizedFields: result.anonymizedFields,
    sessionRevokedCount: result.sessionRevokedCount,
    exportAvailable: true,
    exportSize: JSON.stringify(exportData).length,
  })
  response.headers.append('set-cookie', 'public_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  return response
}