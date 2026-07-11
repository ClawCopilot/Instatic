/**
 * Plugin public route registry — the host-side dispatcher that lets a
 * plugin own an HTTP path OUTSIDE the `/admin/api/cms/plugins/<id>/runtime/`
 * namespace.
 *
 * Why this exists:
 *   The built-in plugin route handler
 *   (`server/plugins/runtime.ts::handleServerPluginRuntimeRequest`)
 *   forces every plugin route to live under `/admin/api/cms/plugins/<id>/runtime/`,
 *   which puts the route behind the admin cookie. That's correct for
 *   admin-tooling endpoints, but it rules out the routes every public-
 *   facing plugin needs:
 *
 *     POST /oauth/authorize          (OIDC provider plugin)
 *     POST /oauth/token              (OIDC provider plugin)
 *     POST /api/auth/login           (public-auth plugin)
 *     POST /api/auth/register        (public-auth plugin)
 *     POST /api/webhooks/stripe      (commerce plugin)
 *
 *   This registry lets a plugin declare "I own path X" and lets the
 *   main `server/router.ts` dispatcher try those handlers before
 *   falling through to the public-render pipeline. Path ownership is
 *   exclusive: the FIRST plugin that registers a path wins, so a
 *   second plugin attempting to register the same path gets a clear
 *   error instead of a silent overlap.
 *
 * Auth model:
 *   Plugin public routes are anonymous by default — the plugin
 *   author writes whatever auth checks they need (Bearer token, JWT
 *   verification, signature validation, …). The host does NOT inject
 *   the admin session here; that's deliberate. A plugin that wants
 *   to gate its own route can use `cms.content.*`, a custom DB lookup,
 *   or the `cms.http.resolveApiKey` helper exposed below.
 */

import type { RouteHandler } from '../../router'

interface PublicRouteEntry {
  pluginId: string
  prefix: string
  handler: RouteHandler
}

const registered = new Map<string, PublicRouteEntry>()

/**
 * Register a route prefix for a plugin. The host dispatcher will try
 * the handler for ANY request whose pathname equals `prefix` OR starts
 * with `prefix + '/'`. Pass a stable identifier so duplicate-registration
 * errors are debuggable.
 *
 * Pass `exclusive: true` (default) to fail if another plugin already
 * owns the prefix. Set `false` to opt into "first match wins" chaining,
 * which is useful for middleware-like routes (e.g. a logging plugin
 * wanting to observe every request).
 */
export function registerPluginPublicRoute(
  pluginId: string,
  prefix: string,
  handler: RouteHandler,
  opts: { exclusive?: boolean } = {},
): void {
  const exclusive = opts.exclusive !== false
  const normalized = prefix.startsWith('/') ? prefix : `/${prefix}`
  const existing = registered.get(normalized)
  if (existing && existing.pluginId !== pluginId && exclusive) {
    throw new Error(
      `[plugin:${pluginId}] cannot register public route "${normalized}" — already owned by plugin "${existing.pluginId}"`,
    )
  }
  registered.set(normalized, { pluginId, prefix: normalized, handler })
}

export function unregisterPluginPublicRoutes(pluginId: string): void {
  for (const [prefix, entry] of registered) {
    if (entry.pluginId === pluginId) registered.delete(prefix)
  }
}

/**
 * Build a RouteHandler that walks every registered prefix in
 * REGISTRATION ORDER and invokes the first matching handler. Returns
 * `null` if no plugin owns the path so the dispatcher continues
 * walking its built-in routes.
 */
export function buildPluginPublicRoutesDispatcher(): RouteHandler {
  return async (req, runtime, url, pathname) => {
    for (const [, entry] of registered) {
      if (pathname === entry.prefix || pathname.startsWith(entry.prefix + '/')) {
        return await entry.handler(req, runtime, url, pathname)
      }
    }
    return null
  }
}

export function listPluginPublicRoutes(): Array<{ pluginId: string; prefix: string }> {
  return [...registered.values()].map((e) => ({ pluginId: e.pluginId, prefix: e.prefix }))
}