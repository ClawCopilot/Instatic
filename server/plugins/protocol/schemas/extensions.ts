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

/**
 * `cms.db.query` — plugin runs a parameterized SQL query against the host
 * database. Only SELECT / INSERT / UPDATE / DELETE are allowed; DDL
 * (DROP / ALTER / CREATE / TRUNCATE) is rejected and must go through a
 * migration. `sql` is bounded in length; `params` is an optional array
 * of primitive JSON values (string / number / boolean / null).
 */
export const DbQueryArgSchema = Type.Object({
  sql: Type.String({ minLength: 1, maxBytes: 1_000_000 }),
  params: Type.Optional(
    Type.Array(
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    ),
  ),
})

/**
 * `cms.viewerContext.register` — plugin registers a viewer-context provider.
 * The provider function lives INSIDE the VM; the host stores only the
 * pluginId so it can call back via __runViewerContextProvider.
 */
export const ViewerContextRegisterArgSchema = Type.Object({})

/**
 * `cms.contentGate.register` — plugin registers a content-gate function.
 * The gate function lives INSIDE the VM; the host stores only the pluginId
 * and priority so it can call back via __runContentGate.
 */
export const ContentGateRegisterArgSchema = Type.Object({
  priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
})

/**
 * `cms.secrets.get` — plugin reads a secret from the encrypted
 * `plugin_secrets` table. Returns the plaintext value (or null if absent).
 */
export const SecretsGetArgSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 200 }),
})

/**
 * `cms.secrets.set` — plugin writes (or clears, when value is empty) a
 * secret to the encrypted `plugin_secrets` table.
 */
export const SecretsSetArgSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 200 }),
  value: Type.String({ maxLength: 1_000_000 }),
})