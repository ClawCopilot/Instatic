/**
 * Webhook management tools — server-resolved.
 *
 * Instatic does not have a native webhook CRUD repository. These tools
 * store webhook configurations as rows in the data table layer (a table
 * of kind 'data' named 'webhooks'), allowing the AI to manage webhook
 * endpoints in the same way it manages structured content.
 *
 * Four tools: `webhook_list`, `webhook_get`, `webhook_create`, `webhook_delete`.
 *
 * Webhook dispatch (the actual HTTP POST on content change) is handled
 * by `server/webhook/dispatcher.ts`. The dispatcher registers hookBus
 * listeners for all core events (content.entry.*, publish.*) and POSTs
 * HMAC-signed JSON payloads to matching enabled webhook endpoints with
 * 3-attempt exponential-backoff retry (1s → 4s → 16s).
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import {
  getDataRow,
  createDataRow,
  listDataRows,
  listDataTables,
  softDeleteDataRow,
  createDataTable,
} from '../../../repositories/data'
import { nanoid } from 'nanoid'
import type { DataField } from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

const WEBHOOK_READ_CAPS: readonly CoreCapability[] = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
]

const WEBHOOK_WRITE_CAPS: readonly CoreCapability[] = [
  'content.edit.own',
  'content.edit.any',
  'content.manage',
]

// ---------------------------------------------------------------------------
// Webhook table bootstrap
// ---------------------------------------------------------------------------

const WEBHOOK_TABLE_SLUG = 'webhooks'

const WEBHOOK_FIELDS: DataField[] = [
  { id: 'title',    label: 'Name',       type: 'text',         required: true },
  { id: 'url',      label: 'URL',        type: 'url',          required: true },
  { id: 'events',   label: 'Events',     type: 'longText',    required: false },
  { id: 'secret',   label: 'Secret',     type: 'text',        required: false },
  { id: 'enabled',  label: 'Enabled',   type: 'boolean',      required: false },
]

async function ensureWebhookTable(db: import('../../../db/client').DbClient, userId: string) {
  const existing = await listDataTables(db)
  const found = existing.find((t) => t.slug === WEBHOOK_TABLE_SLUG)
  if (found) return found

  return createDataTable(db, {
    name: 'Webhooks',
    slug: WEBHOOK_TABLE_SLUG,
    kind: 'data',
    singularLabel: 'Webhook',
    pluralLabel: 'Webhooks',
    primaryFieldId: 'title',
    fields: WEBHOOK_FIELDS,
    createdByUserId: userId,
    updatedByUserId: userId,
  })
}

// ---------------------------------------------------------------------------
// Shared projection
// ---------------------------------------------------------------------------

interface WebhookProjection {
  id: string
  name: string
  url: string
  events: string[]
  secret: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

function projectWebhook(row: Record<string, unknown>): WebhookProjection {
  const cells = (row.cells as Record<string, unknown>) ?? {}
  const eventsRaw = (cells.events as string) ?? ''
  const events = eventsRaw
    ? eventsRaw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    : []
  return {
    id: row.id as string,
    name: (cells.title as string) ?? (row.slug as string) ?? '',
    url: (cells.url as string) ?? '',
    events,
    secret: (cells.secret as string) ?? null,
    enabled: cells.enabled !== false,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  }
}

// ---------------------------------------------------------------------------
// webhook_list
// ---------------------------------------------------------------------------

const listWebhooksTool: AiTool = {
  name: 'webhook_list',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: WEBHOOK_READ_CAPS,
  description:
    'List every webhook configuration in the project. Each webhook has a name, target URL, subscribed events (comma-delimited), optional secret for HMAC signing, and an enabled flag. Webhooks are stored in a special "webhooks" data table — the AI auto-creates this table on first use.',
  inputSchema: Type.Object({}),
  handler: async (_input, ctx) => {
    try {
      const table = await ensureWebhookTable(ctx.db, ctx.userId)
      const rows = await listDataRows(ctx.db, table.id)
      return {
        total: rows.length,
        webhooks: rows.map((r) => projectWebhook({ ...r, cells: r.cells })),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  },
}

// ---------------------------------------------------------------------------
// webhook_get
// ---------------------------------------------------------------------------

const GetWebhookInput = Type.Object({
  webhookId: Type.String({ minLength: 1 }),
})

const getWebhookTool: AiTool = {
  name: 'webhook_get',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: WEBHOOK_READ_CAPS,
  description:
    'Get one webhook configuration by id. Returns name, url, events, secret, enabled status, and timestamps.',
  inputSchema: GetWebhookInput,
  handler: async (input, ctx) => {
    const { webhookId } = input as Static<typeof GetWebhookInput>
    try {
      const row = await getDataRow(ctx.db, webhookId)
      if (!row) {
        return { ok: false, error: `Webhook ${webhookId} not found.` }
      }
      return { webhook: projectWebhook(row) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  },
}

// ---------------------------------------------------------------------------
// webhook_create
// ---------------------------------------------------------------------------

const CreateWebhookInput = Type.Object({
  name: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  events: Type.Array(Type.String(), { minItems: 1 }),
  secret: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
})

const createWebhookTool: AiTool = {
  name: 'webhook_create',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: WEBHOOK_WRITE_CAPS,
  description:
    'Create a new webhook configuration. `name` is a human-readable label. `url` is the HTTP endpoint that receives POST requests. `events` is a list of event names this webhook subscribes to (e.g. ["content.created", "content.updated", "publish.completed"]). `secret` is an optional HMAC signing key. `enabled` defaults to true. Returns the created webhook id.',
  inputSchema: CreateWebhookInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof CreateWebhookInput>
    try {
      const table = await ensureWebhookTable(ctx.db, ctx.userId)
      const slug = `wh-${nanoid(8)}`
      const cells: Record<string, unknown> = {
        title: args.name,
        url: args.url,
        events: args.events.join(', '),
        secret: args.secret ?? '',
        enabled: args.enabled ?? true,
      }
      const row = await createDataRow(
        ctx.db,
        { tableId: table.id, cells, slug },
        ctx.userId,
      )
      return {
        ok: true,
        webhook: projectWebhook(row),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  },
}

// ---------------------------------------------------------------------------
// webhook_delete
// ---------------------------------------------------------------------------

const DeleteWebhookInput = Type.Object({
  webhookId: Type.String({ minLength: 1 }),
})

const deleteWebhookTool: AiTool = {
  name: 'webhook_delete',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: WEBHOOK_WRITE_CAPS,
  description:
    'Delete a webhook configuration. Soft-deletes the row (restorable via Trash UI).',
  inputSchema: DeleteWebhookInput,
  handler: async (input, ctx) => {
    const { webhookId } = input as Static<typeof DeleteWebhookInput>
    try {
      const deleted = await softDeleteDataRow(ctx.db, webhookId, ctx.userId)
      if (!deleted) {
        return { ok: false, error: `Webhook ${webhookId} not found or already deleted.` }
      }
      return { ok: true, deleted: { id: deleted.id, slug: deleted.slug } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const webhookTools: AiTool[] = [
  listWebhooksTool,
  getWebhookTool,
  createWebhookTool,
  deleteWebhookTool,
]
