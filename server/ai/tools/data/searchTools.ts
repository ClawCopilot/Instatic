/**
 * Search tools — server-resolved.
 *
 * One tool: `site_search`. Searches across ALL data rows in ALL tables,
 * matching against both slugs AND cell content (text fields inside
 * cells_json). Returns a ranked list of rows with their table context
 * and a relevance snippet.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import { listDataTablesWithCounts, listDataRows } from '../../../repositories/data'
import { readTitleCell } from '@core/data/cells'
import { dataRowVisibility } from '../../../auth/dataAccess'

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

const SEARCH_CAPS: readonly CoreCapability[] = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSearchableText(cells: Record<string, unknown>): string {
  const texts: string[] = []
  for (const value of Object.values(cells)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string') {
      texts.push(value)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      texts.push(String(value))
    } else if (typeof value === 'object') {
      // Skip media/relation objects — not searchable text
      if ('id' in value || 'rowId' in value) continue
      texts.push(JSON.stringify(value))
    }
  }
  return texts.join(' ').toLowerCase()
}

function snippet(text: string, query: string, maxLen = 120): string {
  const lower = text.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  if (idx < 0) {
    // Fallback: show beginning of text
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
  }
  const start = Math.max(0, idx - 30)
  const end = Math.min(text.length, idx + query.length + 60)
  let snip = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
  if (snip.length > maxLen) {
    snip = (start > 0 ? '…' : '') + text.slice(idx, Math.min(text.length, idx + maxLen))
  }
  return snip
}

// ---------------------------------------------------------------------------
// site_search
// ---------------------------------------------------------------------------

const SearchInput = Type.Object({
  query: Type.String({ minLength: 1 }),
  tableId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
})

interface SearchHit {
  rowId: string
  tableId: string
  tableName: string
  tableSlug: string
  tableKind: string
  title: string
  slug: string
  status: string
  snippet: string
  updatedAt: string
}

const searchTool: AiTool = {
  name: 'site_search',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: SEARCH_CAPS,
  description:
    'Full-text search across ALL data rows. Searches row slugs AND cell content (titles, body text, rich text, descriptions, etc.). `query` is the search term (matches substrings, case-insensitive). Optionally scope to one `tableId`. `limit` defaults to 25, max 100. Returns rows ranked by relevance with a text snippet showing the match context. Use to find content across the entire project — much broader than listing rows in a single table.',
  inputSchema: SearchInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof SearchInput>
    const limit = args.limit ?? 25

    // Discover all tables
    const tables = await listDataTablesWithCounts(ctx.db)
    const targetTables = args.tableId
      ? tables.filter((t) => t.id === args.tableId)
      : tables

    // Load all rows for target tables
    const allHits: SearchHit[] = []
    for (const table of targetTables) {
      // Skip tables with no rows
      if (table.rowCount === 0) continue

      const rows = await listDataRows(
        ctx.db,
        table.id,
        dataRowVisibility({ id: ctx.userId, capabilities: ctx.capabilities }),
      )
      for (const row of rows) {
        const title = readTitleCell(row.cells) || row.slug || row.id
        const searchText = `${row.slug} ${title} ${extractSearchableText(row.cells)}`
        if (searchText.includes(args.query.toLowerCase())) {
          allHits.push({
            rowId: row.id,
            tableId: table.id,
            tableName: table.name,
            tableSlug: table.slug,
            tableKind: table.kind,
            title,
            slug: row.slug,
            status: row.status,
            snippet: snippet(searchText, args.query),
            updatedAt: row.updatedAt,
          })
        }
      }
    }

    // Sort by relevance: exact title match > slug match > cell match
    const q = args.query.toLowerCase()
    allHits.sort((a, b) => {
      const aTitle = a.title.toLowerCase().includes(q) ? 0 : a.slug.toLowerCase().includes(q) ? 1 : 2
      const bTitle = b.title.toLowerCase().includes(q) ? 0 : b.slug.toLowerCase().includes(q) ? 1 : 2
      return aTitle - bTitle || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })

    const sliced = allHits.slice(0, limit)
    return {
      query: args.query,
      total: allHits.length,
      limit,
      hits: sliced,
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const searchTools: AiTool[] = [searchTool]
