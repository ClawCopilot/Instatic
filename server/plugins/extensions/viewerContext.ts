/**
 * Viewer context hook — lets a plugin enrich the data context that
 * the template renderer binds into a published page.
 *
 * Why this exists:
 *   Templates today bind `site`, `page`, and the loop iteration item
 *   (`entry`, `data`, etc.) into the render context, but there is no
 *   notion of "who is viewing this page". A membership plugin needs
 *   `viewer.tier = 'gold'` and `viewer.expiresAt = 1234…` available
 *   inside the template so a `{{#if viewer.tier == 'gold'}}` block
 *   can gate member-only content.
 *
 * How it works:
 *   1. The public renderer (server/publish/publicRouter.ts) collects
 *      the current request + DB and calls `resolveViewerContext(...)`
 *      on every render.
 *   2. `resolveViewerContext` walks every registered provider in
 *      registration order and merges its returned object into a
 *      single `viewer` map.
 *   3. The renderer's data context gains a new top-level `viewer`
 *      key the template engine binds as a regular object — templates
 *      access it via `{{ viewer.tier }}`, `{{#if viewer.loggedIn}}`,
 *      etc.
 *
 * Provider signature:
 *   Each provider receives `{ db, req, url, pathname }` and returns a
 *   partial viewer object. Returning `null` or `{}` is a no-op (the
 *   plugin isn't interested in this request). Providers must NOT
 *   throw; an error is logged and the provider is skipped.
 *
 * Security:
 *   The viewer object is part of the SSR-rendered HTML. Plugins
 *   should NEVER include secrets, raw auth tokens, or PII they don't
 *   want exposed to the page. The host does not redact provider
 *   output — that responsibility sits with the plugin author.
 */

import type { DbClient } from '../../db/client'

export interface ViewerContextProviderArgs {
  db: DbClient
  req: Request
  url: URL
  pathname: string
}

export type ViewerContextProvider = (
  args: ViewerContextProviderArgs,
) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null

interface ProviderEntry {
  pluginId: string
  provider: ViewerContextProvider
}

const providers: ProviderEntry[] = []

export function registerViewerContextProvider(
  pluginId: string,
  provider: ViewerContextProvider,
): void {
  const filtered = providers.filter((p) => p.pluginId !== pluginId)
  filtered.push({ pluginId, provider })
  providers.length = 0
  providers.push(...filtered)
}

export function unregisterViewerContextProvider(pluginId: string): void {
  const filtered = providers.filter((p) => p.pluginId !== pluginId)
  providers.length = 0
  providers.push(...filtered)
}

/**
 * Resolve the merged viewer context for a request. Providers run in
 * registration order; each one's returned keys are merged into the
 * accumulator (later providers win on key conflict). An error in one
 * provider is logged and skipped — the chain continues.
 */
export async function resolveViewerContext(
  args: ViewerContextProviderArgs,
): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {}
  for (const entry of providers) {
    try {
      const partial = await entry.provider(args)
      if (partial && typeof partial === 'object') {
        Object.assign(merged, partial)
      }
    } catch (err) {
      console.error(`[plugin:${entry.pluginId}] viewer context provider threw:`, err)
    }
  }
  return merged
}

/**
 * Test-only introspection.
 */
export function listViewerContextProviders(): Array<{ pluginId: string }> {
  return providers.map((p) => ({ pluginId: p.pluginId }))
}