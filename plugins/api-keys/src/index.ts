/**
 * API Keys plugin — server entrypoint.
 *
 * Exposes three layers:
 *   1. Admin API  : /admin/api/cms/api-keys/*    (requires users.manage capability)
 *   2. Public API : /api/keys/me                  (Bearer-token authenticated)
 *   3. Middleware : resolved for downstream plugins via api.readMiddlewareState()
 *
 * Tokens are stored as SHA-256 hashes; the plaintext token is returned to
 * the user exactly once at creation. See `tokens.ts` for the format.
 *
 * Lifecycle:
 *   - `install()` — declares the SQL migration (creates `api_keys` table)
 *   - `activate()` — registers admin + public routes
 *   - `deactivate()` — host auto-cleans routes / migrations; no manual teardown
 */

import { definePlugin } from '@instatic/plugin-sdk'
import migrations from './migrations'
import { extractBearerToken, hashToken } from './tokens'
import {
  handleCreateKey,
  handleListKeys,
  handleResolveMe,
  handleRevokeKey,
} from './routes'

export default definePlugin({
  id: 'api-keys',
  name: 'API Keys',
  version: '0.1.0',

  migrations,

  async activate(api) {
    // Register SQL migration (id must include the plugin id).
    for (const migration of migrations) {
      await api.cms.migrations.register(migration)
    }

    // ── Admin routes ───────────────────────────────────────────────────────
    // Host path prefix: /admin/api/cms/plugins/api-keys/runtime/...
    // We use the helper api.cms.routes.register which auto-prefixes.
    await api.cms.routes.register('GET', '/admin/api/keys', 'users.manage', async (ctx, req) => {
      return handleListKeys({ ...ctx, extractBearerToken, hashToken })
    })
    await api.cms.routes.register('POST', '/admin/api/keys', 'users.manage', async (ctx, req) => {
      return handleCreateKey({ ...ctx, extractBearerToken, hashToken }, req)
    })
    await api.cms.routes.register('DELETE', '/admin/api/keys/:id', 'users.manage', async (ctx, req, params) => {
      return handleRevokeKey({ ...ctx, extractBearerToken, hashToken }, params.id)
    })

    // ── Public route prefix + handler ──────────────────────────────────────
    // First claim the prefix so no other plugin can register /api/keys.
    await api.cms.publicRoutes.register('/api/keys', { exclusive: true })
    await api.cms.routes.register('GET', '/api/keys/me', 'public', async (ctx, req) => {
      return handleResolveMe({ ...ctx, extractBearerToken, hashToken }, req)
    })

    api.log.info('api-keys plugin activated')
  },

  async deactivate(api) {
    // Host automatically removes registered routes / migrations / gates.
    // Nothing to clean up manually.
    api.log.info('api-keys plugin deactivated')
  },
})