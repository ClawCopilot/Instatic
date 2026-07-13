/**
 * Route handlers for plugin admin UI + marketplace.
 *
 * All admin pages require the host's `users.manage` capability.
 * The marketplace is public.
 *
 * These pages are self-contained HTML — no React, no build pipeline.
 * They use the existing plugin API endpoints for all CRUD operations.
 *
 * Routes added:
 *   GET  /admin/plugins/api-keys           (users.manage)
 *   GET  /admin/plugins/oidc-clients       (users.manage)
 *   GET  /admin/plugins/membership-tiers   (users.manage)
 *   GET  /marketplace                       (public)
 *   GET  /admin/plugins                     (users.manage) — index page
 */

import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { renderApiKeysPage, renderOidcClientsPage, renderMembershipTiersPage } from './apiKeysPage'
import { renderMarketplacePage } from './marketplacePage'

export async function handlePluginAdminPages(req: Request, db: DbClient, pathname: string): Promise<Response | null> {
  // Public marketplace — no auth required
  if (pathname === '/marketplace') {
    return new Response(renderMarketplacePage(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  // Admin pages — require users.manage
  if (pathname === '/admin/plugins/api-keys' ||
      pathname === '/admin/plugins/oidc-clients' ||
      pathname === '/admin/plugins/membership-tiers') {
    const user = await requireCapability(req, db, 'users.manage')
    if (user instanceof Response) return user
    const body = pathname === '/admin/plugins/api-keys' ? renderApiKeysPage()
      : pathname === '/admin/plugins/oidc-clients' ? renderOidcClientsPage()
      : renderMembershipTiersPage()
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  return null
}
