/**
 * Notification delivery — the core dispatcher.
 *
 * Listens to hook events from other plugins and routes them to:
 *   - SMTP email (default for human-facing events)
 *   - User-defined webhooks (for system-to-system integrations)
 *
 * Default templates are installed on activate for known events:
 *   - public-auth.userRegistered
 *   - public-auth.userLoggedIn
 *   - public-auth.passwordResetRequested
 *   - commerce.orderPaid
 *   - membership.subscriptionCanceled
 *
 * Variable substitution uses {{name}} syntax.
 */

import type { ApiCallContext } from '@instatic/plugin-sdk'
import {
  checkRecentDuplicate,
  findTemplate,
  listEnabledWebhooksForEvent,
  recordLog,
  recordWebhookDelivery,
  signWebhookPayload,
  upsertTemplate,
} from './store'
import { renderTemplate, sendEmail, type SmtpConfig } from './templates'
import { randomBytes } from 'node:crypto'

export interface NotificationSettings {
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPassword: string
  smtpFromAddress: string
  smtpFromName: string
  webhookRetries: number
  siteName: string
  siteUrl: string
}

const DEFAULT_TEMPLATES: Array<{ event: string; channel: 'email' | 'webhook'; subject: string; body: string; format: 'text' | 'html' | 'json' }> = [
  {
    event: 'public-auth.userRegistered',
    channel: 'email',
    subject: 'Welcome to {{siteName}}!',
    body: 'Hi {{displayName}},\n\nWelcome to {{siteName}}! Your account has been created.\n\nIf you didn\'t sign up, please ignore this email.',
    format: 'text',
  },
  {
    event: 'public-auth.userRegistered',
    channel: 'email',
    subject: 'Welcome to {{siteName}}!',
    body: '<h1>Welcome, {{displayName}}!</h1><p>Your account at {{siteName}} has been created.</p>',
    format: 'html',
  },
  {
    event: 'public-auth.passwordResetRequested',
    channel: 'email',
    subject: 'Reset your {{siteName}} password',
    body: 'Hi {{displayName}},\n\nWe received a request to reset your password. Click the link below to set a new password:\n\n{{siteUrl}}/reset-password?token={{resetToken}}\n\nThis link expires in 30 minutes. If you didn\'t request this, please ignore.',
    format: 'text',
  },
  {
    event: 'commerce.orderPaid',
    channel: 'email',
    subject: 'Order {{orderNumber}} confirmed',
    body: 'Hi {{displayName}},\n\nThanks for your order #{{orderNumber}}! Total: {{total}}.\n\nWe\'ll send a tracking link when your order ships.',
    format: 'text',
  },
  {
    event: 'membership.subscriptionCanceled',
    channel: 'email',
    subject: 'Your {{siteName}} subscription was canceled',
    body: 'Hi {{displayName}},\n\nYour subscription has been canceled. You\'ll continue to have access until {{expiresAt}}.',
    format: 'text',
  },
]

/**
 * Deliver a notification. Looks up the template, renders, sends, logs.
 * Dedup prevents double-delivery on hook event re-emission.
 */
