# @instatic/plugin-rate-limit

Per-IP and per-user rate limiting for public endpoints. Defends against brute force on login, signup, and API abuse.

## Features

- **Sliding window counters** — accurate, no fixed-window burst issue
- **Path-prefix rules** — most-specific match wins
- **Per-IP, per-user, per-IP+path, per-user+path** scoping
- **Standard headers** — `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`
- **Default rules** — installed on first activate (login/register/PW reset)
- **Lazy compaction** — expired bucket rows pruned on next request from same key
- **Trust proxy** — toggleable X-Forwarded-For reading

## Installation

1. Pack: `npm pack`
2. Upload via Instatic admin → Plugins
3. Approve permissions: `cms.migrations`, `cms.httpMiddleware`

## Default rules

| Path | Method | Limit | Window |
|---|---|---|---|
| `/api/auth/login` | POST | 10 | 15 min |
| `/api/auth/register` | POST | 10 | 15 min |
| `/api/auth/password-reset/request` | POST | 5 | 15 min |
| `/api/auth/verify-email` | POST | 10 | 15 min |
| `/api/keys/me` | GET | 300 | 1 min |

Other paths fall back to the `defaultLimit` setting (60/min per IP).

## Settings

- `defaultLimit` — fallback limit per IP per minute (default 60)
- `authLimit` — limit for /api/auth/* paths (default 10, applied via the default rules)
- `trustProxy` — when behind a reverse proxy, set to true to read `X-Forwarded-For`

## API

### Admin (require `users.manage`)

```http
GET    /api/admin/rate-limit/rules
POST   /api/admin/rate-limit/rules
DELETE /api/admin/rate-limit/rules/:id
```

### Create a custom rule

```http
POST /api/admin/rate-limit/rules
{
  "pathPrefix": "/api/commerce/checkout",
  "method": "POST",
  "requests": 5,
  "windowSeconds": 60,
  "scope": "user",
  "description": "Anti-abuse on checkout"
}
```

## Response headers (every throttled response)

```http
RateLimit-Limit: 60
RateLimit-Remaining: 42
RateLimit-Reset: 58
```

On 429:

```http
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 10
RateLimit-Remaining: 0
RateLimit-Reset: 847
Retry-After: 847
Content-Type: application/json

{
  "error": "rate_limited",
  "message": "Too many requests. Try again in 847 seconds.",
  "retryAfter": 847
}
```

## Database schema

```sql
create table rate_limit_buckets (
  bucket_key text not null,
  hit_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index rate_limit_buckets_lookup_idx on rate_limit_buckets (bucket_key, hit_at desc);
create index rate_limit_buckets_expires_idx on rate_limit_buckets (expires_at);

create table rate_limit_rules (
  id text primary key,
  path_prefix text not null unique,
  method text not null default 'ALL',
  requests integer not null,
  window_seconds integer not null,
  scope text not null default 'ip' check (scope in ('ip', 'user', 'ip+path', 'user+path')),
  description text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

## Algorithm

**Sliding window via per-request log**:
- Each request inserts one row into `rate_limit_buckets` with the bucket key
- On each check: count rows in the window, reject if count >= limit
- Lazy compaction: delete rows for this bucket older than the window before counting

**Tradeoff**: 1 INSERT per request. At 10k req/s that's 10k inserts/s — well within DB write capacity. Reads are O(rows in window) with the `(bucket_key, hit_at desc)` index — sub-millisecond.

## Security notes

- **Per-IP AND per-user** — bots on residential proxies still get per-user limit
- **Path-prefix specificity** — most specific match wins (longest prefix first)
- **No user-enumeration** — login attempts on missing users still consume the bucket
- **Constant-time check** — count + insert is two queries; total latency dominated by network
- **Trust proxy opt-in** — defaults to false to prevent IP spoofing via X-Forwarded-For
- **Defends login + register + password reset + verify-email** — the four most-abused public endpoints

## Performance

- ~1 INSERT + 1 COUNT per request
- Bucket index makes COUNT O(log n + window_size)
- Lazy compaction: 1 DELETE per request (only the deleted-by-expiry rows)
- For high-traffic services, consider sharding buckets by time window (TODO)

## License

MIT