/**
 * Tool registry root — selects the right toolset for a chat scope.
 *
 * Scopes: `site`, `content`, `data` (static toolsets) and `plugin`
 * (dynamic — built from installed skill plugins at boot/reload time).
 *
 * Adding a new scope:
 *   1. Create `server/ai/tools/<scope>/` with its tool files + index.ts.
 *   2. Import its barrel here.
 *   3. Add a switch arm in `scopeToolset`.
 *   4. The `ai-tools-typebox-only.test.ts` gate ensures every file under
 *      `server/ai/tools/**` uses TypeBox (not Zod) — covered automatically.
 *
 * Plugin scope 的工具来自已安装的 skill 插件，通过 `initPluginToolCache`
 * 在服务器启动时（`activateInstalledServerPlugins`）从 DB 异步加载并缓存。
 * `scopeToolset('plugin')` 同步读取缓存，避免在请求热路径上执行 DB 查询。
 *
 * Capability filtering: `selectToolsForScope` takes the caller's capability
 * set and filters through `toolAllowedForCapabilities` — write tools need
 * `ai.tools.write`, and any tool declaring `requiredCapabilities` (ANY-OF,
 * mirroring its HTTP-route equivalent) is only offered to callers holding
 * one. A `ai.chat`-only user (e.g. a Client persona granted chat) cannot
 * have the model issue a call the user couldn't make over HTTP — gated
 * tools are never registered with the driver in the first place.
 */

import type { CoreCapability } from '../../auth/capabilities'
import { toolAllowedForCapabilities } from './capabilityGate'
import type { AiTool, ToolScope } from './types'
import { siteTools } from './site'
import { contentTools } from './content'
import { dataTools } from './data'
import { getPluginTools } from './plugin'

function scopeToolset(scope: ToolScope): AiTool[] {
  switch (scope) {
    case 'site':
      return siteTools
    case 'content':
      return contentTools
    case 'data':
      return dataTools
    case 'plugin':
      // 从缓存读取 skill 插件的工具，缓存由 initPluginToolCache 在启动时填充
      return getPluginTools()
  }
}

/**
 * Returns the tools available for one chat scope, filtered against the
 * caller's capability set. The runtime hands this array to the driver
 * verbatim; drivers translate each `AiTool.inputSchema` (TypeBox) into
 * the provider-native tool format.
 *
 * Filtering (see `toolAllowedForCapabilities`, the single gate):
 *   - a caller without `ai.tools.write` does not see tools tagged
 *     `mutates: true`;
 *   - a tool with `requiredCapabilities` (ANY-OF) is only offered to
 *     callers holding at least one of them — the agent inherits the
 *     caller's capabilities by construction instead of `ai.chat` acting
 *     as a blanket read grant.
 */
export function selectToolsForScope(
  scope: ToolScope,
  capabilities: readonly CoreCapability[],
): AiTool[] {
  return scopeToolset(scope).filter((t) => toolAllowedForCapabilities(t, capabilities))
}
