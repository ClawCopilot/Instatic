/**
 * api-call handler for `cms.publicRoutes.register` — the gated bridge
 * for plugin public route registration.
 *
 * Plugin-side usage (from inside a plugin worker):
 *
 *     api.cms.publicRoutes.register('/oauth/authorize', async (req, ctx) => {
 *       // ctx contains { db, uploadsDir, ... } — same shape as the admin
 *       // plugin runtime forwards.
 *       return new Response('...', { status: 200 })
 *     })
 *
 * The handler is forwarded across the worker RPC layer; the host stores
 * a stub that knows the (pluginId, prefix) pair, and the actual handler
 * invocation round-trips back into the worker at request time. This is
 * the same dispatch pattern used by `cms.routes.register` — see
 * `server/plugins/runtime.ts::handleServerPluginRuntimeRequest`.
 *
 * Permission gating: `cms.publicRoutes` is enforced centrally in
 * `apiDispatch.ts` via TARGET_PERMISSIONS. Operators see a consent
 * dialog flag ("this plugin will register anonymous-callable endpoints
 * at path X") during install.
 */

import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../apiReplies'
import { registerPluginPublicRoute } from './publicRoutes'

export async function handlePublicRoutesRegister(
  msg: ApiCallFor<'cms.publicRoutes.register'>,
  _db: DbClient,
): Promise<void> {
  const [{ prefix, exclusive }] = msg.args

  // The host-installed dispatcher walks this prefix and looks up the
  // matching plugin route by exact (method, path). The plugin worker
  // round-trip goes through `runRouteInWorker` (same path as the admin
  // plugin runtime), so the plugin code can use the existing
  // `api.cms.routes.register('/api/auth/login', ...)` to register the
  // concrete route handler.
  const handler = async (req: Request, runtime: { db: DbClient; uploadsDir?: string; databaseUrl?: string }, _url: URL, pathname: string): Promise<Response | null> => {
    const { findPluginRouteAccess, runRouteInWorker } = await import('../host/rpc')
    const route = findPluginRouteAccess(msg.pluginId, req.method, pathname)
    if (!route) {
      // Plugin registered the public-route prefix but never registered a
      // concrete handler for this exact path. Return 404 — the prefix is
      // matched but no handler claims it.
      return new Response('Plugin route not found', { status: 404 })
    }
    // Public routes are anonymous by definition (the permission system
    // already required `cms.publicRoutes` to register). Forward with a
    // null user.
    const response = await runRouteInWorker({
      pluginId: msg.pluginId,
      method: req.method,
      path: pathname,
      request: req,
      user: null,
    })
    return response
  }

  registerPluginPublicRoute(msg.pluginId, prefix, handler as never, { exclusive: exclusive !== false })
  replyApiOk(msg.pluginId, msg.correlationId)
}