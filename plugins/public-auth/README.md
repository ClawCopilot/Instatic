# @instatic/plugin-public-auth

Public-facing user authentication for Instatic sites. End-users (visitors) can register, log in, log out, verify their email, and reset their passwords. The plugin exposes a `viewerContext` provider so downstream plugins (membership, commerce) can identify the current user.

## Features

- **Argon2id password hashing** (~50ms / hash, resistant to GPU attacks)
- **JWT access tokens** (HS256, per-installation secret)
- **Server-side session allowlist** for instant revocation
- **HttpOnly cookies** for browser flows, Bearer tokens for mobile/API
- **Account lockout** after 5 failed login attempts (15 min)
- **Email verification** + password reset flows (token-based, 30 min TTL)
- **Hook events** for notifications plugin integration:
  - `public-auth.userRegistered`
  - `public-auth.userLoggedIn`
  - `public-auth.passwordResetRequested`

## Installation

1. Set the `jwtSecret` setting (random ≥32 char string)
2. Pack: `npm pack`
3. Upload via Instatic admin → Plugins
4. Approve permissions: `cms.migrations`, `cms.routes`, `cms.routes.public`, `cms.publicRoutes`, `network.outbound`

## API

All endpoints are public (no auth required, except `/me`, `/logout`, `/refresh`).

### Register

```http
POST /api/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securePass123",
  "displayName": "Jane Doe"
}
```

→ `201 { userId, status: "active" }`
→ `409 { error: "email_in_use" }` if taken

### Login

```http
POST /api/auth/login
Content-Type: application/json

{ "email": "user@example.com", "password": "securePass123" }
```

→ `200 { accessToken, user: {...}, expiresAt }`
  Sets HttpOnly cookie `public_auth_token` for browser flows.

### Logout

```http
POST /api/auth/logout
Authorization: Bearer publ_...
```

→ `204`

### Refresh

```http
POST /api/auth/refresh
```

→ `200 { accessToken, expiresAt }` (old token revoked)

### Me

```http
GET /api/auth/me
Authorization: Bearer publ_...
```

→ `200 { user: { id, email, displayName, emailVerified, status } }`

### Verify email

```http
POST /api/auth/verify-email
{ "token": "<token from email>" }
```

→ `200 { verified: true }`

### Password reset

```http
POST /api/auth/password-reset/request
{ "email": "user@example.com" }   # always returns 200
```

```http
POST /api/auth/password-reset/confirm
{ "token": "<token from email>", "newPassword": "newSecurePass456" }
```

## Viewer context

The plugin registers a `viewerContext` provider. After login, every page render includes:

```json
{
  "loggedIn": true,
  "userId": "usr_...",
  "email": "user@example.com",
  "displayName": "Jane Doe",
  "emailVerified": true,
  "status": "active"
}
```

Templates can use `{viewer.loggedIn}` / `{viewer.email}` tokens or `{viewer.displayName}` in dynamic bindings.

## Downstream plugin integration

The `membership`, `commerce`, and `oidc-provider` plugins all read `viewer.userId` from this plugin's viewer frame.

```typescript
import { resolveUserFromRequest } from '@instatic/plugin-public-auth'

const user = await resolveUserFromRequest(api, req, settings)
if (user) {
  // Look up their subscription tier, orders, etc.
}
```

## Database schema

```sql
create table public_users (
  id text primary key,
  email text not null,
  email_normalized text not null unique,
  display_name text not null,
  password_hash text not null,
  status text not null check (status in ('active', 'suspended', 'pending_verification')),
  email_verified_at timestamptz,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  password_updated_at timestamptz not null default now(),
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public_sessions (
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

create table public_verification_tokens (
  id text primary key,
  user_id text not null references public_users(id) on delete cascade,
  purpose text not null check (purpose in ('email_verification', 'password_reset')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
```

## Security notes

- **Argon2id** at 19 MiB / 2 iterations / 1 parallelism — meets OWASP 2024 guidance
- **JWT + session allowlist** — JWT alone can't be revoked; the session row gives us "log out everywhere"
- **Lockout** — 5 failures in 15 min; auto-release
- **No user enumeration** — login always returns 401 for missing/bad credentials; password reset always returns 200
- **HttpOnly + SameSite=Lax cookies** — CSRF defense + XSS token theft defense
- **Constant-time** — verifyPassword runs even on missing user to prevent timing oracle
- **One-shot verification tokens** — consumed_at prevents replay
- **Password update invalidates all sessions** — defense against stolen session cookies

## License

MIT