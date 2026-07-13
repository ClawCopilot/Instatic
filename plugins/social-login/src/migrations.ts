/**
 * Plugin migrations for social-login.
 *
 * Stores the (provider, provider_user_id) → public_user_id mapping.
 * One social user maps to one Instatic user (no multiple-account linking
 * in this version — that's a future enhancement).
 */

export default [
  {
    id: 'social-login.001_initial_schema',
    pgSql: `
      create table if not exists social_identities (
        id text primary key,
        user_id text not null,
        provider text not null,
        provider_user_id text not null,
        provider_email text,
        provider_display_name text,
        provider_avatar_url text,
        access_token text,
        refresh_token text,
        token_expires_at timestamptz,
        raw_profile_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (provider, provider_user_id)
      );

      create index if not exists social_identities_user_idx
        on social_identities (user_id);

      create index if not exists social_identities_email_idx
        on social_identities (provider, provider_email)
        where provider_email is not null;

      -- State tokens for CSRF defense on the OAuth flow. Short-lived
      -- (10 min), one-shot, scoped to a (provider, redirect_uri) tuple.
      create table if not exists social_auth_states (
        state text primary key,
        provider text not null,
        redirect_to text not null,
        nonce text not null,
        created_at timestamptz not null default now(),
        consumed_at timestamptz,
        expires_at timestamptz not null
      );

      create index if not exists social_auth_states_expires_idx
        on social_auth_states (expires_at);
    `,
    sqliteSql: `
      create table if not exists social_identities (
        id text primary key,
        user_id text not null,
        provider text not null,
        provider_user_id text not null,
        provider_email text,
        provider_display_name text,
        provider_avatar_url text,
        access_token text,
        refresh_token text,
        token_expires_at text,
        raw_profile_json text not null default '{}',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        unique (provider, provider_user_id)
      );

      create table if not exists social_auth_states (
        state text primary key,
        provider text not null,
        redirect_to text not null,
        nonce text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        consumed_at text,
        expires_at text not null
      );
    `,
  },
]