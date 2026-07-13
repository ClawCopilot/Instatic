/**
 * Shared types for the HTTP routing layer.
 *
 * Lives in its own module so both `server/router.ts` (the dispatcher) and
 * `server/plugins/extensions/publicRoutes.ts` (the plugin public-route
 * registry) can import `RouteHandler` and `ServerRuntime` without forming a
 * circular dependency:
 *
 *   router.ts  ──▶ apiDispatch.ts  ──▶ extensions/publicRoutesProtocol.ts
 *       ▲                                              │
 *       │                                              ▼
 *       └──────── extensions/publicRoutes.ts  ◀────────┘
 *
 * If `RouteHandler` is declared in `router.ts`, the chain above closes into
 * a cycle the moment `publicRoutes.ts` needs the type. Hoisting it here
 * (and the runtime it takes) breaks the cycle at the source.
 *
 * `ServerRuntime` is hoisted for the same reason — `RouteHandler` references
 * it, and the dispatcher is the only place that originally owned it.
 */
import type { DbClient } from './db/client'

export interface ServerRuntime {
  db: DbClient
  staticDir?: string
  uploadsDir?: string
  /**
   * The raw `DATABASE_URL` the server booted with — forwarded down to
   * CMS handlers that need to resolve the on-disk SQLite file (e.g. the
   * storage dashboard widget).
   */
  databaseUrl?: string
}

/**
 * A route handler returns a `Response` if it owns the request, or `null` if
 * the URL/method doesn't match — the dispatcher walks the `routes` table and
 * returns the first non-null response. Prefix-namespaced handlers (e.g.
 * `/_instatic/css/`, `/_instatic/runtime/cache/`) absorb their entire namespace and emit
 * a 404 themselves rather than falling through, so unknown paths under a
 * known prefix can't accidentally match a later route.
 */
export type RouteHandler = (
  req: Request,
  runtime: ServerRuntime,
  url: URL,
  pathname: string,
) => Promise<Response | null> | Response | null
