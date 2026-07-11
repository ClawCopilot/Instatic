/**
 * Plugin migrations for public-auth.
 *
 * Creates two tables:
 *   - public_users  : end-user identity (separate from the admin `users` table)
 *   - public_sessions : active access tokens (we keep a server-side allowlist
 *                     so revocation is instant — JWT alone can't be revoked
 *                     without rotating the signing secret)
 *
 * Password storage uses argon2id with the host's recommended parameters.
 * The `users.password_hash` admin table is intentionally NOT reused: admin
 * users and public users have different threat models, different lockout
 * policies, and different password rotation semantics.
 */

export default [
  {
    id: 'public-auth.001_initial_schema',
    pgSql: `
      create table if not exists public_users (
        id text primary key,
        email text not null,
        email_normalized text not null unique,
        display_name text not null,
        password_hash text not null,
        status text not null default 'active',
        email_verified_at timestamptz,
        failed_login_count integer not null default 0,
        locked_until timestamptz,
        last_login_at timestamptz,
        password_updated_at timestamptz not null default now(),
        metadata_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint public_users_status_check check (status in ('active', 'suspended', 'pending_verification'))
      );

      create index if not exists public_users_email_normalized_idx
        on public_users (email_normalized)
        where deleted_at is null;

      create table if not exists public_sessions (
        id text primary key,
        user_id text not null references public_users(id) on delete cascade,
        token_hash text not null unique,
        user_agent text,
        ip_address text,
        expires_at timestamptz not null,
        revoked_at timestamptz,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now()
      );

      create index if not exists public_sessions_user_idx
        on public_sessions (user_id, last_seen_at desc);

      create index if not exists public_sessions_token_hash_idx
        on public_sessions (token_hash);

      -- Email verification / password reset tokens. Short-lived (1h / 30min
      -- respectively) and one-shot (consumed_at enforces single use).
      create table if not exists public_verification_tokens (
        id text primary key,
        user_id text not null references public_users(id) on delete cascade,
        purpose text not null,
        token_hash text not null unique,
        expires_at timestamptz not null,
        consumed_at timestamptz,
        created_at timestamptz not null default now(),
        constraint public_verification_tokens_purpose_check
          check (purpose in ('email_verification', 'password_reset'))
      );

      create index if not exists public_verification_tokens_user_idx
        on public_verification_tokens (user_id, purpose);
    `,
    sqliteSql: `
      create table if not exists public_users (
        id text primary key,
        email text not null,
        email_normalized text not null unique,
        display_name text not null,
        password_hash text not null,
        status text not null default 'active',
        email_verified_at text,
        failed_login_count integer not null default 0,
        locked_until text,
        last_login_at text,
        password_updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        metadata_json text not null default '{}',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at text,
        constraint public_users_status_check check (status in ('active', 'suspended', 'pending_verification'))
      );

      create index if not exists public_users_email_normalized_idx
        on public_users (email_normalized)
        where deleted_at is null;

      create table if not exists public_sessions (
        id text primary key,
        user_id text not null references public_users(id) on delete cascade,
        token_hash text not null unique,
        user_agent text,
        ip_address text,
        expires_at text not null,
        revoked_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create index if not exists public_sessions_user_idx
        on public_sessions (user_id, last_seen_at desc);

      create index if not exists public_sessions_token_hash_idx
        on public_sessions (token_hash);

      create table if not exists public_verification_tokens (
        id text primary key,
        user_id text not null references public_users(id) on delete cascade,
        purpose text not null,
        token_hash text not null unique,
        expires_at text not null,
        consumed_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint public_verification_tokens_purpose_check
          check (purpose in ('email_verification', 'password_reset'))
      );

      create index if not exists public_verification_tokens_user_idx
        on public_verification_tokens (user_id, purpose);
    `,
  },
]