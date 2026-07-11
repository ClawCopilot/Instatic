/**
 * Content health check tool — server-resolved, data-scope.
 *
 * `content_health_check` scans the project for common content issues:
 *   - Stale drafts (not updated in N days)
 *   - Unpublished documents older than a threshold
 *   - Documents missing required fields
 *   - Empty collections
 *
 * The report is actionable — every issue carries the document id, table id,
 * and slug so the agent can fix it immediately via content tools.
 *
 * This tool is designed to be called:
 *   • On-demand by the AI (user asks "check content health")
 *   • Via webhook from an external cron service (scheduled health reports)
 *   • From a future built-in scheduler tick
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import {
  listDataTablesWithCounts,
  listDataRows,
} from '../../../repositories/data'
import { normalizeDataTableFields } from '@core/data/fields'
import type { DataField } from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

const HEALTH_CHECK_CAPS: readonly CoreCapability[] = [
  'content.edit.any',
  'content.publish.any',
  'content.manage',
]

// ---------------------------------------------------------------------------
// Configurable thresholds
// ---------------------------------------------------------------------------

/** Drafts not updated in this many days are considered stale. */
const STALE_DRAFT_DAYS = 14

/** Unpublished docs older than this many days are flagged. */
const STALE_UNPUBLISHED_DAYS = 30

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const HealthCheckInput = Type.Object({
  staleDraftDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  staleUnpublishedDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
})

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const HealthIssue = Type.Object({
  kind: Type.String(),
  tableId: Type.String(),
  tableSlug: Type.String(),
  documentId: Type.String(),
  title: Type.String(),
  slug: Type.String(),
  detail: Type.String(),
})

const healthCheckTool: AiTool = {
  name: 'content_health_check',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: HEALTH_CHECK_CAPS,
  description:
    `Scan the entire project for content health issues. Returns a structured report with: stale drafts (not updated in ${STALE_DRAFT_DAYS} days), long-unpublished documents (unpublished for ${STALE_UNPUBLISHED_DAYS}+ days), documents missing required fields, and empty collections. Every issue includes document id and slug so the agent can fix them with content tools. Call on-demand or schedule via webhook.`,
  inputSchema: HealthCheckInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof HealthCheckInput>
    const staleDraftDays = args.staleDraftDays ?? STALE_DRAFT_DAYS
    const staleUnpublishedDays = args.staleUnpublishedDays ?? STALE_UNPUBLISHED_DAYS

    const tables = await listDataTablesWithCounts(ctx.db)
    const contentTables = tables.filter((t) => t.kind === 'postType' || t.kind === 'page')

    const issues: Array<{
      kind: string
      tableId: string
      tableSlug: string
      documentId: string
      title: string
      slug: string
      detail: string
    }> = []

    const now = Date.now()
    const staleDraftCutoff = now - staleDraftDays * 24 * 60 * 60 * 1000
    const staleUnpublishedCutoff = now - staleUnpublishedDays * 24 * 60 * 60 * 1000

    // Counters for summary
    let staleDraftsCount = 0
    let unpublishedStaleCount = 0
    let missingFieldsCount = 0
    let emptyCollectionsCount = 0

    for (const table of contentTables) {
      // Empty collection check
      if (table.rowCount === 0) {
        emptyCollectionsCount++
        issues.push({
          kind: 'empty_collection',
          tableId: table.id,
          tableSlug: table.slug,
          documentId: '',
          title: table.name,
          slug: table.slug,
          detail: `Collection "${table.pluralLabel || table.name}" has no documents.`,
        })
        continue
      }

      const rows = await listDataRows(ctx.db, table.id)
      const fields = normalizeDataTableFields(table.fields)
      const requiredFields = fields.filter((f) => f.required)

      for (const row of rows) {
        const rowTitle = readTitleFromCells(row.cells, row.slug)
        const updatedAt = new Date(row.updatedAt).getTime()

        // Stale draft check
        if (row.status === 'draft' && updatedAt < staleDraftCutoff) {
          staleDraftsCount++
          const ageDays = Math.round((now - updatedAt) / (24 * 60 * 60 * 1000))
          issues.push({
            kind: 'stale_draft',
            tableId: table.id,
            tableSlug: table.slug,
            documentId: row.id,
            title: rowTitle,
            slug: row.slug,
            detail: `Draft last updated ${ageDays} days ago (status: ${row.status}).`,
          })
        }

        // Unpublished staleness
        if (row.status === 'unpublished' && updatedAt < staleUnpublishedCutoff) {
          unpublishedStaleCount++
          const ageDays = Math.round((now - updatedAt) / (24 * 60 * 60 * 1000))
          issues.push({
            kind: 'unpublished_stale',
            tableId: table.id,
            tableSlug: table.slug,
            documentId: row.id,
            title: rowTitle,
            slug: row.slug,
            detail: `Unpublished for ${ageDays} days. Consider publishing or deleting.`,
          })
        }

        // Missing required fields (only for non-deleted rows)
        if (requiredFields.length > 0) {
          const cells = row.cells as Record<string, unknown>
          const missing = requiredFields.filter((f) => {
            const val = cells[f.id]
            return val === null || val === undefined || val === ''
          })
          if (missing.length > 0) {
            missingFieldsCount++
            const fieldNames = missing.map((f) => f.label || f.id).join(', ')
            issues.push({
              kind: 'missing_required_fields',
              tableId: table.id,
              tableSlug: table.slug,
              documentId: row.id,
              title: rowTitle,
              slug: row.slug,
              detail: `Missing required fields: ${fieldNames}.`,
            })
          }
        }
      }
    }

    return {
      summary: {
        totalIssues: issues.length,
        staleDrafts: staleDraftsCount,
        unpublishedStale: unpublishedStaleCount,
        missingRequiredFields: missingFieldsCount,
        emptyCollections: emptyCollectionsCount,
      },
      thresholds: {
        staleDraftDays,
        staleUnpublishedDays,
      },
      issues,
      // Suggestion for the AI: tells it what to do next
      suggestion:
        issues.length === 0
          ? 'Content is healthy — no issues found.'
          : `Found ${issues.length} issue(s). Use content tools to fix them: stale drafts → delete or publish; empty collections → create content or delete; missing fields → content_set_document_field.`,
    }
  },
}

// ---------------------------------------------------------------------------
// Title extraction helper
// ---------------------------------------------------------------------------

function readTitleFromCells(cells: unknown, fallback: string): string {
  if (typeof cells !== 'object' || cells === null) return fallback
  const c = cells as Record<string, unknown>
  if (typeof c.title === 'string' && c.title.length > 0) return c.title
  if (typeof c.slug === 'string' && c.slug.length > 0) return c.slug
  return fallback
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const healthTools: AiTool[] = [healthCheckTool]
