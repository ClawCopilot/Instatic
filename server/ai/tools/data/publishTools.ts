/**
 * Publish-scope tools — server-resolved.
 *
 * Three tools: one to check publish status (draft vs published comparison),
 * one to trigger a full-site publish, and one to publish a single row.
 * The publish pipeline bundles runtime scripts, renders pages, bakes
 * static HTML/CSS/JS artefacts, and swaps the live slot.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import { getDraftPublishStatus } from '../../../repositories/publish'
import { publishDraftSite } from '../../../publish/publishSite'
import { publishDataRow } from '../../../publish/publishRow'

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

// Publish — mirrors the HTTP publish gate.
const PUBLISH_CAPS: readonly CoreCapability[] = [
  'content.publish.own',
  'content.publish.any',
  'content.manage',
]

// ---------------------------------------------------------------------------
// site_publish_status
// ---------------------------------------------------------------------------

const publishStatusTool: AiTool = {
  name: 'site_publish_status',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: PUBLISH_CAPS,
  description:
    'Compare the current draft against the last published version. Returns hasPublishedVersion, draftMatchesPublished (true means nothing to publish), draftPages, publishedPages, and lastPublishedAt (ISO timestamp). Use before calling site_publish to confirm there is new content to publish.',
  inputSchema: Type.Object({}),
  handler: async (_input, ctx) => {
    const status = await getDraftPublishStatus(ctx.db)
    return { status }
  },
}

// ---------------------------------------------------------------------------
// site_publish
// ---------------------------------------------------------------------------

const PublishInput = Type.Object({
  /** Required: user must confirm they want to publish. */
  confirm: Type.Literal(true),
})

const publishTool: AiTool = {
  name: 'site_publish',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: PUBLISH_CAPS,
  description:
    'Publish the ENTIRE draft site. This triggers the full pipeline: bundles runtime scripts, renders every page, bakes static HTML/CSS/JS artefacts to disk, and swaps the live slot atomically. ALL draft pages become published — this is NOT a selective publish. Requires `confirm: true`. Call site_publish_status first to preview what will change. Returns publishedPages count on success.',
  inputSchema: PublishInput,
  handler: async (_input, ctx) => {
    try {
      const result = await publishDraftSite(ctx.db, ctx.userId)
      return {
        ok: true,
        publishedPages: result.publishedPages,
        message: `Published ${result.publishedPages} page(s). The site is now live.`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Publish failed: ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// data_publish_row
// ---------------------------------------------------------------------------

const PublishRowInput = Type.Object({
  rowId: Type.String({ minLength: 1 }),
})

const publishRowTool: AiTool = {
  name: 'data_publish_row',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: PUBLISH_CAPS,
  description:
    'Publish ONE specific row. Runs the full incremental publish pipeline: persists the published version in the database, bakes a static HTML artefact to disk, updates the slug route if the slug changed (removes old artefact), and bumps the publish version to invalidate the render cache. Use after editing individual rows to publish selectively — faster than a full site_publish.',
  inputSchema: PublishRowInput,
  handler: async (input, ctx) => {
    const { rowId } = input as Static<typeof PublishRowInput>
    try {
      const result = await publishDataRow(ctx.db, rowId, ctx.userId, ctx.uploadsDir)
      return {
        ok: true,
        row: {
          id: result.row.id,
          tableId: result.row.tableId,
          slug: result.row.slug,
          status: result.row.status,
        },
        version: result.version,
        message: `Published row "${result.row.slug}". Version ${result.version.id}.`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Publish row failed: ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const publishTools: AiTool[] = [
  publishStatusTool,
  publishTool,
  publishRowTool,
]
