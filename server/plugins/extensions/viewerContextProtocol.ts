/**
 * api-call handler for `cms.viewerContext.register` — the bridge between
 * plugin code calling `api.viewerContext.register(provider)` and the
 * host-side viewer-context extension point.
 *
 * The provider function lives INSIDE the plugin's QuickJS VM. The host
 * stores only the pluginId in the extension-point registry
 * (extensions/viewerContext.ts). At render time, `resolveViewerContext`
 * walks all registered providers; each provider's thunk round-trips into
 * the VM via `runHookFilterInWorker` to execute the real provider.
 */

import type { ApiCallFor } from '../protocol/apiCallSchema'
import type { DbClient } from '../../db/client'
import { replyApiOk } from '../host/apiReplies'
import type { HostPluginRecord } from '../host/types'
import { registerViewerContextProvider } from './viewerContext'

export async function handleViewerContextRegister(
  msg: ApiCallFor<'cms.viewerContext.register'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  // The provider function is stored INSIDE the VM by the bootstrap. The
  // host registers a thunk that will call back into the VM at render time.
  // For now, the thunk returns null — the viewer context from this plugin
  // will be empty until the full render-time round-trip is wired. This
  // allows plugins to activate without errors.
  const thunk = async (): Promise<Record<string, unknown> | null> => {
    return null
  }

  registerViewerContextProvider(msg.pluginId, thunk as never)
  replyApiOk(msg.pluginId, msg.correlationId)
}
