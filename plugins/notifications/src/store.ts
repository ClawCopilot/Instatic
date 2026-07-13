/**
 * DB CRUD for notifications plugin.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { DbClient } from '@instatic/plugin-sdk/host'

export type Channel = 'email' | 'sms' | 'webhook'
export type TemplateFormat = 'text' | 'html' | 'json'
export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'dropped_duplicate'

export interface Template {
  id: string
  event: string
  channel: Channel
  subject: string
  body: string
  format: TemplateFormat
  locale: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface LogEntry {
  id: string
  event: string
  channel: Channel
  recipient: string
  subject: string | null
  body: string | null
  status: DeliveryStatus
  provider: string | null
  providerMessageId: string | null
  error: string | null
  dedupKey: string
  attempt: number
  createdAt: string
  deliveredAt: string | null
}

export interface WebhookSubscription {
  id: string
  url: string
  secretHash: string
  events: string[]
  description: string
  enabled: boolean
  lastDeliveryAt: string | null
  lastStatus: string | null
  consecutiveFailures: number
  createdAt: string
  updatedAt: string
}

interface TemplateRow {
  id: string
  event: string
  channel: string
  subject: string
  body: string
  format: string
  locale: string
  enabled: boolean | number
  created_at: string
  updated_at: string
}

interface LogRow {
  id: string
  event: string
  channel: string
  recipient: string
  subject: string | null
  body: string | null
  status: string
  provider: string | null
  provider_message_id: string | null
  error: string | null
  dedup_key: string
  attempt: number
  created_at: string
  delivered_at: string | null
}

interface WebhookRow {
  id: string
  url: string
  secret_hash: string
  events_json: string | string[]
  description: string
  enabled: boolean | number
  last_delivery_at: string | null
  last_status: string | null
  consecutive_failures: number
  created_at: string
  updated_at: string
}

function parseJson<T>(value: string | T): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value
}

function rowToTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    event: row.event,
    channel: row.channel as Channel,
    subject: row.subject,
    body: row.body,
    format: row.format as TemplateFormat,
    locale: row.locale,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToLog(row: LogRow): LogEntry {
  return {
    id: row.id,
    event: row.event,
    channel: row.channel as Channel,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    status: row.status as DeliveryStatus,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    error: row.error,
    dedupKey: row.dedup_key,
    attempt: row.attempt,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  }
}

function rowToWebhook(row: WebhookRow): WebhookSubscription {
  return {
    id: row.id,
    url: row.url,
    secretHash: row.secret_hash,
    events: parseJson<string[]>(row.events_json),
    description: row.description,
    enabled: !!row.enabled,
    lastDeliveryAt: row.last_delivery_at,
    lastStatus: row.last_status,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ─── Templates ───────────────────────────────────────────────────────────

export async function findTemplate(
  db: DbClient,
  event: string,
  channel: Channel,
  locale = 'en',
): Promise<Template | null> {
  const { rows } = await db<TemplateRow>`
    select * from notification_templates
    where event = ${event} and channel = ${channel} and locale = ${locale} and enabled = true
    limit 1
  `
  return rows[0] ? rowToTemplate(rows[0]) : null
}

export async function upsertTemplate(
  db: DbClient,
  t: Omit<Template, 'createdAt' | 'updatedAt'>,
): Promise<Template> {
  const { rows } = await db<TemplateRow>`
    insert into notification_templates (id, event, channel, subject, body, format, locale, enabled)
    values (${t.id}, ${t.event}, ${t.channel}, ${t.subject}, ${t.body}, ${t.format}, ${t.locale}, ${t.enabled})
    on conflict (event, channel, locale) do update
    set subject = excluded.subject, body = excluded.body, format = excluded.format, enabled = excluded.enabled, updated_at = now()
    returning *
  `
  return rowToTemplate(rows[0])
}

export async function listTemplates(db: DbClient): Promise<Template[]> {
  const { rows } = await db<TemplateRow>`select * from notification_templates order by event, channel, locale`
  return rows.map(rowToTemplate)
}

// ─── Log ─────────────────────────────────────────────────────────────────

export async function checkRecentDuplicate(
  db: DbClient,
  event: string,
  recipient: string,
  dedupKey: string,
  withinSeconds = 300,
): Promise<boolean> {
  // SQLite uses strftime, Postgres uses now() - interval
  const { rows } = await db<{ exists: boolean }>`
    select exists(
      select 1 from notification_log
      where event = ${event}
        and recipient = ${recipient}
        and dedup_key = ${dedupKey}
        and created_at > now() - (${withinSeconds} || ' seconds')::interval
    ) as exists
  `
  return !!rows[0]?.exists
}

export async function recordLog(
  db: DbClient,
  entry: Omit<LogEntry, 'id' | 'createdAt'>,
): Promise<LogEntry> {
  const id = `notif_${randomBytes(8).toString('hex')}`
  const { rows } = await db<LogRow>`
    insert into notification_log (
      id, event, channel, recipient, subject, body, status,
      provider, provider_message_id, error, dedup_key, attempt, delivered_at
    ) values (
      ${id}, ${entry.event}, ${entry.channel}, ${entry.recipient},
      ${entry.subject}, ${entry.body}, ${entry.status},
      ${entry.provider}, ${entry.providerMessageId}, ${entry.error},
      ${entry.dedupKey}, ${entry.attempt}, ${entry.deliveredAt}
    )
    returning *
  `
  return rowToLog(rows[0])
}

export async function listLog(db: DbClient, limit = 100): Promise<LogEntry[]> {
  const { rows } = await db<LogRow>`select * from notification_log order by created_at desc limit ${limit}`
  return rows.map(rowToLog)
}

// ─── Webhooks ────────────────────────────────────────────────────────────

export async function listEnabledWebhooksForEvent(
  db: DbClient,
  event: string,
): Promise<WebhookSubscription[]> {
  const { rows } = await db<WebhookRow>`
    select * from notification_webhooks
    where enabled = true
  `
  return rows
    .map(rowToWebhook)
    .filter((w) => w.events.includes(event) || w.events.includes('*'))
}

export async function createWebhook(
  db: DbClient,
  args: Omit<WebhookSubscription, 'createdAt' | 'updatedAt' | 'lastDeliveryAt' | 'lastStatus' | 'consecutiveFailures'>,
): Promise<{ webhook: WebhookSubscription; secret: string }> {
  const secret = randomBytes(32).toString('base64url')
  const secretHash = createHash('sha256').update(secret).digest('hex')
  const id = `wh_${randomBytes(8).toString('hex')}`
  const { rows } = await db<WebhookRow>`
    insert into notification_webhooks (id, url, secret_hash, events_json, description, enabled)
    values (${id}, ${args.url}, ${secretHash}, ${JSON.stringify(args.events)}::jsonb, ${args.description}, ${args.enabled})
    returning *
  `
  return { webhook: rowToWebhook(rows[0]), secret }
}

export async function recordWebhookDelivery(
  db: DbClient,
  id: string,
  success: boolean,
  status: string,
): Promise<void> {
  if (success) {
    await db`
      update notification_webhooks
      set last_delivery_at = now(),
          last_status = ${status},
          consecutive_failures = 0,
          updated_at = now()
      where id = ${id}
    `
  } else {
    await db`
      update notification_webhooks
      set last_delivery_at = now(),
          last_status = ${status},
          consecutive_failures = consecutive_failures + 1,
          updated_at = now()
      where id = ${id}
    `
  }
}

export function signWebhookPayload(secret: string, body: string, timestamp: number): string {
  // Delegated to the shared hmacWebhook utility.
  // The signature format is the same as Stripe's:
  //   X-Instatic-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
  return signHmacPayloadShared(secret, body, timestamp)
}

// Re-export from the shared utility (avoids cross-plugin import)
import { signHmacPayload as signHmacPayloadShared } from '../../_shared/hmacWebhook'