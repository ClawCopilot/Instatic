/**
 * Plugin secrets handlers — implement the `cms.secrets.get` and
 * `cms.secrets.set` api-calls.
 *
 * Plugins use `api.secrets.get(key)` / `api.secrets.set(key, value)` to
 * store arbitrary encrypted key-value pairs (e.g. OIDC signing keys,
 * webhook secrets). These are separate from the manifest-declared secret
 * settings (which use the `plugin_secrets` table with `setting_id` keyed
 * to the manifest's settings definitions). The runtime secrets API uses
 * the SAME `plugin_secrets` table but with a `runtime:` prefix on the
 * setting_id to avoid collisions with manifest-declared settings.
 *
 * Encryption uses the same master-key-based AES-256-GCM as
 * `pluginSecrets.ts`. Gated by `cms.db` permission (enforced centrally
 * in apiDispatch.ts via TARGET_PERMISSIONS).
 */

import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiError, replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'
import {
  decryptSecret,
  encryptSecret,
} from '../../../secrets/encryption'
import {
  loadMasterKey,
  getMasterKeyFingerprint,
} from '../../../secrets/masterKey'

/**
 * Prefix for runtime secrets to distinguish them from manifest-declared
 * secret settings in the `plugin_secrets` table. This prevents a plugin
 * from accidentally overwriting a manifest-declared secret setting via
 * the runtime API.
 */
const RUNTIME_SECRET_PREFIX = 'runtime:'

function runtimeKey(key: string): string {
  return RUNTIME_SECRET_PREFIX + key
}

export async function handleSecretsGet(
  msg: ApiCallFor<'cms.secrets.get'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ key }] = msg.args
  const settingId = runtimeKey(key)

  try {
    const { rows } = await db<{ ciphertext: Uint8Array; iv: Uint8Array }>`
      select ciphertext, iv
      from plugin_secrets
      where plugin_id = ${msg.pluginId}
        and setting_id = ${settingId}
    `
    if (rows.length === 0) {
      replyApiOk(msg.pluginId, msg.correlationId, null)
      return
    }

    const masterKey = await loadMasterKey()
    const plaintext = await decryptSecret(masterKey, {
      ciphertext: rows[0].ciphertext,
      iv: rows[0].iv,
    })
    replyApiOk(msg.pluginId, msg.correlationId, plaintext)
  } catch (err) {
    replyApiError(
      msg.pluginId,
      msg.correlationId,
      err instanceof Error ? err.message : String(err),
    )
  }
}

export async function handleSecretsSet(
  msg: ApiCallFor<'cms.secrets.set'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ key, value }] = msg.args
  const settingId = runtimeKey(key)

  try {
    if (value === '') {
      // Empty string = delete (matching the manifest-secret sentinel semantics)
      await db`
        delete from plugin_secrets
        where plugin_id = ${msg.pluginId}
          and setting_id = ${settingId}
      `
      replyApiOk(msg.pluginId, msg.correlationId, undefined)
      return
    }

    const masterKey = await loadMasterKey()
    const { ciphertext, iv } = await encryptSecret(masterKey, value)
    const fingerprint = await getMasterKeyFingerprint()

    await db`
      insert into plugin_secrets (plugin_id, setting_id, ciphertext, iv, key_fingerprint)
      values (${msg.pluginId}, ${settingId}, ${ciphertext}, ${iv}, ${fingerprint})
      on conflict (plugin_id, setting_id) do update
        set ciphertext = excluded.ciphertext,
            iv = excluded.iv,
            key_fingerprint = excluded.key_fingerprint,
            updated_at = current_timestamp
    `
    replyApiOk(msg.pluginId, msg.correlationId, undefined)
  } catch (err) {
    replyApiError(
      msg.pluginId,
      msg.correlationId,
      err instanceof Error ? err.message : String(err),
    )
  }
}
