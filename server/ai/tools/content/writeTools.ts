/**
 * Content-scope write tools — hybrid server-direct + browser-bridged.
 *
 * Six data-mutating tools are now **server-direct**: the handler writes to
 * the database through the data repository and pushes a refreshed
 * ContentSnapshot via `ctx.onSnapshot`. The AI model's next tool call sees
 * post-mutation state without a browser round-trip.
 *
 * Two UI-navigation tools (`content_set_active_document`,
 * `content_set_active_collection`) remain **browser-bridged** — they only
 * change the user's view (scroll, tab, sidebar focus) and have no DB
 * side-effect.
 *
 * Why server-direct now:
 *   • Headless / CLI AI workflows work without a browser open.
 *   • No 90 s browser-tool timeout (was flaky under load).
 *   • Direct DB write is faster (one insert vs. request → bridge → response).
 *   • The browser reloads its editor state on the next "send" by re-reading
 *     the snapshot suffix — muted for pure-server mutations.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool, ToolContext } from '../types'
import type { ContentSnapshot } from './snapshot'
import { buildContentSnapshotFromDb } from './snapshotBuilder'
import { nanoid } from 'nanoid'
import {
  createDataRow,
  saveDataRowDraft,
  softDeleteDataRow,
  updateDataRowStatus,
  updateDataRowAuthor,
  scheduleDataRowPublish,
  getDataRow,
} from '../../../repositories/data'
import { publishDataRow } from '../../../publish/publishRow'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FieldsRecord = Type.Record(Type.String(), Type.Unknown())

const DocumentStatus = Type.Union([
  Type.Literal('draft'),
  Type.Literal('unpublished'),
  Type.Literal('published'),
  Type.Literal('scheduled'),
])

const CreateDocumentInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  fields: Type.Optional(FieldsRecord),
  status: Type.Optional(DocumentStatus),
})

const DeleteDocumentInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
})

const SetDocumentStatusInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  status: DocumentStatus,
  scheduledAt: Type.Optional(Type.String({ minLength: 1 })),
})

const SetDocumentFieldInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  fieldId: Type.String({ minLength: 1 }),
  value: Type.Unknown(),
})

const SetDocumentFieldsInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  fields: FieldsRecord,
})

const SetDocumentAuthorInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
})

const SetActiveDocumentInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
})

const SetActiveCollectionInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
})

// ---------------------------------------------------------------------------
// Capability requirements (ANY-OF)
// ---------------------------------------------------------------------------

const DOCUMENT_EDIT_CAPS: readonly CoreCapability[] = [
  'content.edit.own',
  'content.edit.any',
  'content.manage',
]

const DOCUMENT_PUBLISH_CAPS: readonly CoreCapability[] = [
  'content.publish.own',
  'content.publish.any',
]

const DOCUMENT_REASSIGN_CAPS: readonly CoreCapability[] = [
  'content.edit.any',
  'content.manage',
]

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Read the previous snapshot (the browser-sent one, or a refreshed one from a
 * prior tool call in the same turn) to determine which collection + document
 * the user was looking at. After a mutation the active doc ID may change
 * (e.g. create), so callers pass overrides.
 */
function prevSnapshot(ctx: { snapshot: unknown }): ContentSnapshot | null {
  const snap = ctx.snapshot as ContentSnapshot | null | undefined
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.collections)) return null
  return snap
}

async function pushSnapshot(
  ctx: Pick<ToolContext, 'onSnapshot' | 'db' | 'userId'>,
  activeTableId?: string | null,
  activeDocumentId?: string | null,
): Promise<void> {
  if (!ctx.onSnapshot) return
  const snap = await buildContentSnapshotFromDb(ctx.db, ctx.userId, activeTableId, activeDocumentId)
  ctx.onSnapshot(snap)
}

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------

/** Derive a URL-safe slug from a title string. */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || nanoid(8)
}

/**
 * Extract the slug cell value from a fields record, falling back to the
 * title-derived slug.
 */
function deriveSlug(fields: Record<string, unknown>): string {
  if (typeof fields.slug === 'string' && fields.slug.length > 0) return fields.slug
  if (typeof fields.title === 'string' && fields.title.length > 0) return slugifyTitle(fields.title)
  return nanoid(8)
}

// ---------------------------------------------------------------------------
// content_create_document (server-direct)
// ---------------------------------------------------------------------------

