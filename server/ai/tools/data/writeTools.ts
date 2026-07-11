/**
 * Data-scope write tools — server-resolved.
 *
 * Four write tools that mutate the data model directly through the data
 * repositories. Unlike content-scope write tools (which are browser-bridged
 * to keep the editor store in sync), data-scope tools execute server-side
 * because they operate on raw tables/rows — no in-memory editor state to
 * maintain.
 *
 * Every mutation goes through the same repository functions the HTTP handlers
 * use, so behaviour (slug derivation, cell storage) is identical.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import type { DataField } from '@core/data/schemas'
import {
  createDataRow,
  createDataTable,
  getDataRow,
  getDataTable,
  saveDataRowDraft,
  softDeleteDataRow,
} from '../../../repositories/data'
import { slugForTable } from '@core/data/cells'

// ---------------------------------------------------------------------------
// Capability requirements (ANY-OF) — mirrors HTTP-route gates in
// server/handlers/cms/data/access.ts.
// ---------------------------------------------------------------------------

// Row creation — mirrors `requireDataCreator` (uses `content.create`).
const ROW_CREATE_CAPS: readonly CoreCapability[] = ['content.create']

// Row editing / deleting — mirrors `requireDataEditor` (DATA_EDIT_CAPABILITIES).
const ROW_EDIT_CAPS: readonly CoreCapability[] = [
  'content.edit.own',
  'content.edit.any',
  'content.manage',
]

// Table creation — mirrors `requireCustomTablesManager`.
const TABLE_MANAGE_CAPS: readonly CoreCapability[] = [
  'data.custom.tables.manage',
]

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

// Reusable field schema (mirrors DataField but simplified for the AI).
const DataFieldInput = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  type: Type.Union([
    Type.Literal('text'),
    Type.Literal('longText'),
    Type.Literal('richText'),
    Type.Literal('number'),
    Type.Literal('boolean'),
    Type.Literal('date'),
    Type.Literal('dateTime'),
    Type.Literal('select'),
    Type.Literal('multiSelect'),
    Type.Literal('url'),
    Type.Literal('email'),
    Type.Literal('media'),
    Type.Literal('relation'),
    Type.Literal('pageTree'),
  ]),
  required: Type.Optional(Type.Boolean()),
})

const CreateTableInput = Type.Object({
  name: Type.String({ minLength: 1 }),
  slug: Type.String({ minLength: 1 }),
  kind: Type.Optional(Type.Union([
    Type.Literal('postType'),
    Type.Literal('data'),
    Type.Literal('page'),
    Type.Literal('component'),
  ])),
  singularLabel: Type.Optional(Type.String()),
  pluralLabel: Type.Optional(Type.String()),
  routeBase: Type.Optional(Type.String()),
  primaryFieldId: Type.Optional(Type.String()),
  fields: Type.Optional(Type.Array(DataFieldInput)),
})

const CreateRowInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String({ minLength: 1 })),
  cells: Type.Record(Type.String(), Type.Unknown()),
})

const UpdateRowInput = Type.Object({
  rowId: Type.String({ minLength: 1 }),
  cells: Type.Record(Type.String(), Type.Unknown()),
})

const DeleteRowInput = Type.Object({
  rowId: Type.String({ minLength: 1 }),
})

// ---------------------------------------------------------------------------
// data_create_table
// ---------------------------------------------------------------------------

const createTableTool: AiTool = {
  name: 'data_create_table',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: TABLE_MANAGE_CAPS,
  description:
    "Create a new data table. `name` is the human-readable table name. `slug` is the URL-safe identifier. `kind` defaults to 'data' (non-routable); use 'postType' for a routable collection with publishing. `fields` is an array of field definitions — at minimum include a 'title' field (type 'text'). `singularLabel`/`pluralLabel` control UI labels; auto-derive from `name` if omitted. Returns the created table with its id.",
  inputSchema: CreateTableInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof CreateTableInput>
    const singularLabel = args.singularLabel ?? args.name
    const pluralLabel = args.pluralLabel ?? `${args.name}s`
    const fields: DataField[] = (args.fields ?? []).map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      required: f.required ?? false,
    } as DataField))

    const table = await createDataTable(ctx.db, {
      name: args.name,
      slug: args.slug,
      kind: args.kind ?? 'data',
      singularLabel,
      pluralLabel,
      routeBase: args.routeBase,
      primaryFieldId: args.primaryFieldId,
      fields,
      createdByUserId: ctx.userId,
      updatedByUserId: ctx.userId,
    })
    return {
      ok: true,
      table: {
        id: table.id,
        slug: table.slug,
        name: table.name,
        kind: table.kind,
        singularLabel: table.singularLabel,
        pluralLabel: table.pluralLabel,
        routeBase: table.routeBase,
        primaryFieldId: table.primaryFieldId,
      },
    }
  },
}

// ---------------------------------------------------------------------------
// data_create_row
// ---------------------------------------------------------------------------

const createRowTool: AiTool = {
  name: 'data_create_row',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: ROW_CREATE_CAPS,
  description:
    "Create a new row in `tableId`. `cells` is Record<fieldId, value> matching the table's field schema — call data_get_table first if you don't know the field ids. `slug` is optional; if omitted it's derived from the 'slug' cell if the table has a slug field. Returns the created row id.",
  inputSchema: CreateRowInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof CreateRowInput>
    const table = await getDataTable(ctx.db, args.tableId)
    if (!table) {
      return { ok: false, error: `Table ${args.tableId} not found.` }
    }
    const slug = args.slug ?? slugForTable(table, args.cells)
    const row = await createDataRow(
      ctx.db,
      { tableId: args.tableId, cells: args.cells, slug },
      ctx.userId,
    )
    return {
      ok: true,
      row: { id: row.id, tableId: row.tableId, slug: row.slug, status: row.status },
    }
  },
}

// ---------------------------------------------------------------------------
// data_update_row
// ---------------------------------------------------------------------------

const updateRowTool: AiTool = {
  name: 'data_update_row',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: ROW_EDIT_CAPS,
  description:
    "Overwrite a row's cells. `cells` is the new Record<fieldId, value> — this is a full replacement, not a partial merge. Call data_get_row first if you need to see current values. Returns the updated row.",
  inputSchema: UpdateRowInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof UpdateRowInput>
    const currentRow = await getDataRow(ctx.db, args.rowId)
    if (!currentRow) {
      return { ok: false, error: `Row ${args.rowId} not found.` }
    }
    const table = await getDataTable(ctx.db, currentRow.tableId)
    if (!table) {
      return { ok: false, error: `Table ${currentRow.tableId} not found.` }
    }
    const slug = slugForTable(table, args.cells)
    const updated = await saveDataRowDraft(
      ctx.db,
      args.rowId,
      { cells: args.cells, slug },
      ctx.userId,
    )
    if (!updated) {
      return { ok: false, error: `Row ${args.rowId} not found after update — may have been deleted.` }
    }
    return {
      ok: true,
      row: {
        id: updated.id,
        tableId: updated.tableId,
        slug: updated.slug,
        status: updated.status,
        cells: updated.cells,
      },
    }
  },
}

// ---------------------------------------------------------------------------
// data_delete_row
// ---------------------------------------------------------------------------

const deleteRowTool: AiTool = {
  name: 'data_delete_row',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: ROW_EDIT_CAPS,
  description:
    'Soft-delete a row. The user can restore it via the Trash UI.',
  inputSchema: DeleteRowInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof DeleteRowInput>
    const summary = await softDeleteDataRow(ctx.db, args.rowId, ctx.userId)
    if (!summary) {
      return { ok: false, error: `Row ${args.rowId} not found or already deleted.` }
    }
    return {
      ok: true,
      deleted: {
        id: summary.id,
        tableId: summary.tableId,
        slug: summary.slug,
        status: summary.status,
        deletedAt: summary.deletedAt,
      },
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const dataWriteTools: AiTool[] = [
  createTableTool,
  createRowTool,
  updateRowTool,
  deleteRowTool,
]
