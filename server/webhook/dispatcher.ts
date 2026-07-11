/**
 * Webhook dispatch engine — listens to core hook events, matches them
 * against webhook configurations stored in the `webhooks` data table,
 * and HTTP-POSTs signed payloads to each matching endpoint.
 *
 * Architecture
 * ────────────
 * The dispatcher registers listeners on the shared `hookBus` (the same
 * event bus used by plugins). On every core event it:
 *
 *   1. Queries the `webhooks` data table for enabled webhooks whose
 *      `events` list includes a wildcard or exact match for the fired
 *      event name.
 *   2. For each match, constructs a signed JSON payload and POSTs it
 *      asynchronously (**fire-and-forget** — the hookBus listener never
 *      blocks on webhook delivery).
 *   3. Delivery runs with a 3-attempt exponential-backoff retry
 *      policy (1s → 4s → 16s). Delivery attempts are logged to
 *      `console`; failed deliveries after all retries are logged as
 *      errors.
 *
 * HA safety
 * ─────────
 * In multi-instance deployments every host that runs `startWebhookDispatcher`
 * registers its own hookBus listeners, so every instance would fire the
 * same webhooks. This is intentional for fire-and-forget delivery — the
 * duplicate is cheaper than a leader-election tick loop for webhook
 * dispatch. Webhook receivers SHOULD be idempotent (the `X-Instatic-Delivery`
 * header carries a unique-per-fire delivery id to help deduplicate).
 *
 * Event names
 * ───────────
 * The dispatcher listens for the full set of core hook events:
 *
 *   content.entry.created   — new row inserted
 *   content.entry.updated   — row updated (includes `changedFieldIds`)
 *   content.entry.deleted   — row soft-deleted
 *   publish.before          — before HTML pipeline runs
 *   publish.after           — after full publish completes
 *   publish.row             — single-row publish (emitted by data_publish_row tool)
 *
 * Webhook event matching supports wildcards:
 *   "*"                 — matches everything
 *   "content.*"         — matches content.entry.*
 *   "publish.*"         — matches publish.*
 *   "content.entry.created" — exact match only
 */

import { hookBus } from '@core/plugins/hookBus'
import type { DbClient } from '../db/client'
import { listDataTables, listDataRows, getDataRow } from '../repositories/data'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The complete list of core events that webhooks can subscribe to. */
type WebhookEvent =
  | 'content.entry.created'
  | 'content.entry.updated'
  | 'content.entry.deleted'
  | 'publish.before'
  | 'publish.after'
  | 'publish.row'

const ALL_WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  'content.entry.created',
  'content.entry.updated',
  'content.entry.deleted',
  'publish.before',
  'publish.after',
  'publish.row',
]

/** Shape of each webhook row from the `webhooks` data table. */
interface WebhookConfig {
  id: string
  name: string
  url: string
  events: string[]
  secret: string | null
  enabled: boolean
}

