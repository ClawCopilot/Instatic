/**
 * Build a ContentSnapshot from the database — used by server-direct content
 * write tools to push a fresh snapshot back into the turn context after a
 * mutation, so the NEXT tool call sees the post-write state.
 *
 * The browser-sourced snapshot carries the user's live editor state (Tiptap
 * draft, active tab). The DB-sourced snapshot is slightly stale (it only
 * reflects COMMITTED database state) but is correct for the agent's NEXT
 * tool call — the user can refresh the browser tab to sync.
 */

import type { DbClient } from '../../../db/client'
import type { ContentSnapshot, ActiveDocument } from './snapshot'
import {
  listDataTablesWithCounts,
  getDataRow,
  listDataAuthorOptions,
} from '../../../repositories/data'
import { normalizeDataTableFields } from '@core/data/fields'
import { readTitleCell } from '@core/data/cells'
import type { DataField } from '@core/data/schemas'

/** Content collections the agent works with. */
const CONTENT_KINDS = new Set(['postType', 'page'])

/**
 * Build a full ContentSnapshot from the database. Used by server-direct
 * write tools to refresh the turn context after a mutation.
 *
 * @param activeTableId  If provided, this collection becomes the active focus.
 * @param activeDocumentId  If provided, this document's full state is loaded.
 */
export async function buildContentSnapshotFromDb(
  db: DbClient,
  userId: string,
  activeTableId?: string | null,
  activeDocumentId?: string | null,
): Promise<ContentSnapshot> {
  const [tables, authorOptions] = await Promise.all([
    listDataTablesWithCounts(db),
    listDataAuthorOptions(db),
  ])

  const currentUser = authorOptions.find((u) => u.id === userId) ?? {
    id: userId,
    email: '',
    displayName: 'Unknown',
    roleSlug: '',
    roleName: '',
  }

  const collections = tables
    .filter((t) => CONTENT_KINDS.has(t.kind))
    .map((t) => ({
      id: t.id,
      slug: t.slug,
      label: t.pluralLabel || t.name,
      kind: t.kind,
      docCount: t.rowCount,
    }))

  let activeDocument: ActiveDocument | null = null
  if (activeDocumentId) {
    const row = await getDataRow(db, activeDocumentId)
    if (row) {
      const table = tables.find((t) => t.id === row.tableId)
      const fields = table ? normalizeDataTableFields(table.fields) : []
      const title = readTitleCell(row.cells) || row.slug || row.id
      activeDocument = {
        id: row.id,
        tableId: row.tableId,
        title,
        slug: row.slug ?? '',
        status: (row.status as ActiveDocument['status']) ?? 'draft',
        fields: row.cells as Record<string, unknown>,
        schema: fields.map(projectFieldForSnapshot),
        authorUserId: row.authorUserId,
        updatedAt: row.updatedAt,
      }
    }
  }

  return {
    collections,
    activeTableId: activeTableId ?? null,
    activeDocument,
    currentUser: {
      id: currentUser.id,
      displayName: currentUser.displayName,
      email: currentUser.email,
    },
  }
}

function projectFieldForSnapshot(field: DataField): ActiveDocument['schema'][number] {
  const base = {
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required ?? false,
    builtIn: field.builtIn ?? false,
  }
  if (field.type === 'select' || field.type === 'multiSelect') {
    return { ...base, options: (field.options ?? []).map((o) => ({ value: o.id, label: o.label })) }
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
      targetTableSlug: field.targetTableId,
      allowMultiple: field.allowMultiple ?? false,
    }
  }
  return base
}
