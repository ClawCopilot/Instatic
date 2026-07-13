/**
 * API Keys plugin — server entrypoint.
 *
 * Exposes:
 *   1. Admin API  : /admin/api/cms/api-keys/*    (requires users.manage capability)
 *   2. Public API : /api/keys/me                  (Bearer-token authenticated)
 *
 * Tokens are stored as SHA-256 hashes; the plaintext token is returned
 * to the user exactly once at creation. See `tokens.ts` for the format.
 *
 * Plugin file shape (per the host's plugin loader):
 *   - `default` export: PluginDefinition from `definePlugin({...})`
 *   - named exports: lifecycle hooks — `install`, `activate`, `deactivate`
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
  id: 'instatic.api-keys',
  name: 'API Keys',
  version: '0.1.0',
  permissions: ['cms.migrations', 'cms.routes', 'cms.routes.public', 'cms.publicRoutes'],
})

export async function install(api: any) {
  for (const migration of migrations) {
    await api.cms.migrations.register(migration)
  }
}

export async function activate(api: any) {
  for (const migration of migrations) {
    await api.cms.migrations.register(migration)
  }
  await api.cms.routes.register('GET', '/admin/api/keys', 'users.manage', async (ctx: any, req: Request) => {
    return handleListKeys({ ...ctx, extractBearerToken, hashToken })
  })
  await api.cms.routes.register('POST', '/admin/api/keys', 'users.manage', async (ctx: any, req: Request) => {
    return handleCreateKey({ ...ctx, extractBearerToken, hashToken }, req)
  })
  await api.cms.routes.register('DELETE', '/admin/api/keys/:id', 'users.manage', async (ctx: any, _req: Request, params: any) => {
    return handleRevokeKey({ ...ctx, extractBearerToken, hashToken }, params.id)
  })
  await api.cms.publicRoutes.register('/api/keys', { exclusive: true })
  await api.cms.routes.register('GET', '/api/keys/me', 'public', async (ctx: any, req: Request) => {
    return handleResolveMe({ ...ctx, extractBearerToken, hashToken }, req)
  })
  api.log.info('api-keys plugin activated')
}

export async function deactivate(api: any) {
  // Host automatically removes registered routes / migrations / gates.
  // Nothing to clean up manually.
  api.log.info('api-keys plugin deactivated')
}
