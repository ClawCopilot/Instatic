/**
 * Plugin migrations for notifications.
 *
 * Tables:
 *   - notification_templates : per-event named templates (subject + body + format)
 *   - notification_log       : append-only delivery log for debugging
 *   - notification_webhooks  : user-defined outbound webhook subscriptions
 *
 * The plugin's deliver() function is idempotent on (event, recipient, attempt)
 * via the log table — replays with the same dedup key within a short window
 * are dropped (defense against hook event re-emission).
 */

export default [
  {
    id: 'notifications.001_initial_schema',
    pgSql: `
      create table if not exists notification_templates (
        id text primary key,
        event text not null,
        channel text not null,
        subject text not null default '',
        body text not null,
        format text not null default 'text',
        locale text not null default 'en',
        enabled boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (event, channel, locale),
        constraint notification_templates_channel_check
          check (channel in ('email', 'sms', 'webhook')),
        constraint notification_templates_format_check
          check (format in ('text', 'html', 'json'))
      );

      create table if not exists notification_log (
        id text primary key,
        event text not null,
        channel text not null,
        recipient text not null,
        subject text,
        body text,
        status text not null,
        provider text,
        provider_message_id text,
        error text,
        dedup_key text not null,
        attempt integer not null default 1,
        created_at timestamptz not null default now(),
        delivered_at timestamptz,
        constraint notification_log_status_check
          check (status in ('queued', 'sent', 'failed', 'dropped_duplicate'))
      );

      -- Dedup index: same (event, recipient, dedup_key) within 5 minutes
      -- is treated as a replay and silently dropped.
      create index if not exists notification_log_dedup_idx
        on notification_log (event, recipient, dedup_key, created_at desc);

      create index if not exists notification_log_status_idx
        on notification_log (status, created_at desc);

      -- User-defined outbound webhooks. Each row subscribes to one or more
      -- events; on fire, the plugin POSTs the event payload to the URL with
      -- an HMAC signature header (so the receiver can verify).
      create table if not exists notification_webhooks (
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

      create index if not exists notification_webhooks_enabled_idx
        on notification_webhooks (enabled)
        where enabled = true;
    `,
    sqliteSql: `
      create table if not exists notification_templates (
        id text primary key,
        event text not null,
        channel text not null,
        subject text not null default '',
        body text not null,
        format text not null default 'text',
        locale text not null default 'en',
        enabled integer not null default 1,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        unique (event, channel, locale),
        constraint notification_templates_channel_check
          check (channel in ('email', 'sms', 'webhook')),
        constraint notification_templates_format_check
          check (format in ('text', 'html', 'json'))
      );

      create table if not exists notification_log (
        id text primary key,
        event text not null,
        channel text not null,
        recipient text not null,
        subject text,
        body text,
        status text not null,
        provider text,
        provider_message_id text,
        error text,
        dedup_key text not null,
        attempt integer not null default 1,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        delivered_at text,
        constraint notification_log_status_check
          check (status in ('queued', 'sent', 'failed', 'dropped_duplicate'))
      );

      create index if not exists notification_log_dedup_idx
        on notification_log (event, recipient, dedup_key, created_at desc);

      create index if not exists notification_log_status_idx
        on notification_log (status, created_at desc);

      create table if not exists notification_webhooks (
        id text primary key,
        url text not null,
        secret_hash text not null,
        events_json text not null default '[]',
        description text not null default '',
        enabled integer not null default 1,
        last_delivery_at text,
        last_status text,
        consecutive_failures integer not null default 0,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
]