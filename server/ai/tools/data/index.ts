/**
 * Data-scope tool barrel — exports the toolset and system-prompt builder.
 *
 * The chat handler imports `dataTools` for `scope === 'data'` and
 * `buildDataSystemPrompt` when assembling the prompt for a data-scope
 * conversation.
 */

import type { AiTool } from '../types'
import { dataReadTools } from './readTools'
import { dataWriteTools } from './writeTools'
import { mediaTools } from './mediaTools'
import { publishTools } from './publishTools'
import { batchTools } from './batchTools'
import { adminTools } from './adminTools'
import { uploadTools } from './uploadTools'
import { importTools } from './importTools'
import { exportTools } from './exportTools'
import { searchTools } from './searchTools'
import { webhookTools } from './webhookTools'
import { healthTools } from './healthTools'

// Read-only tool names for mutates flag assignment
const READ_ONLY = new Set([
  'media_list', 'media_get', 'media_list_folders',
  'site_publish_status', 'site_export_data',
  'site_search',
  'admin_list_users', 'admin_get_user', 'admin_list_roles',
  'webhook_list', 'webhook_get',
  'content_health_check',
])

// Stamp the `mutates` flag so `selectToolsForScope` can filter write tools
// out for callers without `ai.tools.write`. Read tools default to false.
export const dataTools: AiTool[] = [
  // Read-only tools
  ...dataReadTools.map((t) => ({ ...t, mutates: false })),
  // Media tools
  ...mediaTools.map((t) => ({ ...t, mutates: !READ_ONLY.has(t.name) })),
  // Upload tool (always writes to disk + DB)
  ...uploadTools.map((t) => ({ ...t, mutates: true })),
  // Publish tools
  ...publishTools.map((t) => ({ ...t, mutates: !READ_ONLY.has(t.name) })),
  // Data write + batch + import tools
  ...dataWriteTools.map((t) => ({ ...t, mutates: true })),
  ...batchTools.map((t) => ({ ...t, mutates: true })),
  ...importTools.map((t) => ({ ...t, mutates: true })),
  // Export tools (site_export_data is read-only)
  ...exportTools.map((t) => ({ ...t, mutates: false })),
  // Search tools (read-only)
  ...searchTools.map((t) => ({ ...t, mutates: false })),
  // Admin tools
  ...adminTools.map((t) => ({ ...t, mutates: !READ_ONLY.has(t.name) })),
  // Webhook tools
  ...webhookTools.map((t) => ({ ...t, mutates: !READ_ONLY.has(t.name) })),
  // Health check tools
  ...healthTools.map((t) => ({ ...t, mutates: !READ_ONLY.has(t.name) })),
]

export { buildDataSystemPrompt } from './systemPrompt'