const createDocumentTool: AiTool = {
  name: 'content_create_document',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: ['content.create'],
  description:
    "Create a new document in `tableId`. `fields` is a Record<fieldId, value> per the collection's schema; omit to create an empty draft. `status` defaults to 'draft'. Returns the new document's id as `documentId` — the AI model then uses `content_set_active_document` to switch the user's view.",
  inputSchema: CreateDocumentInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof CreateDocumentInput>
    try {
      const cells = (args.fields ?? {}) as Record<string, unknown>
      const slug = deriveSlug(cells)
      const row = await createDataRow(ctx.db, {
        tableId: args.tableId,
        cells,
        slug,
      }, ctx.userId)

      // Push updated snapshot with the new document as active
      const prev = prevSnapshot(ctx)
      await pushSnapshot(ctx, prev?.activeTableId ?? args.tableId, row.id)

      return {
        ok: true,
        documentId: row.id,
        slug: row.slug,
        tableId: row.tableId,
        message: `Created document "${row.slug}" in collection ${args.tableId}.`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Create document failed: ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// content_delete_document (server-direct)
// ---------------------------------------------------------------------------

const deleteDocumentTool: AiTool = {
  name: 'content_delete_document',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_EDIT_CAPS,
  description:
    'Soft-delete a document. User can restore via the Trash UI.',
  inputSchema: DeleteDocumentInput,
  handler: async (input, ctx) => {
    const { documentId } = input as Static<typeof DeleteDocumentInput>
    try {
      const deleted = await softDeleteDataRow(ctx.db, documentId, ctx.userId)
      if (!deleted) {
        return { ok: false, error: `Document ${documentId} not found or already deleted.` }
      }

      // Push snapshot without the deleted doc
      const prev = prevSnapshot(ctx)
      const nextDocId = prev?.activeDocument?.id === documentId ? null : prev?.activeDocument?.id
      await pushSnapshot(ctx, prev?.activeTableId, nextDocId)

      return {
        ok: true,
        deleted: { id: deleted.id, slug: deleted.slug },
        message: `Deleted document "${deleted.slug}".`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Delete document failed: ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// content_set_document_status (server-direct)
// ---------------------------------------------------------------------------

const setDocumentStatusTool: AiTool = {
  name: 'content_set_document_status',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_PUBLISH_CAPS,
  description:
    "Set the document's lifecycle status. `status='scheduled'` requires `scheduledAt` (ISO datetime). `status='published'` runs the full incremental publish pipeline. `status='draft'` or `'unpublished'` retracts the document. Publishing requires content.publish.own (own docs) or content.publish.any (any doc).",
  inputSchema: SetDocumentStatusInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof SetDocumentStatusInput>
    try {
      const { documentId, status } = args

      if (status === 'published') {
        // Full incremental publish pipeline
        const result = await publishDataRow(ctx.db, documentId, ctx.userId, ctx.uploadsDir)
        const prev = prevSnapshot(ctx)
        await pushSnapshot(ctx, prev?.activeTableId, documentId)
        return {
          ok: true,
          status: 'published',
          versionId: result.version.id,
          message: `Published document "${result.row.slug}".`,
        }
      }

      if (status === 'scheduled') {
        if (!args.scheduledAt) {
          return { ok: false, error: 'scheduledAt is required when status is "scheduled".' }
        }
        const row = await scheduleDataRowPublish(ctx.db, documentId, args.scheduledAt, ctx.userId)
        if (!row) {
          return { ok: false, error: `Document ${documentId} not found.` }
        }
        const prev = prevSnapshot(ctx)
        await pushSnapshot(ctx, prev?.activeTableId, documentId)
        return {
          ok: true,
          status: 'scheduled',
          scheduledAt: args.scheduledAt,
          message: `Scheduled document "${row.slug}" for publish at ${args.scheduledAt}.`,
        }
      }

      // draft or unpublished
      const row = await updateDataRowStatus(ctx.db, documentId, status, ctx.userId)
      if (!row) {
        return { ok: false, error: `Document ${documentId} not found.` }
      }
      const prev = prevSnapshot(ctx)
      await pushSnapshot(ctx, prev?.activeTableId, documentId)
      return {
        ok: true,
        status: row.status,
        message: `Set document "${row.slug}" status to ${row.status}.`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Set document status failed: ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// content_set_document_field (server-direct)
// ---------------------------------------------------------------------------

const setDocumentFieldTool: AiTool = {
  name: 'content_set_document_field',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_EDIT_CAPS,
  description:
    "Write one field on a document. `value` shape depends on the field type (read content_get_collection_schema first if unsure): text/longText/richText/url/email → string; number → number; boolean → boolean; date/dateTime → ISO string; select → option id; multiSelect → option id[]; media → { id } or { id }[]; relation → { rowId } or { rowId }[]; body → markdown string.",
  inputSchema: SetDocumentFieldInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof SetDocumentFieldInput>
    try {
      // Read current row to merge
      const current = await getDataRow(ctx.db, args.documentId)
      if (!current) {
        return { ok: false, error: `Document ${args.documentId} not found.` }
      }

      const cells = { ...current.cells, [args.fieldId]: args.value } as Record<string, unknown>
      const slug = cells.slug !== undefined ? deriveSlug(cells) : current.slug

      const updated = await saveDataRowDraft(ctx.db, args.documentId, { cells, slug }, ctx.userId)
      if (!updated) {
        return { ok: false, error: `Failed to save document ${args.documentId}.` }
      }

      const prev = prevSnapshot(ctx)
      await pushSnapshot(ctx, prev?.activeTableId ?? updated.tableId, args.documentId)

      return {
        ok: true,
        fieldId: args.fieldId,
        message: `Set field "${args.fieldId}" on document "${updated.slug}".`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Set document field failed: ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// content_set_document_fields (server-direct)
// ---------------------------------------------------------------------------

const setDocumentFieldsTool: AiTool = {
  name: 'content_set_document_fields',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_EDIT_CAPS,
  description:
    'Batch-write multiple fields on one document. `fields` is Record<fieldId, value>; same per-type shapes as content_set_document_field. Prefer this when generating a whole post (title + slug + body + seo* in one call).',
  inputSchema: SetDocumentFieldsInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof SetDocumentFieldsInput>
    try {
      const current = await getDataRow(ctx.db, args.documentId)
      if (!current) {
        return { ok: false, error: `Document ${args.documentId} not found.` }
      }

      const merged = { ...current.cells, ...args.fields } as Record<string, unknown>
      const slug = deriveSlug(merged)

      const updated = await saveDataRowDraft(ctx.db, args.documentId, { cells: merged, slug }, ctx.userId)
      if (!updated) {
        return { ok: false, error: `Failed to save document ${args.documentId}.` }
      }

      const prev = prevSnapshot(ctx)
      await pushSnapshot(ctx, prev?.activeTableId ?? updated.tableId, args.documentId)

      const fieldNames = Object.keys(args.fields).join(', ')
      return {
        ok: true,
        updatedFields: Object.keys(args.fields),
        message: `Updated fields [${fieldNames}] on document "${updated.slug}".`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Set document fields failed: ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// content_set_document_author (server-direct)
// ---------------------------------------------------------------------------

const setDocumentAuthorTool: AiTool = {
  name: 'content_set_document_author',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_REASSIGN_CAPS,
  description:
    'Reassign the document author to another user. Requires content.edit.any. Use content_list_users to find the right user id.',
  inputSchema: SetDocumentAuthorInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof SetDocumentAuthorInput>
    try {
      const updated = await updateDataRowAuthor(ctx.db, args.documentId, args.userId, ctx.userId)
      if (!updated) {
        return { ok: false, error: `Document ${args.documentId} not found.` }
      }

      const prev = prevSnapshot(ctx)
      await pushSnapshot(ctx, prev?.activeTableId, args.documentId)

      return {
        ok: true,
        authorUserId: updated.authorUserId,
        message: `Reassigned document "${updated.slug}" to user ${args.userId}.`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Set document author failed: ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// content_set_active_document (browser-bridged — UI only, no DB write)
// ---------------------------------------------------------------------------

const setActiveDocumentTool: AiTool = {
  name: 'content_set_active_document',
  scope: 'content',
  execution: 'browser',
  description:
    "Switch the user's editor to this document so they can watch you work. Call BEFORE editing a doc that isn't already open — the user only sees the active doc.",
  inputSchema: SetActiveDocumentInput,
}

// ---------------------------------------------------------------------------
// content_set_active_collection (browser-bridged — UI only, no DB write)
// ---------------------------------------------------------------------------

const setActiveCollectionTool: AiTool = {
  name: 'content_set_active_collection',
  scope: 'content',
  execution: 'browser',
  description:
    'Switch the workspace sidebar focus to this collection. Use when working across collection-level actions (browsing, bulk reviews).',
  inputSchema: SetActiveCollectionInput,
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const contentWriteTools: AiTool[] = [
  createDocumentTool,
  deleteDocumentTool,
  setDocumentStatusTool,
  setDocumentFieldTool,
  setDocumentFieldsTool,
  setDocumentAuthorTool,
  setActiveDocumentTool,
  setActiveCollectionTool,
]
