/**
 * Plugin migrations for oidc-provider.
 *
 * Tables:
 *   - oidc_clients      : OAuth client registrations (apps that can request tokens)
 *   - oidc_auth_codes   : short-lived authorization codes (one-time use, 10 min TTL)
 *   - oidc_access_tokens: issued access tokens (for introspection/revocation)
 *   - oidc_refresh_tokens: refresh tokens (rotation-tracked)
 *   - oidc_consents    : user's remembered scopes per client (skip-consent UX)
 *
 * Tokens are stored as SHA-256 hashes, same as the api-keys plugin.
 * The plaintext token only exists in the response payload at issue time.
 *
 * Authorization code flow:
 *   1. Client redirects user to /oauth/authorize?response_type=code&...
 *   2. User authenticates (via public-auth) and approves scopes
 *   3. Server redirects to client.redirect_uri with ?code=AUTH_CODE
 *   4. Client POSTs to /oauth/token with code + client credentials
 *   5. Server issues access_token (+ optional id_token + refresh_token)
 */

export default [
  {
    id: 'oidc-provider.001_initial_schema',
    pgSql: `
      create table if not exists oidc_clients (
        id text primary key,
        client_id text not null unique,
        client_secret_hash text,
        name text not null,
        description text not null default '',
        redirect_uris_json jsonb not null default '[]',
        allowed_scopes_json jsonb not null default '["openid","profile","email"]',
        allowed_grant_types_json jsonb not null default '["authorization_code","refresh_token"]',
        client_type text not null default 'confidential',
        require_pkce boolean not null default true,
        require_consent boolean not null default true,
        logo_url text,
        homepage_url text,
        metadata_json jsonb not null default '{}',
        disabled_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint oidc_clients_type_check
          check (client_type in ('confidential', 'public'))
      );

      create index if not exists oidc_clients_client_id_idx
        on oidc_clients (client_id);

      create table if not exists oidc_auth_codes (
        code_hash text primary key,
        client_id text not null references oidc_clients(client_id) on delete cascade,
        user_id text not null,
        redirect_uri text not null,
        scopes_json jsonb not null default '[]',
        code_challenge text,
        code_challenge_method text,
        nonce text,
        auth_time timestamptz not null,
        consumed_at timestamptz,
        expires_at timestamptz not null,
        created_at timestamptz not null default now()
      );

      create index if not exists oidc_auth_codes_expires_idx
        on oidc_auth_codes (expires_at);

      create table if not exists oidc_access_tokens (
        token_hash text primary key,
        client_id text not null references oidc_clients(client_id) on delete cascade,
        user_id text,
        scopes_json jsonb not null default '[]',
        expires_at timestamptz not null,
        revoked_at timestamptz,
        created_at timestamptz not null default now(),
        last_used_at timestamptz
      );

      create index if not exists oidc_access_tokens_expires_idx
        on oidc_access_tokens (expires_at);

      create index if not exists oidc_access_tokens_user_idx
        on oidc_access_tokens (user_id)
        where user_id is not null;

      create table if not exists oidc_refresh_tokens (
        token_hash text primary key,
        access_token_hash text,
        client_id text not null references oidc_clients(client_id) on delete cascade,
        user_id text,
        scopes_json jsonb not null default '[]',
        expires_at timestamptz not null,
        revoked_at timestamptz,
        rotated_from text,
        created_at timestamptz not null default now(),
        last_used_at timestamptz
      );

      create index if not exists oidc_refresh_tokens_user_idx
        on oidc_refresh_tokens (user_id)
        where user_id is not null;

      create table if not exists oidc_consents (
        id text primary key,
        user_id text not null,
        client_id text not null references oidc_clients(client_id) on delete cascade,
        scopes_json jsonb not null default '[]',
        granted_at timestamptz not null default now(),
        revoked_at timestamptz,
        unique (user_id, client_id)
      );

      create index if not exists oidc_consents_user_idx
        on oidc_consents (user_id);

      -- Token theft signals: when a refresh token is used twice (replay),
      -- we mark the family as suspicious and (optionally) lock the user.
      create table if not exists oidc_token_replay_signals (
        id text primary key,
        token_hash text not null,
        user_id text,
        client_id text not null,
        replayed_at timestamptz not null default now(),
        family_root_hash text not null,
        revoked_count integer not null,
        client_ip text,
        user_agent text,
        notes text
      );

      create index if not exists oidc_replay_signals_user_idx
        on oidc_token_replay_signals (user_id, replayed_at desc)
        where user_id is not null;
    `,
    sqliteSql: `
      create table if not exists oidc_clients (
        id text primary key,
        client_id text not null unique,
        client_secret_hash text,
        name text not null,
        description text not null default '',
        redirect_uris_json text not null default '[]',
        allowed_scopes_json text not null default '["openid","profile","email"]',
        allowed_grant_types_json text not null default '["authorization_code","refresh_token"]',
        client_type text not null default 'confidential',
        require_pkce integer not null default 1,
        require_consent integer not null default 1,
        logo_url text,
        homepage_url text,
        metadata_json text not null default '{}',
        disabled_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint oidc_clients_type_check
          check (client_type in ('confidential', 'public'))
      );

      create table if not exists oidc_auth_codes (
        code_hash text primary key,
        client_id text not null references oidc_clients(client_id) on delete cascade,
        user_id text not null,
        redirect_uri text not null,
        scopes_json text not null default '[]',
        code_challenge text,
        code_challenge_method text,
        nonce text,
        auth_time text not null,
        consumed_at text,
        expires_at text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create table if not exists oidc_access_tokens (
        token_hash text primary key,
        client_id text not null references oidc_clients(client_id) on delete cascade,
        user_id text,
        scopes_json text not null default '[]',
        expires_at text not null,
        revoked_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_used_at text
      );

      create table if not exists oidc_refresh_tokens (
        token_hash text primary key,
        access_token_hash text,
        client_id text not null references oidc_clients(client_id) on delete cascade,
        user_id text,
        scopes_json text not null default '[]',
        expires_at text not null,
        revoked_at text,
        rotated_from text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_used_at text
      );

      create table if not exists oidc_consents (
        id text primary key,
        user_id text not null,
        client_id text not null references oidc_clients(client_id) on delete cascade,
        scopes_json text not null default '[]',
        granted_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        revoked_at text,
        unique (user_id, client_id)
      );
    `,
  },
]