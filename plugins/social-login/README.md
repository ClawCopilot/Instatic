# @instatic/plugin-social-login

Bridges third-party OAuth identity providers into the Instatic public-auth + oidc-provider flow.

## Supported providers

| Provider | Scopes | Account linking |
|---|---|---|
| **Google** | `openid email profile` | By email (if verified) |
| **GitHub** | `read:user user:email` | By primary email |
| **Apple** | `name email` | By email (Apple private relay) |
| **WeChat** | `snsapi_login` | No email — links by unionid/openid |

## Installation

1. Create OAuth apps with each provider (Google Cloud Console, GitHub Developer Settings, Apple Developer Portal, WeChat Open Platform)
2. Set redirect URIs to `https://<your-host>/api/auth/social/<provider>/callback`
3. Configure plugin settings with client IDs + secrets
4. Set `enabledProviders` to a comma-separated list
5. Pack: `npm pack`
6. Upload via Instatic admin → Plugins

## Setup per provider

### Google

1. https://console.cloud.google.com/apis/credentials → Create OAuth 2.0 Client ID
2. Application type: Web application
3. Authorized redirect URIs: `https://<host>/api/auth/social/google/callback`
4. Copy Client ID + Client Secret to plugin settings

### GitHub

1. https://github.com/settings/developers → New OAuth App
2. Authorization callback URL: `https://<host>/api/auth/social/github/callback`
3. Request user email access (settings → User email address visibility)
4. Copy Client ID + Client Secret

### Apple (Sign in with Apple)

1. Apple Developer Portal → Certificates, Identifiers & Profiles
2. Create a Services ID (identifier like `com.example.signin`)
3. Enable "Sign in with Apple", configure redirect URI
4. Create a private key (.p8) for "Sign in with Apple"
5. Copy: Client ID (= Services ID), Team ID, Key ID, private key PEM
6. **Note**: Apple's first sign-in only returns the user's name + email in the
   id_token. After that, only `sub` is returned. The plugin stores the raw
   id_token claims on first sign-in.

### WeChat (网页授权)

1. https://open.weixin.qq.com → Web应用 → Get AppID + AppSecret
2. Authorize callback domain: configure `<your-host>` (no scheme)
3. Copy AppID + AppSecret

## API

### Public endpoints

```http
GET /api/auth/social/google?redirect_to=/dashboard
GET /api/auth/social/github?redirect_to=/dashboard
GET /api/auth/social/apple?redirect_to=/dashboard
GET /api/auth/social/wechat?redirect_to=/dashboard
GET /api/auth/social/<provider>/callback    (GET or POST for Apple)
```

### Admin endpoints (require `users.manage` or `authenticated`)

```http
GET    /api/admin/social/identities
DELETE /api/admin/social/identities/:provider
```

## Database schema

```sql
create table social_identities (
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
  raw_profile_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_user_id)
);

create table social_auth_states (
  state text primary key,
  provider text not null,
  redirect_to text not null,
  nonce text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  expires_at timestamptz not null
);
```

## Security notes

- **State tokens** prevent CSRF — 10-min TTL, one-shot consumption
- **Email-based account linking** — if the social email matches an existing
  password-based user, accounts are linked (no duplicate accounts)
- **Unverified emails** — social emails are trusted if the provider confirms
  verification; Apple private relay emails are flagged as `email_verified_at = null`
- **Access tokens stored** — for future API calls on behalf of the user
  (e.g. fetch more profile data); encrypted at rest via DB secrets
- **Auto-provisioned users** — random unusable password hash; only social
  login works for them (defense in depth)
- **Provider-side rate limits** — Apple 1000 req/min, Google 10k/100s, GitHub 5000/h
- **TODO**: refresh-token rotation on WeChat (wechat access tokens expire 2h)

## License

MIT