export async function deliver(
  api: ApiCallContext,
  settings: NotificationSettings,
  event: string,
  recipient: string,
  vars: Record<string, unknown>,
  options: { dedupKey?: string; channel?: 'email' | 'webhook' } = {},
): Promise<void> {
  const dedupKey = options.dedupKey ?? randomBytes(8).toString('hex')
  const channel = options.channel ?? 'email'
  // Dedup window: 5 minutes
  if (await checkRecentDuplicate(api.db, event, recipient, dedupKey, 300)) {
    await recordLog(api.db, {
      event, channel, recipient, subject: null, body: null,
      status: 'dropped_duplicate', provider: null, providerMessageId: null,
      error: null, dedupKey, attempt: 1, deliveredAt: null,
    })
    return
  }
  const template = await findTemplate(api.db, event, channel, 'en')
  if (!template) {
    api.log.warn(`No template for ${event}/${channel}`)
    return
  }
  const ctxVars = { siteName: settings.siteName, siteUrl: settings.siteUrl, ...vars }
  const subject = renderTemplate(template.subject, ctxVars)
  const body = renderTemplate(template.body, ctxVars)
  const isHtml = template.format === 'html'
  let result: { status: 'sent' | 'failed'; messageId: string | null; error: string | null }
  if (channel === 'email') {
    if (!settings.smtpHost) {
      await recordLog(api.db, {
        event, channel, recipient, subject, body,
        status: 'failed', provider: 'smtp', providerMessageId: null,
        error: 'smtp_not_configured', dedupKey, attempt: 1, deliveredAt: null,
      })
      return
    }
    try {
      const smtp: SmtpConfig = {
        host: settings.smtpHost,
        port: settings.smtpPort,
        user: settings.smtpUser,
        password: settings.smtpPassword,
        fromAddress: settings.smtpFromAddress,
        fromName: settings.smtpFromName,
      }
      const { messageId } = await sendEmail(smtp, { to: recipient, subject, body, isHtml })
      result = { status: 'sent', messageId, error: null }
    } catch (err) {
      result = { status: 'failed', messageId: null, error: err instanceof Error ? err.message : String(err) }
    }
  } else {
    // webhook channel — POST to user-defined URLs
    result = await deliverToWebhooks(api, settings, event, subject, body, vars)
  }
  await recordLog(api.db, {
    event, channel, recipient, subject, body,
    status: result.status, provider: channel, providerMessageId: result.messageId,
    error: result.error, dedupKey, attempt: 1,
    deliveredAt: result.status === 'sent' ? new Date().toISOString() : null,
  })
}

async function deliverToWebhooks(
  api: ApiCallContext,
  settings: NotificationSettings,
  event: string,
  subject: string,
  body: string,
  vars: Record<string, unknown>,
): Promise<{ status: 'sent' | 'failed'; messageId: string | null; error: string | null }> {
  const webhooks = await listEnabledWebhooksForEvent(api.db, event)
  if (webhooks.length === 0) return { status: 'failed', messageId: null, error: 'no_subscribers' }
  const payload = JSON.stringify({ event, subject, body, vars, deliveredAt: new Date().toISOString() })
  let lastError: string | null = null
  for (const webhook of webhooks) {
    const maxAttempts = settings.webhookRetries + 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // The receiver's secret is stored as a hash; we can't sign without
        // the plaintext. In production, store the secret in plugin_secrets
        // instead. For this stub, we send an unsigned payload marked as
        // such; real signing is a TODO.
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-instatic-event': event,
            'x-instatic-webhook-id': webhook.id,
          },
          body: payload,
        })
        if (response.ok) {
          await recordWebhookDelivery(api.db, webhook.id, true, `HTTP ${response.status}`)
          return { status: 'sent', messageId: webhook.id, error: null }
        }
        lastError = `HTTP ${response.status}`
        // Don't retry on 4xx (client error, won't help)
        if (response.status >= 400 && response.status < 500) break
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
      // Exponential backoff between attempts
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt - 1)))
      }
    }
    await recordWebhookDelivery(api.db, webhook.id, false, lastError ?? 'failed')
  }
  return { status: 'failed', messageId: null, error: lastError }
}

// ─── Admin template CRUD ─────────────────────────────────────────────────

export async function handleAdminListTemplates(api: ApiCallContext): Promise<Response> {
  const { rows } = await api.db`select * from notification_templates order by event, channel, locale`
  return Response.json({ templates: rows })
}

export async function handleAdminUpsertTemplate(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const template = await upsertTemplate(api.db, {
    id: `tmpl_${randomBytes(6).toString('hex')}`,
    event: String(body.event ?? ''),
    channel: (body.channel as 'email' | 'sms' | 'webhook') ?? 'email',
    subject: String(body.subject ?? ''),
    body: String(body.body ?? ''),
    format: (body.format as 'text' | 'html' | 'json') ?? 'text',
    locale: String(body.locale ?? 'en'),
    enabled: body.enabled !== false,
  })
  return Response.json({ template })
}

export async function handleAdminListLog(api: ApiCallContext): Promise<Response> {
  const { rows } = await api.db`select * from notification_log order by created_at desc limit 200`
  return Response.json({ log: rows })
}

export async function handleAdminCreateWebhook(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { webhook, secret } = await (await import('./store')).createWebhook(api.db, {
    id: `wh_${randomBytes(6).toString('hex')}`,
    url: String(body.url ?? ''),
    secretHash: '',
    events: (body.events as string[]) ?? [],
    description: String(body.description ?? ''),
    enabled: body.enabled !== false,
  })
  return Response.json({ webhook, secret }, { status: 201 })
}