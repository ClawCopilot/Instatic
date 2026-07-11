/**
 * Import tools — server-resolved.
 *
 * Two tools for bulk data import:
 *   - `data_import_json` — import rows from a JSON array
 *   - `data_import_csv`  — import rows from a CSV string
 *
 * Both tools use the transactional `createDataRowMany` path so the batch
 * fully succeeds or fully aborts on any error.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import { createDataRowMany, getDataTable } from '../../../repositories/data'
import { slugForTable } from '@core/data/cells'

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

const IMPORT_CAPS: readonly CoreCapability[] = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.manage',
]

// ---------------------------------------------------------------------------
// data_import_json
// ---------------------------------------------------------------------------

const ImportJsonInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  /** JSON string or object — an array of { cells, slug? } entries. */
  rows: Type.Array(
    Type.Object({
      slug: Type.Optional(Type.String()),
      cells: Type.Record(Type.String(), Type.Unknown()),
    }),
  ),
})

const importJsonTool: AiTool = {
  name: 'data_import_json',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: IMPORT_CAPS,
  description:
    'Import rows from a JSON array into a table. `tableId` is the target table. `rows` is an array of `{ cells, slug? }` — each `cells` maps fieldId to value matching the table schema. Call data_get_table first to see field ids and types. The batch runs in one transaction: any error aborts all inserts. Max 100 rows per call. Returns created row count and ids.',
  inputSchema: ImportJsonInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof ImportJsonInput>

    if (args.rows.length > 100) {
      return { ok: false, error: `Too many rows: ${args.rows.length}. Maximum is 100 per call. Split into multiple calls if needed.` }
    }

    const table = await getDataTable(ctx.db, args.tableId)
    if (!table) {
      return { ok: false, error: `Table ${args.tableId} not found.` }
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
        imported: created.length,
        rows: created.map((r) => ({
          id: r.id,
          tableId: r.tableId,
          slug: r.slug,
          status: r.status,
        })),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Import failed (all rows rolled back): ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// data_import_csv
// ---------------------------------------------------------------------------

const ImportCsvInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  /**
   * Raw CSV text. First row MUST be headers.
   * Each header name maps to a fieldId in the target table.
   * Lines starting with # or empty are skipped.
   */
  csv: Type.String({ minLength: 1 }),
  /**
   * Field id mapping: CSV header → fieldId. If omitted, headers are used
   * as field ids directly (the CSV header must match the table field ids).
   */
  fieldMapping: Type.Optional(Type.Record(Type.String(), Type.String())),
})

function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
  if (lines.length < 2) return { headers: [], rows: [] }

  const parseLine = (line: string): string[] => {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++ }
          else inQuotes = false
        } else { current += ch }
      } else {
        if (ch === '"') { inQuotes = true }
        else if (ch === ',') { result.push(current.trim()); current = '' }
        else { current += ch }
      }
    }
    result.push(current.trim())
    return result
  }

  const headers = parseLine(lines[0])
  const rows = lines.slice(1).map(parseLine)
  return { headers, rows }
}

function inferValue(v: string): unknown {
  if (v === '' || v === 'null') return ''
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/.test(v)) return v // Keep dates as ISO strings
  return v
}

const importCsvTool: AiTool = {
  name: 'data_import_csv',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: IMPORT_CAPS,
  description:
    'Import rows from a CSV text block into a table. `tableId` is the target. `csv` is the raw CSV string (header row first). `fieldMapping` optionally maps CSV header names to table field ids (e.g. {"Post Title":"title","Body":"body"}); if omitted, headers are used as field ids directly. Empty fields become empty strings, "true"/"false" become booleans, numbers are auto-detected. Max 100 rows. Batch is transactional.',
  inputSchema: ImportCsvInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof ImportCsvInput>

    const table = await getDataTable(ctx.db, args.tableId)
    if (!table) {
      return { ok: false, error: `Table ${args.tableId} not found.` }
    }

    const { headers, rows } = parseCsv(args.csv)
    if (headers.length === 0) {
      return { ok: false, error: 'CSV is empty or has no header row.' }
    }
    if (rows.length > 100) {
      return { ok: false, error: `Too many data rows: ${rows.length}. Maximum is 100 per call.` }
    }

    const mapping = args.fieldMapping ?? Object.fromEntries(headers.map((h) => [h, h]))

    const inputs = rows.map((row) => {
      const cells: Record<string, unknown> = {}
      for (let i = 0; i < headers.length; i++) {
        const fieldId = mapping[headers[i]]
        if (fieldId) {
          cells[fieldId] = inferValue(row[i] ?? '')
        }
      }
      return {
        tableId: args.tableId,
        cells,
        slug: slugForTable(table, cells),
      }
    })

    try {
      const created = await createDataRowMany(ctx.db, inputs, ctx.userId)
      return {
        ok: true,
        imported: created.length,
        rows: created.map((r) => ({
          id: r.id,
          tableId: r.tableId,
          slug: r.slug,
          status: r.status,
        })),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `CSV import failed (all rows rolled back): ${message}` }
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const importTools: AiTool[] = [importJsonTool, importCsvTool]
