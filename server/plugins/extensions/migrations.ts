/**
 * Plugin migration registry — the host-side bookkeeping that lets plugins
 * declare their own DB schema.
 *
 * Why this exists:
 *   The plugin sandbox runs in a QuickJS worker with no DDL privilege.
 *   A plugin that needs its own tables (api_keys, public_users,
 *   subscription_plans, oauth_clients, …) cannot run CREATE TABLE from
 *   inside the worker — the host owns the DB connection. This registry
 *   is the bridge: the plugin ships migration SQL to the host through
 *   the gated api.cms.migrations.register api-call, and the host runs
 *   the SQL during plugin install + on every boot as part of the
 *   standard migration pipeline.
 *
 * Security:
 *   - Migrations are scoped to the plugin id; cross-plugin migration
 *     registration is impossible (worker identity is host-verified).
 *   - Migration IDs must be namespaced (`<pluginId>.<name>`) so two
 *     plugins cannot collide.
 *   - Applied state is stored per-migration in `plugin_migrations`
 *     (added by core migration 020_plugin_migrations below). Re-runs
 *     are no-ops.
 *
 * Lifecycle:
 *   - `registerPluginMigration(pluginId, migration)` is called by the
 *     host-side api-call handler when a plugin calls
 *     `api.cms.migrations.register(...)`.
 *   - `runPluginMigrations(db, dialect)` is called by the boot path
 *     after the core migrations complete. It walks every registered
 *     migration, skips already-applied ones, and runs the rest inside
 *     the same transaction machinery as core migrations.
 *   - On plugin uninstall, the plugin's migration rows stay (we do
 *     NOT auto-drop tables — that would be a destructive data loss
 *     vector; the plugin uninstall flow opts in via a separate
 *     `dropSql` callback if needed).
 */

import type { DbClient } from '../../db/client'
import { runMigrations, type Migration } from '../../db/runMigrations'

export interface PluginMigration {
  /**
   * Globally-unique migration ID. Must include the plugin id to avoid
   * collisions across plugins (e.g. `api-keys.001_initial_schema`).
   */
  id: string
  /**
   * Raw SQL for the Postgres dialect. Both CREATE/ALTER/DML are
   * allowed; the runner wraps them in a transaction.
   */
  pgSql: string
  /**
   * Raw SQL for the SQLite dialect. Optional — if omitted, `pgSql`
   * is used for both. Set this when a migration needs dialect-
   * specific DDL (e.g. `text` vs `jsonb`, `blob` vs `bytea`).
   */
  sqliteSql?: string
}

interface RegisteredMigration {
  pluginId: string
  migration: PluginMigration
}

const registry = new Map<string, RegisteredMigration[]>()

/**
 * Idempotent register. Re-registering the same `(pluginId, migrationId)`
 * pair replaces the prior entry — useful when a plugin re-activates
 * after a settings change and re-runs `install()`.
 */
export function registerPluginMigration(
  pluginId: string,
  migration: PluginMigration,
): void {
  if (!migration.id.includes(pluginId)) {
    throw new Error(
      `[plugin:${pluginId}] migration id "${migration.id}" must include the plugin id to avoid collisions`,
    )
  }
  const existing = registry.get(pluginId) ?? []
  const filtered = existing.filter((m) => m.migration.id !== migration.id)
  filtered.push({ pluginId, migration })
  registry.set(pluginId, filtered)
}

/**
 * Drop every migration row owned by a plugin. Called when the plugin
 * is uninstalled (the table data is preserved on disk; this only
 * removes the in-process registry entries).
 */
export function unregisterPluginMigrations(pluginId: string): void {
  registry.delete(pluginId)
}

/**
 * Test-only / admin introspection. Returns a snapshot of every
 * registered migration keyed by plugin id.
 */
export function listPluginMigrations(): Record<string, PluginMigration[]> {
  const out: Record<string, PluginMigration[]> = {}
  for (const [pid, list] of registry) {
    out[pid] = list.map((e) => e.migration)
  }
  return out
}

/**
 * Adapter: convert the registered plugin migrations into the `Migration[]`
 * shape that `runMigrations` consumes, then run them. The dialect flag
 * selects between `pgSql` (the default) and `sqliteSql` (when provided).
 *
 * Plugin migrations run AFTER all core migrations, so a plugin can rely
 * on every core table (users, sessions, data_tables, etc.) existing when
 * its own migration executes.
 */
export async function runPluginMigrations(
  db: DbClient,
  dialect: 'pg' | 'sqlite',
): Promise<void> {
  const migrations: Migration[] = []
  for (const [pluginId, list] of registry) {
    for (const entry of list) {
      const sql = dialect === 'sqlite' && entry.migration.sqliteSql
        ? entry.migration.sqliteSql
        : entry.migration.pgSql
      migrations.push({
        id: `plugin:${pluginId}:${entry.migration.id}`,
        sql,
      })
    }
  }
  if (migrations.length === 0) return
  await runMigrations(db, migrations)
}