/** Payload posted to each webhook endpoint. */
interface WebhookPayload {
  event: string
  deliveryId: string
  timestamp: string
  data: unknown
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Max retry attempts per delivery (3 = 1 initial + 2 retries). */
const MAX_RETRIES = 2

/** Base delay in ms for exponential backoff. */
const RETRY_BASE_MS = 1000

/** HTTP request timeout in ms. */
const REQUEST_TIMEOUT_MS = 15_000

/** Max concurrent outbound POSTs per fire (prevents thundering herd). */
const MAX_CONCURRENT = 8

// ---------------------------------------------------------------------------
// Webhook table lookup
// ---------------------------------------------------------------------------

/** Cached webhook table id — resolved once on first use. */
let webhookTableId: string | null = null

async function getWebhookTableId(db: DbClient): Promise<string | null> {
  if (webhookTableId) return webhookTableId
  const tables = await listDataTables(db)
  const found = tables.find((t) => t.slug === 'webhooks')
  if (found) webhookTableId = found.id
  return webhookTableId ?? null
}

/** Fetch all enabled webhook configs. */
async function getEnabledWebhooks(db: DbClient): Promise<WebhookConfig[]> {
  const tableId = await getWebhookTableId(db)
  if (!tableId) return []
  const rows = await listDataRows(db, tableId)
  return rows
    .map((r): WebhookConfig => {
      const cells = (r.cells as Record<string, unknown>) ?? {}
      const eventsRaw = (cells.events as string) ?? ''
      const events = eventsRaw
        ? eventsRaw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
        : []
      return {
        id: r.id as string,
        name: (cells.title as string) ?? (r.slug as string) ?? '',
        url: (cells.url as string) ?? '',
        events,
        secret: (cells.secret as string) || null,
        enabled: cells.enabled !== false,
      }
    })
    .filter((w) => w.enabled && w.url.length > 0 && w.events.length > 0)
}

// ---------------------------------------------------------------------------
// Event matching
// ---------------------------------------------------------------------------

/**
 * Check whether a webhook's event subscriptions match a fired event.
 * Supports exact match, `"*"` wildcard ("match everything"), and
 * `"prefix.*"` wildcard (e.g. `"content.*"` matches `"content.entry.created"`).
 */
function webhookMatchesEvent(subscribed: string, event: string): boolean {
  if (subscribed === '*') return true
  if (subscribed === event) return true
  if (subscribed.endsWith('.*')) {
    const prefix = subscribed.slice(0, -2)
    return event.startsWith(prefix + '.')
  }
  return false
}

function filterMatchingWebhooks(webhooks: WebhookConfig[], event: string): WebhookConfig[] {
  return webhooks.filter((w) => w.events.some((s) => webhookMatchesEvent(s, event)))
}

// ---------------------------------------------------------------------------
// HMAC signing
// ---------------------------------------------------------------------------

/**
 * Create an HMAC-SHA256 signature for the webhook payload.
 * Uses the Web Crypto API (available in Bun).
 *
 * Output format: `sha256=<hex>` (GitHub-style).
 */
async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const hex = [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

// ---------------------------------------------------------------------------
// Delivery ID
// ---------------------------------------------------------------------------

let deliveryCounter = 0

function nextDeliveryId(): string {
  deliveryCounter += 1
  const ts = Date.now().toString(36)
  const seq = deliveryCounter.toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${seq}-${rand}`
}

// ---------------------------------------------------------------------------
// HTTP delivery
// ---------------------------------------------------------------------------

/**
 * POST the webhook payload to the target URL with retries.
 *
 * Headers sent:
 *   Content-Type:        application/json
 *   X-Instastic-Event:    the event name (e.g. "content.entry.created")
 *   X-Instastic-Delivery: unique delivery id for deduplication
 *   X-Instastic-Hook-Id:  webhook config id
 *   X-Instastic-Signature: HMAC-SHA256 signature (only if secret is set)
 */
async function deliverWebhook(
  webhook: WebhookConfig,
  payload: WebhookPayload,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  let lastError: string | undefined

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const body = JSON.stringify(payload)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Instastic-Event': payload.event,
        'X-Instastic-Delivery': payload.deliveryId,
        'X-Instastic-Hook-Id': webhook.id,
      }

      if (webhook.secret) {
        headers['X-Instastic-Signature'] = await signPayload(body, webhook.secret)
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })

        // 2xx = success (even 201/204 etc.)
        if (response.ok) {
          return { ok: true, status: response.status }
        }

        // Non-2xx but may still succeed on retry
        lastError = `HTTP ${response.status}`
      } finally {
        clearTimeout(timeout)
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  return { ok: false, error: lastError }
}

// ---------------------------------------------------------------------------
// Fire-and-forget dispatch
// ---------------------------------------------------------------------------

/**
 * Fire webhooks for an event payload. Runs async, never throws.
 * Each matching webhook is dispatched in parallel, with a concurrency cap
 * to avoid thundering-herd problems on large webhook registries.
 */
async function fireWebhooks(
  db: DbClient,
  event: WebhookEvent,
  data: unknown,
): Promise<void> {
  let webhooks: WebhookConfig[]
  try {
    webhooks = await getEnabledWebhooks(db)
  } catch (err) {
    console.error('[webhook] failed to load webhook configs:', err)
    return
  }

  const matched = filterMatchingWebhooks(webhooks, event)
  if (matched.length === 0) return

  // Semaphore-based concurrency cap
  const sem = new ConcurrencySemaphore(MAX_CONCURRENT)

  const results = await Promise.allSettled(
    matched.map((wh) =>
      sem.run(async () => {
        const deliveryId = nextDeliveryId()
        const payload: WebhookPayload = {
          event,
          deliveryId,
          timestamp: new Date().toISOString(),
          data,
        }

        const result = await deliverWebhook(wh, payload)

        if (!result.ok) {
          console.error(
            `[webhook] delivery failed: hook="${wh.name}" (${wh.id}) ` +
              `event="${event}" delivery="${deliveryId}" error="${result.error}"`,
          )
        }
      }),
    ),
  )

  const failed = results.filter((r) => r.status === 'rejected').length
  if (failed > 0) {
    console.error(`[webhook] ${failed} dispatch failures for event "${event}"`)
  }
}

// ---------------------------------------------------------------------------
// Concurrency semaphore (lightweight, no external deps)
// ---------------------------------------------------------------------------

class ConcurrencySemaphore {
  private running = 0
  private queue: (() => void)[] = []

  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.running++
    try {
      return await fn()
    } finally {
      this.running--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

/** True after `startWebhookDispatcher` has been called. */
let started = false

/**
 * Register webhook listeners on the hookBus. Idempotent — calling twice
 * is a no-op.
 *
 * Each listener fetches matching webhook configs from the DB and fires
 * async POSTs. The listener itself resolves immediately (before the
 * POSTs complete) so webhook delivery never blocks the event source.
 */
export function startWebhookDispatcher(db: DbClient): void {
  if (started) return
  started = true

  for (const event of ALL_WEBHOOK_EVENTS) {
    hookBus.on('__webhook__', event, (payload) => {
      // Fire-and-forget: the listen callback returns void immediately.
      // The async fire runs detached and errors are logged internally.
      void fireWebhooks(db, event, payload).catch((err) => {
        console.error(`[webhook] unhandled fire error for event "${event}":`, err)
      })
    })
  }

  console.log(`[webhook] dispatcher registered for ${ALL_WEBHOOK_EVENTS.length} events`)
}
