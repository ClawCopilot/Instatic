/**
 * HTTP middleware registry — lets a plugin inject a request-pipeline
 * hook that runs BEFORE the main router dispatches to a route handler.
 *
 * Use cases:
 *   - API key authentication (api-keys plugin): the middleware reads
 *     `Authorization: Bearer <token>`, resolves the key against its own
 *     table, and attaches the resolved key to a per-request context.
 *   - Rate limiting (rate-limit plugin): the middleware tracks request
 *     counts per IP and 429s when a threshold is exceeded.
 *   - Request logging (observability plugin): the middleware records
 *     every request + response status for later analysis.
 *
 * Security model:
 *   - Middleware handlers run in the host process, NOT in the plugin
 *     sandbox. This is deliberate: middleware needs to short-circuit
 *     the pipeline with its own Response (e.g. 401 for an invalid
 *     API key), and a sandbox-side handler can't do that without an
 *     extra RPC round-trip per request.
 *   - The middleware signature is `(req, runtime) => Response | null`.
 *     Returning a non-null Response ends the pipeline immediately;
 *     returning null passes the request to the next middleware, and
 *     eventually to the router.
 *   - Plugin-supplied middleware is sandboxed at the same level as
 *     the rest of the plugin code. It cannot read env vars, the
 *     filesystem, or other plugins' state.
 *
 * Execution order:
 *   - Middlewares run in REGISTRATION ORDER, oldest first. This makes
 *     the order deterministic for operators inspecting the install list.
 *   - If middleware A registers before middleware B, A sees the
 *     request before B. If both want to gate the same path, A wins.
 */

import type { DbClient } from '../../db/client'

export interface HttpMiddlewareContext {
  db: DbClient
  uploadsDir?: string
  databaseUrl?: string
  /** Mutable per-request scratch space. Middleware can stash resolved
   *  auth context here so downstream handlers can read it without
   *  re-running the lookup. */
  state: Record<string, unknown>
}

export type HttpMiddleware = (
  req: Request,
  ctx: HttpMiddlewareContext,
) => Promise<Response | null> | Response | null

interface MiddlewareEntry {
  pluginId: string
  middleware: HttpMiddleware
}

const middlewares: MiddlewareEntry[] = []

export function registerPluginHttpMiddleware(
  pluginId: string,
  middleware: HttpMiddleware,
): void {
  // Idempotent re-register (re-activation). Drop any prior entry from
  // this plugin first so the ordering is "most recent at the end".
  const filtered = middlewares.filter((m) => m.pluginId !== pluginId)
  filtered.push({ pluginId, middleware })
  middlewares.length = 0
  middlewares.push(...filtered)
}

export function unregisterPluginHttpMiddleware(pluginId: string): void {
  const filtered = middlewares.filter((m) => m.pluginId !== pluginId)
  middlewares.length = 0
  middlewares.push(...filtered)
}

/**
 * Run the entire middleware chain. Returns the first non-null Response
 * (which short-circuits the chain), or `null` to fall through to the
 * router. Each middleware receives a fresh `state` object so plugins
 * can stash resolved auth without polluting other middleware state.
 *
 * `ctx.state` is shared across middlewares in the chain so a
 * "request-id" middleware can leave a value that a downstream
 * "rate-limit" middleware can read.
 */
export async function runPluginHttpMiddleware(
  req: Request,
  ctx: Omit<HttpMiddlewareContext, 'state'>,
): Promise<Response | null> {
  const state: Record<string, unknown> = {}
  for (const entry of middlewares) {
    const response = await entry.middleware(req, { ...ctx, state })
    if (response) return response
  }
  return null
}

/**
 * Read a value stashed by upstream middleware. Plugin handlers (e.g.
 * an authenticated route inside the same plugin) can call this to
 * recover the resolved identity without re-running the lookup.
 *
 *     const resolved = readMiddlewareState<ResolvedApiKey>(ctx.state, 'apiKey')
 *     if (!resolved) return new Response('Unauthorized', { status: 401 })
 */
export function readMiddlewareState<T>(state: Record<string, unknown>, key: string): T | undefined {
  return state[key] as T | undefined
}