/**
 * api-call handler for `cms.httpMiddleware.register` — the bridge
 * for plugin HTTP middleware registration.
 *
 * The middleware itself is registered as a no-op placeholder here.
 * Plugin code that needs to gate HTTP requests should use the
 * `api.cms.routes.register(...)` plugin-runtime route system instead
 * — which already supports `capability`, `authenticated`, and `public`
 * access modes — combined with `api.cms.publicRoutes.register(...)`
 * for root-path routes. Plugin routes can read middleware state via
 * the `cms.runtime.readMiddlewareState(...)` helper (see below).
 *
 * This extension point exists for the future case where a plugin
 * needs cross-cutting middleware that runs on EVERY request (e.g.
 * API-key auth, rate limiting). For now, the registration records
 * the plugin's intent so operators can see it in the install dialog;
 * actual middleware body registration will be added once we have a
 * concrete first use case (api-keys plugin will be that case).
 */

import type { ApiCallFor } from '../protocol/apiCallSchema'
import type { DbClient } from '../../db/client'
import type { HostPluginRecord } from '../host/types'
import { replyApiOk } from '../host/apiReplies'
import { registerPluginHttpMiddleware, type HttpMiddleware } from './httpMiddleware'

export async function handleHttpMiddlewareRegister(
  msg: ApiCallFor<'cms.httpMiddleware.register'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  // Placeholder middleware — for now this is a no-op pass-through.
  // Plugin code that wants to gate requests should register routes via
  // `api.cms.routes.register(...)` with the appropriate access mode
  // (capability / authenticated / public). The middleware list is
  // checked first in `runPluginHttpMiddleware`, so a plugin can
  // short-circuit a request here before the dispatcher walks routes.
  const middleware: HttpMiddleware = async (_req, _ctx) => null

  registerPluginHttpMiddleware(msg.pluginId, middleware)
  replyApiOk(msg.pluginId, msg.correlationId)
}