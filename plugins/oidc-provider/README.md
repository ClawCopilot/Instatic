# @instatic/plugin-oidc-provider

OAuth 2.0 Authorization Server + OpenID Connect Provider for Instatic. Issue ID/access/refresh tokens to third-party applications. Built on `@instatic/plugin-public-auth` for end-user identity.

## Features

- **Authorization Code flow** with PKCE (RFC 7636)
- **Refresh token rotation** (one-time use, automatic revocation chain)
- **Client Credentials grant** (machine-to-machine)
- **Discovery document** (`/.well-known/openid-configuration`)
- **JWKS** (`/.well-known/jwks.json`) — public signing keys
- **Token introspection** (RFC 7662)
- **Token revocation** (RFC 7009)
- **RP-initiated logout** (OpenID Connect Session Management 1.0)
- **RS256 JWT signing** — auto-generated key pair, persisted encrypted
- **Per-client scope + grant type allowlists**
- **Public + confidential client types**
- **User consent screen** — first-time scopes require approval; remembered per (user, client)

## Installation

1. Install dependencies: `@instatic/plugin-public-auth`
2. Set the `issuer` setting to your publicly-resolvable URL (e.g. `https://auth.example.com`)
3. Pack: `npm pack`
4. Upload via Instatic admin → Plugins
5. Approve permissions: `cms.migrations`, `cms.routes`, `cms.routes.public`, `cms.publicRoutes`, `cms.hooks`, `network.outbound`

## Configuration

### Required setting

- **issuer**: Public URL of the OIDC provider (used in `iss` claim + discovery)

### Optional settings

- **accessTokenTtlSeconds**: Default 3600 (1 hour)
- **refreshTokenTtlSeconds**: Default 2592000 (30 days)
- **idTokenTtlSeconds**: Default 3600 (1 hour)
- **authCodeTtlSeconds**: Default 600 (10 minutes)
- **requirePkce**: Default true (recommended)

## Registering a client

```http
POST /admin/api/cms/plugins/oidc-provider/runtime/admin/api/oidc/clients
Content-Type: application/json
Cookie: <admin session>

{
  "name": "My Mobile App",
  "clientType": "public",
  "redirectUris": ["https://myapp.com/callback", "myapp://callback"],
  "allowedScopes": ["openid", "profile", "email", "offline_access"],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "requirePkce": true,
  "requireConsent": true
}
```

→ `201 { client: {...}, clientSecret: "..." }` (secret only returned at creation for confidential clients)

## OAuth 2.0 / OIDC flow

### 1. Authorization request

```http
GET /oauth/authorize?
  response_type=code&
  client_id=myapp&
  redirect_uri=https://myapp.com/callback&
  scope=openid+profile+email+offline_access&
  state=xyz123&
  code_challenge=<base64url(sha256(verifier))>&
  code_challenge_method=S256&
  nonce=abc456
```

User is redirected to login (if needed) → consent screen → redirected back:

```
https://myapp.com/callback?code=AUTH_CODE&state=xyz123
```

### 2. Token exchange

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <base64(client_id:client_secret)>

grant_type=authorization_code&
code=AUTH_CODE&
redirect_uri=https://myapp.com/callback&
code_verifier=ORIGINAL_VERIFIER
```

→ `200 { access_token, id_token, refresh_token, token_type: "Bearer", expires_in: 3600, scope: "..." }`

### 3. Refresh

```http
POST /oauth/token
Authorization: Basic <base64(client_id:client_secret)>

grant_type=refresh_token&
refresh_token=OLD_REFRESH_TOKEN
```

→ new tokens (old refresh token is revoked, rotated)

### 4. Userinfo

```http
GET /oauth/userinfo
Authorization: Bearer ACCESS_TOKEN
```

→ `200 { sub, email, email_verified, name, preferred_username }`

### 5. Logout

```http
GET /oauth/logout?post_logout_redirect_uri=https://myapp.com/goodbye&state=xyz123
```

## Discovery document

`GET /.well-known/openid-configuration` returns:

```json
{
  "issuer": "https://auth.example.com",
  "authorization_endpoint": "https://auth.example.com/oauth/authorize",
  "token_endpoint": "https://auth.example.com/oauth/token",
  "userinfo_endpoint": "https://auth.example.com/oauth/userinfo",
  "jwks_uri": "https://auth.example.com/.well-known/jwks.json",
  "response_types_supported": ["code"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "scopes_supported": ["openid", "profile", "email", "offline_access"],
  "code_challenge_methods_supported": ["S256", "plain"],
  ...
}
```

## Social login

Social login is provided by a separate `@instatic/plugin-social-login` plugin:
1. Adds `/api/auth/social/:provider` route
2. Implements the OAuth flow with external providers (Google/GitHub/Apple/WeChat)
3. Auto-creates a `public_users` row on first social login
4. Links social identity to existing public-auth account by email

## Database schema

```sql
create table oidc_clients (
  id text primary key,
  client_id text not null unique,
  client_secret_hash text,
  name text not null,
  redirect_uris_json jsonb not null default '[]',
  allowed_scopes_json jsonb not null default '["openid","profile","email"]',
  allowed_grant_types_json jsonb not null default '["authorization_code","refresh_token"]',
  client_type text not null default 'confidential' check (client_type in ('confidential', 'public')),
  require_pkce boolean not null default true,
  require_consent boolean not null default true,
  logo_url text, homepage_url text, metadata_json jsonb not null default '{}',
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table oidc_auth_codes (
  code_hash text primary key,
  client_id text not null references oidc_clients(client_id) on delete cascade,
  user_id text not null,
  redirect_uri text not null,
  scopes_json jsonb not null default '[]',
  code_challenge text, code_challenge_method text,
  nonce text,
  auth_time timestamptz not null,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table oidc_access_tokens (
  token_hash text primary key,
  client_id text not null references oidc_clients(client_id) on delete cascade,
  user_id text,
  scopes_json jsonb not null default '[]',
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table oidc_refresh_tokens (
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

create table oidc_consents (
  id text primary key,
  user_id text not null,
  client_id text not null references oidc_clients(client_id) on delete cascade,
  scopes_json jsonb not null default '[]',
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, client_id)
);
```

## Security notes

- **PKCE enforced** for public clients (and configurable for confidential)
- **Refresh token rotation** — old token revoked on first use; replay detection logs to `oidc_token_replay_signals` and rate-limits the client (5+ replays/hour = 429)
- **Single-use auth codes** — atomic UPDATE with `consumed_at IS NULL` predicate
- **RS256 signing keys** — generated on first activate, persisted encrypted
- **Constant-time client_secret comparison** via SHA-256 hash (defense in depth)
- **CSRF state parameter** required for authorization requests
- **Consent UI** shows scopes before issuing code
- **Logout** clears the public-auth session cookie

## Comparison to Logto

| Feature | Logto | This plugin |
|---|---|---|
| Authorization Code + PKCE | ✅ | ✅ |
| Refresh token rotation | ✅ | ✅ |
| Discovery + JWKS | ✅ | ✅ |
| Client Credentials | ✅ | ✅ |
| Social login | ✅ | ❌ (separate plugin) |
| SAML | ✅ | ❌ |
| Multi-factor auth | ✅ | ❌ |
| User impersonation | ✅ | ❌ |
| Org / tenancy | ✅ | ❌ |
| Custom domains | ✅ | ❌ |
| Audit log UI | ✅ | ❌ |

This plugin covers the **core OIDC protocol surface** in ~600 lines. Social login, MFA, org/tenancy, etc. should be separate plugins that compose with this one.

## License

MIT