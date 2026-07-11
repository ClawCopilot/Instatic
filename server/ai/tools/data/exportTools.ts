/**
 * Export tools — server-resolved.
 *
 * One tool: `site_export_data`. Returns a structured JSON dump of all
 * tables, rows, and media assets in the project. Intended for AI
 * consumption (not a downloadable ZIP — the HTTP export endpoint handles
 * bundle downloads). Use this to snapshot the project state or prepare
 * for migration.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import { listDataTablesWithCounts, listDataRows } from '../../../repositories/data'
import { listMediaAssets } from '../../../repositories/media'
import { readTitleCell } from '@core/data/cells'

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

const EXPORT_CAPS: readonly CoreCapability[] = [
  'data.export',
  'content.manage',
]

// ---------------------------------------------------------------------------
// site_export_data
// ---------------------------------------------------------------------------

const ExportInput = Type.Object({
  tableId: Type.Optional(Type.String()),
  includeMedia: Type.Optional(Type.Boolean()),
  includeCells: Type.Optional(Type.Boolean()),
  limitRows: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
})

const exportTool: AiTool = {
  name: 'site_export_data',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: EXPORT_CAPS,
  description:
    'Export project data as structured JSON. Returns all tables with their rows and optionally media assets. `tableId` scopes to one table (omit for all). `includeMedia: true` adds a media asset list (default false). `includeCells: true` includes full cell data per row (default true to get complete data). `limitRows` caps total rows across all tables (default unlimited). Use for snapshot backups, data migration, or feeding content to an external system.',
  inputSchema: ExportInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof ExportInput>
    const includeMedia = args.includeMedia ?? false
    const includeCells = args.includeCells ?? true
    const maxRows = args.limitRows

    // Discover tables
    const allTables = await listDataTablesWithCounts(ctx.db)
    const tables = args.tableId
      ? allTables.filter((t) => t.id === args.tableId)
      : allTables

    // Export rows per table
    let totalRows = 0
    const tableExports = []

    for (const table of tables) {
      const rows = await listDataRows(ctx.db, table.id)
      const projectedRows = rows.slice(0, maxRows ? maxRows - totalRows : undefined).map((r) => {
        const base = {
          id: r.id,
          slug: r.slug,
          title: readTitleCell(r.cells) || r.slug || r.id,
          status: r.status,
          authorUserId: r.authorUserId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          publishedAt: r.publishedAt,
        }
        return includeCells ? { ...base, cells: r.cells } : base
      })

      totalRows += projectedRows.length
      tableExports.push({
        tableId: table.id,
        tableName: table.name,
        tableSlug: table.slug,
        kind: table.kind,
        routeBase: table.routeBase,
        rowCount: rows.length,
        exportedRows: projectedRows.length,
        rows: projectedRows,
      })

      if (maxRows && totalRows >= maxRows) break
    }

    // Media (optional)
    let mediaAssets: unknown[] | undefined
    if (includeMedia) {
      const assets = await listMediaAssets(ctx.db)
      mediaAssets = assets.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        publicPath: a.publicPath,
        altText: a.altText,
        caption: a.caption,
        tags: a.tags,
        width: a.width,
        height: a.height,
        folderIds: a.folderIds,
        createdAt: a.createdAt,
      }))
    }

    return {
      exportedAt: new Date().toISOString(),
      tables: tableExports,
      totalTables: tableExports.length,
      totalRows,
      ...(mediaAssets ? { mediaAssets } : {}),
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const exportTools: AiTool[] = [exportTool]
