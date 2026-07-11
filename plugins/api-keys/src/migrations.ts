/**
 * Plugin migrations for api-keys.
 *
 * Creates the `api_keys` table for storing key metadata (token hashes, capabilities,
 * expiry, audit fields). Tokens themselves are NEVER stored in plaintext — only
 * their SHA-256 hashes plus a short plaintext prefix for visual identification
 * ("instk_a1b2c3d4...").
 *
 * Two scopes are supported:
 *   - 'admin'   — full capability grant, requires users.manage to create
 *   - 'public'  — empty capability set by default; plugin author may attach
 *                 capabilities via the create endpoint
 *
 * The 'public' scope is meant for embedding into client-side code or for use
 * by services that don't have admin session credentials. Public-scope keys
 * can have any subset of core capabilities attached.
 */

export default [
  {
    id: 'api-keys.001_initial_schema',
    pgSql: `
      create table if not exists api_keys (
        id text primary key,
        owner_user_id text not null references users(id) on delete cascade,
        label text not null,
        scope text not null,
        token_prefix text not null,
        token_hash text not null unique,
        capabilities_json jsonb not null default '[]',
        expires_at timestamptz,
        last_used_at timestamptz,
        last_used_ip text,
        revoked_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint api_keys_scope_check check (scope in ('admin', 'public'))
      );

      create index if not exists api_keys_owner_idx
        on api_keys (owner_user_id, created_at desc)
        where revoked_at is null;

      create index if not exists api_keys_token_hash_idx
        on api_keys (token_hash);
    `,
    sqliteSql: `
      create table if not exists api_keys (
        id text primary key,
        owner_user_id text not null references users(id) on delete cascade,
        label text not null,
        scope text not null,
        token_prefix text not null,
        token_hash text not null unique,
        capabilities_json text not null default '[]',
        expires_at text,
        last_used_at text,
        last_used_ip text,
        revoked_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint api_keys_scope_check check (scope in ('admin', 'public'))
      );

      create index if not exists api_keys_owner_idx
        on api_keys (owner_user_id, created_at desc)
        where revoked_at is null;

      create index if not exists api_keys_token_hash_idx
        on api_keys (token_hash);
    `,
  },
]