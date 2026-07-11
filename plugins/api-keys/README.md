# @instatic/plugin-api-keys

API Key authentication and management for Instatic CMS. Issue, manage, and authenticate with scoped API keys for machine-to-machine access.

## Features

- **Capability-scoped tokens** — each key carries an explicit capability list
- **Two scopes**: `admin` (full CMS access) and `public` (custom capability subset)
- **Audit trail** — `last_used_at` + `last_used_ip` recorded on every authentication
- **SHA-256 hashed at rest** — plaintext token only returned at creation
- **Expiry** — optional `expiresInDays` (1–3650 days)
- **Revocation** — soft delete (`revoked_at`) preserves audit history

## Token Format

```
instk_<8-char-prefix>_<32-char-secret>
```

Example: `instk_a1b2c3d4_e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4`

The plaintext token is returned **exactly once** at creation. Store it securely.

## Installation

1. Pack: `npm pack` → produces `.tgz`
2. Upload via Instatic admin UI → Plugins
3. Approve permissions: `cms.migrations`, `cms.routes`, `cms.routes.public`, `cms.publicRoutes`

## API

### Admin endpoints (require `users.manage`)

```http
GET  /admin/api/cms/plugins/api-keys/runtime/admin/api/keys
POST /admin/api/cms/plugins/api-keys/runtime/admin/api/keys
DELETE /admin/api/cms/plugins/api-keys/runtime/admin/api/keys/:id
```

#### Create a key

```http
POST /admin/api/cms/plugins/api-keys/runtime/admin/api/keys
Content-Type: application/json

{
  "label": "Production API consumer",
  "scope": "public",
  "capabilities": ["content.read", "content.publish"],
  "expiresInDays": 365
}
```

Response (201):
```json
{
  "key": {
    "id": "k_abc123",
    "label": "Production API consumer",
    "scope": "public",
    "capabilities": ["content.read", "content.publish"],
    "expiresAt": "2027-07-11T...",
    "tokenPrefix": "instk_a1b2c3d4",
    "createdAt": "2026-07-11T..."
  },
  "token": "instk_a1b2c3d4_e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4"
}
```

### Public endpoint

```http
GET /api/keys/me
Authorization: Bearer instk_a1b2c3d4_e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4
```

Response (200):
```json
{
  "id": "k_abc123",
  "label": "Production API consumer",
  "scope": "public",
  "capabilities": ["content.read", "content.publish"],
  "expiresAt": "2027-07-11T..."
}
```

## Usage from another plugin

The api-keys plugin exposes a middleware resolver other plugins can use:

```typescript
import { resolveApiKey } from '@instatic/plugin-api-keys'

async function myHandler(req: Request, api: ApiCallContext) {
  const key = await resolveApiKey(api, req)
  if (!key) return new Response('Unauthorized', { status: 401 })
  // Use key.capabilities for fine-grained permission checks
}
```

## Database schema

```sql
create table api_keys (
  id text primary key,
  owner_user_id text not null references users(id) on delete cascade,
  label text not null,
  scope text not null check (scope in ('admin', 'public')),
  token_prefix text not null,
  token_hash text not null unique,
  capabilities_json jsonb not null default '[]',
  expires_at timestamptz,
  last_used_at timestamptz,
  last_used_ip text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

## Security notes

- Tokens have 160 bits of entropy (`8 + 32 hex chars` = 40 hex = 160 bits)
- We use SHA-256 because the input space is large; bcrypt/argon2 are unnecessary
- Constant-time comparison defends against timing attacks (defense in depth)
- Revocation is soft-delete — the row stays for audit purposes
- An expired or revoked token returns `invalid_token`, never `expired` (no oracle for enumeration)

## License

MIT