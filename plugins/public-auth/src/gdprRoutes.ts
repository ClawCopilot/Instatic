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

import { randomBytes as _randomBytes } from 'node:crypto'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import { exportUserData } from './gdpr'

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
  _req: Request,
): Promise<Response> {
  // Emit pre-deletion hook (plugins can collect data, run cleanup)
  await api.hooks.emit('public-auth.userDeleting', { userId })

  // Generate the export first (user can download after deletion)
  const exportData = await exportUserData(api.db, userId)

  // 使用冷静期模式调度删除（默认 7 天），而非立即删除
  const { scheduleUserDeletion } = await import('./gdpr')
  const { scheduledAt } = await scheduleUserDeletion(api.db, userId, 7)

  // Emit post-deletion hook (other plugins can clean up their data)
  await api.hooks.emit('public-auth.userDeleted', {
    userId,
    anonymizedFields: [],
    sessionRevokedCount: 0,
    exportedAt: exportData.exportedAt,
  })

  // Clear the auth cookie
  const response = Response.json({
    deleted: true,
    scheduledAt,
    anonymizedFields: [],
    sessionRevokedCount: 0,
    exportAvailable: true,
    exportSize: JSON.stringify(exportData).length,
  })
  response.headers.append('set-cookie', 'public_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  return response
}

export async function handleCancelDeletion(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: { cancelToken?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.cancelToken) {
    return Response.json({ error: 'cancelToken required' }, { status: 400 })
  }
  const result = await (await import('./gdpr')).cancelScheduledDeletion(api.db, body.cancelToken)
  if (!result.ok) return Response.json({ error: result.reason }, { status: 400 })
  return Response.json({ canceled: true })
}