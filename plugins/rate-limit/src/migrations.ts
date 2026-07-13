/**
 * Plugin migrations for rate-limit.
 *
 * Sliding-window counters via a sorted log + periodic compaction.
 *   - Each request inserts one row (timestamp, bucket)
 *   - On each check, we count rows within the window
 *   - Compaction: rows older than the window are deleted lazily on the
 *     next request from the same bucket (cheap; no separate cron needed)
 *
 * This trades a bit of write amplification (one INSERT per request) for
 * sub-millisecond reads (single COUNT query). At 10k req/s, that's 10k
 * inserts/s; well within Postgres / SQLite write capacity.
 */

export default [
  {
    id: 'rate-limit.001_initial_schema',
    pgSql: `
      create table if not exists rate_limit_buckets (
        bucket_key text not null,
        hit_at timestamptz not null default now(),
        expires_at timestamptz not null
      );

      -- Compaction target: every read prunes old rows in the same query.
      create index if not exists rate_limit_buckets_lookup_idx
        on rate_limit_buckets (bucket_key, hit_at desc);

      create index if not exists rate_limit_buckets_expires_idx
        on rate_limit_buckets (expires_at);

      -- Custom buckets (path-prefix-specific limits, e.g. /api/auth/login)
      create table if not exists rate_limit_rules (
        id text primary key,
        path_prefix text not null unique,
        method text not null default 'ALL',
        requests integer not null,
        window_seconds integer not null,
        scope text not null default 'ip',
        description text not null default '',
        enabled boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint rate_limit_rules_scope_check
          check (scope in ('ip', 'user', 'ip+path', 'user+path'))
      );
    `,
    sqliteSql: `
      create table if not exists rate_limit_buckets (
        bucket_key text not null,
        hit_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at text not null
      );

      create index if not exists rate_limit_buckets_lookup_idx
        on rate_limit_buckets (bucket_key, hit_at desc);

      create index if not exists rate_limit_buckets_expires_idx
        on rate_limit_buckets (expires_at);

      create table if not exists rate_limit_rules (
        id text primary key,
        path_prefix text not null unique,
        method text not null default 'ALL',
        requests integer not null,
        window_seconds integer not null,
        scope text not null default 'ip',
        description text not null default '',
        enabled integer not null default 1,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint rate_limit_rules_scope_check
          check (scope in ('ip', 'user', 'ip+path', 'user+path'))
      );
    `,
  },
]