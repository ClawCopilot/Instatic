/**
 * Data-scope read tools — server-resolved.
 *
 * Four read tools that hit the data-table and data-row repositories directly
 * through `ctx.db`. None of them mutate. Results are projected to compact
 * "agent-friendly" shapes to keep context-window usage low.
 *
 * Key difference from content-scope read tools: data-scope tools expose ALL
 * table kinds (postType, page, data, component) — the data workspace owns
 * the full data model, not just routable content.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import {
  getDataRow,
  listDataRows,
  listDataTablesWithCounts,
} from '../../../repositories/data'
import {
  readSlugCell,
  readTitleCell,
} from '@core/data/cells'
import { normalizeDataTableFields } from '@core/data/fields'
import type { DataField, DataRow, DataTableListItem } from '@core/data/schemas'
import {
  canReadDataRow,
  canReadDataTable,
  dataRowVisibility,
} from '../../../auth/dataAccess'

// ---------------------------------------------------------------------------
// Capability requirements (ANY-OF) — mirrors HTTP-route gates in
// server/handlers/cms/data/access.ts.
// ---------------------------------------------------------------------------

// Row-level read — mirrors `requireDataAccess` (DATA_ACCESS_CAPABILITIES).
const ROW_READ_CAPS: readonly CoreCapability[] = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
]

// Schema-level read — mirrors `requireDataTablesRead`. Covers both table
// families (custom + system).
const SCHEMA_READ_CAPS: readonly CoreCapability[] = [
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
  'data.system.tables.manage',
]

// ---------------------------------------------------------------------------
// Shared projections
// ---------------------------------------------------------------------------

function projectTable(table: DataTableListItem) {
  return {
    id: table.id,
    slug: table.slug,
    name: table.name,
    label: table.pluralLabel || table.name,
    kind: table.kind,
    rowCount: table.rowCount,
    primaryFieldId: table.primaryFieldId,
    routeBase: table.routeBase,
    singularLabel: table.singularLabel,
    pluralLabel: table.pluralLabel,
  }
}

function projectField(field: DataField) {
  const base = {
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required ?? false,
    builtIn: field.builtIn ?? false,
  }
  if (field.type === 'select' || field.type === 'multiSelect') {
    return { ...base, options: field.options.map((o) => ({ value: o.id, label: o.label })) }
  }
  if (field.type === 'media') {
    return {
      ...base,
      mediaKind: field.mediaKind,
      allowMultiple: field.allowMultiple ?? false,
    }
  }
  if (field.type === 'relation') {
    return {
      ...base,
      targetTableId: field.targetTableId,
      allowMultiple: field.allowMultiple ?? false,
    }
  }
  return base
}

function projectRow(row: DataRow) {
  return {
    id: row.id,
    tableId: row.tableId,
    title: readTitleCell(row.cells) || readSlugCell(row.cells) || row.slug || row.id,
    slug: row.slug,
    status: row.status,
    authorUserId: row.authorUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    cells: row.cells,
  }
}

// ---------------------------------------------------------------------------
// data_list_tables
// ---------------------------------------------------------------------------

const ListTablesInput = Type.Object({
  kind: Type.Optional(Type.Union([
    Type.Literal('postType'),
    Type.Literal('page'),
    Type.Literal('data'),
    Type.Literal('component'),
  ])),
})

const listTablesTool: AiTool = {
  name: 'data_list_tables',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: SCHEMA_READ_CAPS,
  description:
    'List every data table in the project (all kinds: postType, page, data, component). Returns id, slug, name, kind, rowCount, primaryFieldId, routeBase. Optionally filter by `kind`. Use to discover where data lives before reading/writing rows.',
  inputSchema: ListTablesInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof ListTablesInput>
    const tables = await listDataTablesWithCounts(ctx.db)
    const readable = tables.filter((table) => (
      canReadDataTable({ id: ctx.userId, capabilities: ctx.capabilities }, table)
    ))
    const filtered = args.kind ? readable.filter((t) => t.kind === args.kind) : readable
    return { tables: filtered.map(projectTable) }
  },
}

// ---------------------------------------------------------------------------
// data_get_table
// ---------------------------------------------------------------------------

const GetTableInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
})

const getTableTool: AiTool = {
  name: 'data_get_table',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: SCHEMA_READ_CAPS,
  description:
    "Return one table's full schema: every field's id, label, type, required flag, builtIn flag, and per-type extras (select options, media kind, relation target). Call BEFORE data_create_row or data_update_row on an unfamiliar table so you know the field shapes.",
  inputSchema: GetTableInput,
  handler: async (input, ctx) => {
    const { tableId } = input as Static<typeof GetTableInput>
    const tables = await listDataTablesWithCounts(ctx.db)
    const table = tables.find((t) => t.id === tableId)
    if (
      !table
      || !canReadDataTable({ id: ctx.userId, capabilities: ctx.capabilities }, table)
    ) {
      return { ok: false, error: `Table ${tableId} not found.` }
    }
    const fields = normalizeDataTableFields(table.fields)
    return {
      table: {
        ...projectTable(table),
        fields: fields.map(projectField),
      },
    }
  },
}

// ---------------------------------------------------------------------------
// data_list_rows
// ---------------------------------------------------------------------------

const ListRowsInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  status: Type.Optional(Type.Union([
    Type.Literal('draft'),
    Type.Literal('unpublished'),
    Type.Literal('published'),
    Type.Literal('scheduled'),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  includeCells: Type.Optional(Type.Boolean()),
})

const listRowsTool: AiTool = {
  name: 'data_list_rows',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: ROW_READ_CAPS,
  description:
    'List rows in one table. Returns id, title, slug, status, authorUserId, timestamps, and optionally `cells` (all field values). Filter by status. Paginate with limit (default 25, max 200) + offset. Set `includeCells: true` to get the full row payload.',
  inputSchema: ListRowsInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof ListRowsInput>
    const all = await listDataRows(
      ctx.db,
      args.tableId,
      dataRowVisibility({ id: ctx.userId, capabilities: ctx.capabilities }),
    )
    let filtered = all
    if (args.status) filtered = filtered.filter((r) => r.status === args.status)
    const offset = args.offset ?? 0
    const limit = args.limit ?? 25
    const slice = filtered.slice(offset, offset + limit)
    const includeCells = args.includeCells ?? false
    return {
      total: filtered.length,
      offset,
      limit,
      rows: slice.map((r) => {
        const base = {
          id: r.id,
          tableId: r.tableId,
          title: readTitleCell(r.cells) || readSlugCell(r.cells) || r.slug || r.id,
          slug: r.slug,
          status: r.status,
          authorUserId: r.authorUserId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          publishedAt: r.publishedAt,
        }
        return includeCells ? { ...base, cells: r.cells } : base
      }),
    }
  },
}

// ---------------------------------------------------------------------------
// data_get_row
// ---------------------------------------------------------------------------

const GetRowInput = Type.Object({
  rowId: Type.String({ minLength: 1 }),
})

const getRowTool: AiTool = {
  name: 'data_get_row',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: ROW_READ_CAPS,
  description:
    "Return one row's full state: every field value in `cells`, status, author, slug, and timestamps. Use to inspect a row before updating or to verify state after a mutation.",
  inputSchema: GetRowInput,
  handler: async (input, ctx) => {
    const { rowId } = input as Static<typeof GetRowInput>
    const row = await getDataRow(ctx.db, rowId)
    if (
      !row
      || !canReadDataRow({ id: ctx.userId, capabilities: ctx.capabilities }, row)
    ) {
      return { ok: false, error: `Row ${rowId} not found.` }
    }
    return { row: projectRow(row) }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const dataReadTools: AiTool[] = [
  listTablesTool,
  getTableTool,
  listRowsTool,
  getRowTool,
]
