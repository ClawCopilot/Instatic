/**
 * api-call handler for `cms.migrations.register` — the gated bridge
 * that lets a plugin declare DB migrations from inside its worker.
 *
 * Permission gating: `cms.migrations` is enforced centrally in
 * `apiDispatch.ts` via TARGET_PERMISSIONS. This handler is only
 * reached when the plugin holds that permission.
 *
 * Payload validation: the `id`, `pgSql`, and `sqliteSql` strings are
 * validated by TypeBox at the wire boundary; nothing here trusts
 * plugin-supplied shapes.
 *
 * What we DO NOT do here:
 *   - Run the SQL. The host runs migrations once during boot, not
 *     per-register-call. Registering is just enqueueing — the next
 *     `runPluginMigrations()` call picks it up.
 *   - Track applied state. The `plugin_migrations` table (added by
 *     core migration 020 below) is the source of truth for "has this
 *     migration already been applied?".
 */

import type { ApiCallFor } from '../protocol/apiCallSchema'
import type { DbClient } from '../../db/client'
import type { HostPluginRecord } from '../host/types'
import { replyApiOk } from '../host/apiReplies'
import {
  registerPluginMigration,
  type PluginMigration,
} from './migrations'

export async function handleMigrationsRegister(
  msg: ApiCallFor<'cms.migrations.register'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ id, pgSql, sqliteSql }] = msg.args

  const migration: PluginMigration = {
    id,
    pgSql,
    ...(sqliteSql !== undefined ? { sqliteSql } : {}),
  }

  registerPluginMigration(msg.pluginId, migration)
  replyApiOk(msg.pluginId, msg.correlationId)
}