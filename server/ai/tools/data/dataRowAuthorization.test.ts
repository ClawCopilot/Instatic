import { beforeEach, describe, expect, it } from 'bun:test'
import type { CoreCapability } from '@core/capabilities'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import { createDataRow, getDataRow } from '../../../repositories/data'
import { executeAiTool } from '../../drivers/http/execTool'
import type { AiBrowserBridge, AiTool } from '../../runtime/types'
import { selectToolsForScope } from '../index'

const OWN_ONLY_CAPABILITIES: CoreCapability[] = [
  'ai.chat',
  'ai.tools.write',
  'content.edit.own',
  'content.publish.own',
  'data.system.tables.read',
]

const NOOP_BRIDGE: AiBrowserBridge = {
  callBrowser: async () => {
    throw new Error('Data tools must execute on the server.')
  },
}

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values
      ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner'),
      ('u2', 'u2@example.com', 'u2@example.com', 'User Two', 'x', 'admin')
  `
  return db
}

function tool(name: string): AiTool {
  const found = selectToolsForScope('data', OWN_ONLY_CAPABILITIES)
    .find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Missing test tool: ${name}`)
  return found
}

async function execute(
  db: DbClient,
  name: string,
  input: unknown,
) {
  return executeAiTool(
    tool(name),
    input,
    NOOP_BRIDGE,
    new AbortController().signal,
    {
      db,
      userId: 'u1',
      capabilities: OWN_ONLY_CAPABILITIES,
      scope: 'data',
      conversationId: 'test',
      snapshot: null,
    },
  )
}

let db: DbClient

beforeEach(async () => {
  db = await freshDb()
})

describe('data tool row authorization', () => {
  it('filters list reads and hides foreign rows by id', async () => {
    const own = await createDataRow(db, {
      id: 'own-row',
      tableId: 'posts',
      cells: { title: 'Own row' },
      slug: 'own-row',
    }, 'u1')
    const foreign = await createDataRow(db, {
      id: 'foreign-row',
      tableId: 'posts',
      cells: { title: 'Foreign row' },
      slug: 'foreign-row',
    }, 'u2')

    const list = await execute(db, 'data_list_rows', { tableId: 'posts' })
    expect(list.ok).toBe(true)
    expect(JSON.stringify(list.data)).toContain(own.id)
    expect(JSON.stringify(list.data)).not.toContain(foreign.id)

    const get = await execute(db, 'data_get_row', { rowId: foreign.id })
    expect(get).toEqual({ ok: false, error: `Row ${foreign.id} not found.` })
  })

  it('rejects update, delete, and publish operations on a foreign row', async () => {
    const foreign = await createDataRow(db, {
      id: 'foreign-mutation-row',
      tableId: 'posts',
      cells: { title: 'Original' },
      slug: 'original',
    }, 'u2')

    const update = await execute(db, 'data_update_row', {
      rowId: foreign.id,
      cells: { title: 'Changed' },
    })
    const remove = await execute(db, 'data_delete_row', { rowId: foreign.id })
    const publish = await execute(db, 'data_publish_row', { rowId: foreign.id })

    expect(update.ok).toBe(false)
    expect(remove.ok).toBe(false)
    expect(publish.ok).toBe(false)
    expect((await getDataRow(db, foreign.id))?.cells).toEqual({ title: 'Original' })
  })

  it('does not offer full-site publish to a row-only publisher', () => {
    const names = selectToolsForScope('data', OWN_ONLY_CAPABILITIES)
      .map((candidate) => candidate.name)
    expect(names).toContain('data_publish_row')
    expect(names).not.toContain('site_publish')
    expect(names).not.toContain('site_publish_status')
  })
})
