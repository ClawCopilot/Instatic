/**
 * Batch-operation tools — server-resolved.
 *
 * One tool: bulk row creation. Wraps `createDataRowMany` in a transaction
 * so the batch either fully succeeds or fully aborts on any error
 * (duplicate slug, missing table, etc.).
 *
 * Use this when seeding initial content — call data_get_table first for
 * the field schema, then pass an array of rows.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import { createDataRowMany, getDataTable } from '../../../repositories/data'
import { slugForTable } from '@core/data/cells'
import { lockedBuiltInCellKey } from '@core/data/systemTableGuard'

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

const BATCH_CAPS: readonly CoreCapability[] = ['content.create']

// ---------------------------------------------------------------------------
// data_create_rows
// ---------------------------------------------------------------------------

const RowInput = Type.Object({
  slug: Type.Optional(Type.String({ minLength: 1 })),
  cells: Type.Record(Type.String(), Type.Unknown()),
})

const CreateRowsInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  rows: Type.Array(RowInput, { minItems: 1, maxItems: 100 }),
})

const createRowsTool: AiTool = {
  name: 'data_create_rows',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: BATCH_CAPS,
  description:
    'Batch-create up to 100 rows in a single transaction. `tableId` is the target table. `rows` is an array of `{ cells, slug? }` — each entry matches the single-row data_create_row shape. The batch runs in one transaction: any error (duplicate slug, invalid field) aborts the entire batch. Call data_get_table first if you need the field schema. Returns the created row ids.',
  inputSchema: CreateRowsInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof CreateRowsInput>

    // Validate table exists before entering the transaction.
    const table = await getDataTable(ctx.db, args.tableId)
    if (!table) {
      return { ok: false, error: `Table ${args.tableId} not found.` }
    }
    for (const row of args.rows) {
      const lockedField = lockedBuiltInCellKey(table, row.cells)
      if (lockedField) {
        return {
          ok: false,
          error: `The "${lockedField}" field is managed by the editor and cannot be edited here.`,
        }
      }
    }

    const inputs = args.rows.map((r) => ({
      tableId: args.tableId,
      cells: r.cells,
      slug: r.slug ?? slugForTable(table, r.cells),
    }))

    try {
      const created = await createDataRowMany(ctx.db, inputs, ctx.userId)
      return {
        ok: true,
        created: created.length,
        rows: created.map((r) => ({
          id: r.id,
          tableId: r.tableId,
          slug: r.slug,
          status: r.status,
        })),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Batch create failed (all rows rolled back): ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const batchTools: AiTool[] = [createRowsTool]
