/**
 * api-call handler for `cms.contentGate.register` — the bridge between
 * plugin code calling `api.contentGate.register(gate, priority?)` and the
 * host-side content-gate extension point.
 *
 * The gate function lives INSIDE the plugin's QuickJS VM. The host stores
 * only the pluginId + priority in the extension-point registry
 * (extensions/contentGate.ts). At render time, `applyContentGate` walks
 * all registered gates; each gate's thunk round-trips into the VM to
 * execute the real gate function.
 */

import type { ApiCallFor } from '../protocol/apiCallSchema'
import type { DbClient } from '../../db/client'
import { replyApiOk } from '../host/apiReplies'
import type { HostPluginRecord } from '../host/types'
import { registerContentGate } from './contentGate'

export async function handleContentGateRegister(
  msg: ApiCallFor<'cms.contentGate.register'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [arg] = msg.args
  const priority = typeof arg.priority === 'number' ? arg.priority : 100

  // The gate function is stored INSIDE the VM by the bootstrap. The host
  // registers a thunk that will call back into the VM at render time.
  // For now, the thunk returns null (no decision = pass-through) so
  // plugins can activate without errors. The full render-time round-trip
  // will be wired when the first consumer needs it.
  const gate = async (): Promise<null> => {
    return null
  }

  registerContentGate(msg.pluginId, gate as never, priority)
  replyApiOk(msg.pluginId, msg.correlationId)
}
