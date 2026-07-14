# @instatic/plugin-notifications

Multi-channel notification delivery. Consumes hook events from other plugins and delivers them via SMTP email or user-defined webhooks.

## Features

- **SMTP email delivery** — built-in minimal SMTP client (no native deps)
- **Webhook delivery** — user-defined outbound webhooks with retry + exponential backoff
- **Template engine** — per-event/per-channel/per-locale templates with `{{var}}` substitution
- **Dedup window** — 5-minute dedup key prevents double-delivery on hook replay
- **Delivery log** — every send recorded with status, provider response, errors
- **Default templates** — installed on first activate for common events
- **No-template fallback** — warns when no template is configured (doesn't crash)

## Installation

1. Set SMTP credentials + From address in plugin settings
2. (Optional) Set siteName + siteUrl — used in default email templates
3. Pack: `npm pack`
4. Upload via Instatic admin → Plugins

## Settings

### Required for email delivery

- `smtpHost` — e.g. `smtp.sendgrid.net`
- `smtpPort` — default 587
- `smtpUser` / `smtpPassword` — SMTP credentials
- `smtpFromAddress` — e.g. `noreply@example.com`
- `smtpFromName` — display name (default "Instatic")

### Optional

- `siteName` — interpolated into default templates as `{{siteName}}`
- `siteUrl` — interpolated into default templates as `{{siteUrl}}`
- `webhookRetries` — webhook delivery retries (default 3)

## Consumed events

| Event | Default template | Variables |
|---|---|---|
| `public-auth.userRegistered` | Welcome email | `displayName`, `verificationUrl` |
| `public-auth.passwordResetRequested` | Password reset link | `displayName`, `resetToken` |
| `commerce.orderPaid` | Order confirmation | `displayName`, `orderNumber`, `total` |
| `commerce.orderRefunded` | Refund confirmation | `displayName`, `orderNumber` |
| `membership.subscriptionCanceled` | Cancellation notice | `displayName`, `expiresAt` |

## Custom templates

```http
POST /api/admin/notifications/templates
{
  "event": "my-plugin.customEvent",
  "channel": "email",
  "format": "html",
  "locale": "en",
  "subject": "Hello {{name}}!",
  "body": "<h1>Welcome</h1><p>{{message}}</p>",
  "enabled": true
}
```

Variables use `{{name}}` syntax, case-sensitive, dot-notation for nested values:

```typescript
api.hooks.emit('my-plugin.customEvent', {
  user: { name: 'Alice', plan: 'gold' },
  message: 'You have a new message',
})
// → renders: <h1>Welcome</h1><p>You have a new message</p>
// → {{user.name}} → Alice, {{user.plan}} → gold
```

## Outbound webhooks

User-defined webhooks let external systems subscribe to Instatic events:

```http
POST /api/admin/notifications/webhooks
{
  "url": "https://my-app.com/webhook",
  "events": ["commerce.orderPaid", "public-auth.userRegistered"],
  "description": "Send events to my custom CRM"
}
```

→ `201 { webhook: {...}, secret: "whsec_..." }` (secret only returned at creation)

The webhook receives a POST:

```http
POST /my-app.com/webhook
Content-Type: application/json
X-Instatic-Event: commerce.orderPaid
X-Instatic-Webhook-Id: wh_abc123

{
  "event": "commerce.orderPaid",
  "subject": "Order #12345 confirmed",
  "body": "...",
  "vars": {...},
  "deliveredAt": "2026-07-13T..."
}
```

**HMAC signature** — outbound webhooks are signed with `X-Instatic-Signature: t=<unix>,v1=<hex>` (HMAC-SHA256). The plaintext secret is stored in `plugin_secrets`. Inbound webhooks are received at `POST /api/notifications/webhooks/:webhookId/inbound` with the same signature format and verified server-side.

## API

### Admin endpoints (require `users.manage`)

```http
GET  /api/admin/notifications/templates
POST /api/admin/notifications/templates
GET  /api/admin/notifications/log
POST /api/admin/notifications/webhooks
```

## Database schema

```sql
create table notification_templates (
  id text primary key,
  event text not null,
  channel text not null check (channel in ('email', 'sms', 'webhook')),
  subject text not null default '',
  body text not null,
  format text not null default 'text' check (format in ('text', 'html', 'json')),
  locale text not null default 'en',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event, channel, locale)
);

create table notification_log (
  id text primary key,
  event text not null,
  channel text not null,
  recipient text not null,
  subject text,
  body text,
  status text not null check (status in ('queued', 'sent', 'failed', 'dropped_duplicate')),
  provider text,
  provider_message_id text,
  error text,
  dedup_key text not null,
  attempt integer not null default 1,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create table notification_webhooks (
  id text primary key,
  url text not null,
  secret_hash text not null,
  events_json jsonb not null default '[]',
  description text not null default '',
  enabled boolean not null default true,
  last_delivery_at timestamptz,
  last_status text,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

## Security notes

- **Dedup window** prevents the same event from being sent twice within 5 minutes
- **Per-event templates** — a missing template logs a warning rather than crashing
- **Per-attempt logging** — every retry attempt is recorded in the log
- **No PII in logs** — only provider message id, error message, status; body is the rendered template
- **Constant-time template lookup** — N/A (no auth in template fetch)
- **SMTP credentials** — stored in plugin_secrets (encrypted at rest)
- **Webhook HMAC signature** — outbound signed with `X-Instatic-Signature`; inbound verified at `POST /api/notifications/webhooks/:webhookId/inbound`

## License

MIT