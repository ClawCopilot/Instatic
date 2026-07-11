/**
 * Content gate filter — lets a plugin block or modify the content
 * the public renderer is about to serve.
 *
 * Use cases:
 *   - Membership / paywall: a row tagged `members-only` returns
 *     `null` when the visitor isn't on an active subscription.
 *   - Geo-restriction: a row tagged `us-only` returns `null` when
 *     the visitor's IP geolocates outside the US.
 *   - Preview gating: a row tagged `draft-preview` returns `null`
 *     unless the visitor carries a valid preview token.
 *
 * How it works:
 *   1. The public renderer collects the candidate content row.
 *   2. Before serializing it into the HTML, it calls
 *      `applyContentGate(...)` with the row + request.
 *   3. Each registered gate returns one of:
 *        null              → keep the original row, continue to next gate
 *        { allow: true,
 *          modified?: Row } → accept the row (possibly modified)
 *        { allow: false,
 *          redirectTo?: string,
 *          status?: number } → block: redirect (default 302), or return
 *                              a different status (default 401/403)
 *
 *   4. The renderer applies the first blocking result. If no gate
 *      blocks, the (potentially modified) row is rendered.
 *
 * Security:
 *   Gates see the FULL row object, including the cells_json. Plugins
 *   must NOT mutate the row directly — return a `modified` shallow
 *   copy instead. The renderer treats the returned row as
 *   authoritative for THIS request only.
 *
 * Performance:
 *   Gates run on every public render. Keep them fast — no network
 *   calls, no expensive joins. If a gate needs a heavy lookup,
 *   cache the result keyed by row id + viewer id.
 */

import type { DbClient } from '../../db/client'

export interface ContentRowShape {
  id: string
  tableSlug: string
  cells: Record<string, unknown>
  slug: string
  status: string
  [k: string]: unknown
}

export type ContentGateDecision =
  | { kind: 'allow'; modified?: ContentRowShape }
  | { kind: 'block'; redirectTo?: string; status?: number; reason?: string }

export interface ContentGateArgs {
  db: DbClient
  req: Request
  url: URL
  pathname: string
  row: ContentRowShape
  viewer: Record<string, unknown>
}

export type ContentGate = (
  args: ContentGateArgs,
) => Promise<ContentGateDecision | null> | ContentGateDecision | null

interface GateEntry {
  pluginId: string
  gate: ContentGate
  /** Gates run in priority order, ASCENDING (lowest priority first). */
  priority: number
}

const gates: GateEntry[] = []

export function registerContentGate(
  pluginId: string,
  gate: ContentGate,
  priority = 100,
): void {
  const filtered = gates.filter((g) => g.pluginId !== pluginId)
  filtered.push({ pluginId, gate, priority })
  filtered.sort((a, b) => a.priority - b.priority)
  gates.length = 0
  gates.push(...filtered)
}

export function unregisterContentGate(pluginId: string): void {
  const filtered = gates.filter((g) => g.pluginId !== pluginId)
  gates.length = 0
  gates.push(...filtered)
}

/**
 * Walk the gate chain. Returns the first blocking decision (and stops),
 * or `{ kind: 'allow', modified }` with the most-modified row if every
 * gate passed, or `{ kind: 'allow' }` with the original row when no
 * gate touched it.
 */
export async function applyContentGate(
  args: ContentGateArgs,
): Promise<ContentGateDecision> {
  let current: ContentRowShape = args.row
  for (const entry of gates) {
    try {
      const decision = await entry.gate({ ...args, row: current })
      if (!decision) continue
      if (decision.kind === 'block') return decision
      if (decision.modified) current = decision.modified
    } catch (err) {
      console.error(`[plugin:${entry.pluginId}] content gate threw:`, err)
    }
  }
  return { kind: 'allow', modified: current !== args.row ? current : undefined }
}

export function listContentGates(): Array<{ pluginId: string; priority: number }> {
  return gates.map((g) => ({ pluginId: g.pluginId, priority: g.priority }))
}