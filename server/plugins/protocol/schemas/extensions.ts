/**
 * TypeBox schemas for the extension-point api-calls. Each schema is the
 * wire-level shape the host validates against before the handler runs.
 *
 * Mirrors the `cms.migrations.register` / `cms.publicRoutes.register` /
 * `cms.httpMiddleware.register` handlers in
 * `server/plugins/extensions/*Protocol.ts`.
 *
 * SQL strings are validated at the boundary for type only (string with
 * bounded length) — the host runs the SQL through the standard migration
 * pipeline where the DB-level constraints enforce actual shape. We do
 * NOT parse the SQL here because doing so correctly (Postgres + SQLite
 * dialects) would re-implement half of a database engine.
 */

import { Type } from '@sinclair/typebox'

/**
 * `cms.migrations.register` — plugin declares a DB migration.
 * `pgSql` is required; `sqliteSql` is optional (falls back to `pgSql`).
 * `id` MUST include the plugin id (e.g. `api-keys.001_initial_schema`).
 */
export const MigrationsRegisterArgSchema = Type.Object({
  id: Type.String({ minLength: 3, maxLength: 200 }),
  pgSql: Type.String({ minLength: 1, maxBytes: 1_000_000 }),
  sqliteSql: Type.Optional(Type.String({ minLength: 1, maxBytes: 1_000_000 })),
})

/**
 * `cms.publicRoutes.register` — plugin claims ownership of an HTTP path.
 * The first plugin to register a path wins; a second plugin attempting
 * to claim the same prefix throws at install time.
 */
export const PublicRoutesRegisterArgSchema = Type.Object({
  prefix: Type.String({ minLength: 1, maxLength: 200, pattern: '^/' }),
  exclusive: Type.Optional(Type.Boolean()),
})

/**
 * `cms.httpMiddleware.register` — plugin installs a request middleware.
 * No args (the host stashes a thunk that round-trips into the worker
 * at request time, identical to the existing plugin RPC pattern).
 */
export const HttpMiddlewareRegisterArgSchema = Type.Object({})