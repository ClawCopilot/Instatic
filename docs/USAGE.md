# Usage Guide

End-to-end walkthrough: from a fresh clone to a working app.

## Existing documentation

If you're wondering "is there docs?":

| Doc | What's in it |
|---|---|
| [`docs/PLUGINS.md`](./PLUGINS.md) | Plugin bundle table, build commands, plugin file shape, SDK surface |
| [`docs/HOST_MODIFICATIONS.md`](./HOST_MODIFICATIONS.md) | The 5 host extensions (pluginMigrations, publicRoutes, httpMiddleware, viewerContext, contentGate) |
| [`packages/plugin-sdk/README.md`](../packages/plugin-sdk/README.md) | How to write a new plugin |
| `plugins/<name>/README.md` | Per-plugin API + setup (8 files) |
| `plugins/README.md` | Plugin bundle overview + use cases |
| `docs/deployment/*.md` | How to deploy the host to VPS, Docker, Render, Railway |

This file (`docs/USAGE.md`) is the missing piece: a step-by-step "first 30 minutes" guide.

## 1. Start the host

```bash
# Install deps
bun install

# Run the dev server (http://localhost:3000)
bun run dev
```

On first run, the host detects no owner user and redirects every request to `/admin` (the setup wizard). Walk through the wizard to create the **owner** account.

```bash
# Alternative: create the owner via the CLI (skips the wizard)
bun run scripts/create-owner.ts --email owner@example.com --password 'StrongP@ss123!'
```

## 2. Install a plugin

The host already knows about the 8 first-party plugins — you don't need to upload anything. Just configure them in the admin UI: **Plugins → [Plugin Name] → Settings**.

Or via the CLI:

```bash
# Set the public-auth JWT secret
curl -X POST http://localhost:3000/admin/api/cms/plugins/public-auth/settings \
  -H "Cookie: session=..." \
  -H "Content-Type: application/json" \
  -d '{"jwtSecret": "generate-32-random-chars-here", "accessTokenTtlSeconds": 3600}'
```

The plugin is **activated** the first time you call one of its endpoints. To manually activate via the admin UI: **Plugins → public-auth → Enable**.

## 3. Scenario: end-user registration (public-auth)

Once activated, the plugin exposes these endpoints automatically:

```bash
# Register a new user
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "password": "SecurePass123",
    "displayName": "Alice"
  }'

# → 201 { "userId": "usr_xxx", "status": "active" }
```

```bash
# Login (sets HttpOnly cookie automatically)
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{
    "email": "alice@example.com",
    "password": "SecurePass123"
  }'

# → 200 { "accessToken": "publ_xxx...", "user": {...}, "expiresAt": "..." }
```

```bash
# Authenticated request
curl http://localhost:3000/api/auth/me \
  -b cookies.txt

# → 200 { "user": { "id": "usr_xxx", "email": "...", ... } }
```

Browser code (any framework):

```html
<form id="login">
  <input name="email" type="email" />
  <input name="password" type="password" />
  <button>Sign in</button>
</form>
<script>
document.getElementById('login').onsubmit = async (e) => {
  e.preventDefault()
  const form = new FormData(e.target)
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: form.get('email'),
      password: form.get('password'),
    }),
    credentials: 'include',  // important: include cookies
  })
  if (res.ok) location.href = '/dashboard'
}
</script>
```

The `viewerContext` provider is auto-installed, so any template can read:

```html
{{#if viewer.loggedIn}}
  Welcome back, {{viewer.displayName}}!
{{/if}}
```

## 4. Scenario: paid membership

Activate `membership` + `public-auth` (the second is required — membership reads `viewer.userId` from public-auth's viewer frame).

### 4.1. Configure Stripe (optional, for paid tiers)

In the admin UI: **Plugins → membership → Settings**:
- `stripeSecretKey` — `sk_test_...` from Stripe Dashboard
- `stripeWebhookSecret` — `whsec_...` from Stripe webhook config
- `freeShippingThresholdCents` — 0 for no free shipping

In Stripe Dashboard → Webhooks, add endpoint `https://yourhost/api/membership/stripe/webhook` with events `customer.subscription.created/updated/deleted`.

### 4.2. Create a membership tier

```bash
curl -X POST http://localhost:3000/admin/api/commerce/coupons/.../admin/api/membership/tiers \
  -H "Cookie: session=..." \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "premium",
    "name": "Premium",
    "rank": 10,
    "priceCents": 999,
    "currency": "USD",
    "billingInterval": "month",
    "features": ["All posts", "Newsletter"]
  }'
```

### 4.3. Mark content as gated

In any data row, add a `text` field named `requiresTier` (one-time setup via the data table editor). Set it to `"premium"`. The membership plugin's content gate kicks in on render.

### 4.4. Subscribe a user

```bash
# User starts a subscription
curl -X POST http://localhost:3000/api/membership/subscribe \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{ "tierSlug": "premium" }'

# → 200 { "subscriptionId": "sub_xxx", "status": "active" }
# OR (if Stripe is configured)
# → 201 { "checkoutUrl": "https://checkout.stripe.com/..." }
```

After payment, the user's viewerContext gets `tier: "premium"`, `tierRank: 10`. Gated content automatically becomes visible.

## 5. Scenario: online store

Activate `commerce` (+ optional `notifications` for order emails).

### 5.1. Create products

Products are data rows in the `products` table (auto-created by commerce on first activate). In the admin UI: **Content → Products → New**.

Each product has: title, slug, priceCents, currency, image, description, trackInventory, availableQuantity.

### 5.2. Add to cart, checkout

```bash
# Add item to cart
curl -X POST http://localhost:3000/api/commerce/cart/items \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{ "productId": "prd_xxx", "quantity": 2 }'

# Reserve stock (15-min hold) — call this before checkout
curl -X POST http://localhost:3000/api/commerce/cart/reserve \
  -b cookies.txt
# → 200 { "reservations": [...], "expiresInSeconds": 900 }

# Apply coupon
curl -X POST http://localhost:3000/api/commerce/coupons/validate \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "code": "SAVE10",
    "subtotalCents": 5000,
    "items": [{"productId": "prd_xxx", "productSlug": "shirt", "priceCents": 5000}]
  }'
# → 200 { "valid": true, "discountCents": 500 }

# Get shipping quote
curl -X POST http://localhost:3000/api/commerce/shipping/quote \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{ "countryCode": "US", "subtotalCents": 5000, "weightGrams": 500 }'
# → 200 { "costCents": 999, "method": "rate-table" }

# Checkout (requires Stripe)
curl -X POST http://localhost:3000/api/commerce/checkout \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "email": "alice@example.com",
    "shippingAddress": { "line1": "123 Main St", "city": "Springfield", "country": "US" }
  }'
# → 201 { "orderId": "ord_xxx", "checkoutUrl": "https://checkout.stripe.com/..." }
```

## 6. Scenario: OIDC identity provider

Activate `oidc-provider`. Then in the admin UI: **Plugins → OIDC Provider → Clients → New**:

```bash
curl -X POST http://localhost:3000/admin/api/oidc/clients \
  -H "Cookie: session=..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Mobile App",
    "redirectUris": ["myapp://callback"],
    "allowedScopes": ["openid", "profile", "email"]
  }'
# → 201 { "client": {...}, "clientSecret": "..." }
```

Then from your mobile app:

```
GET /oauth/authorize?
  response_type=code&
  client_id=<client_id>&
  redirect_uri=myapp://callback&
  scope=openid+profile+email&
  state=xyz&
  code_challenge=<base64url(sha256(verifier))>&
  code_challenge_method=S256
```

User logs in via public-auth (auto-redirects), approves consent, gets redirected back:

```
myapp://callback?code=AUTH_CODE&state=xyz
```

Exchange the code:

```bash
curl -X POST https://yourhost/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=AUTH_CODE" \
  -d "redirect_uri=myapp://callback" \
  -d "client_id=<client_id>" \
  -d "client_secret=<client_secret>" \
  -d "code_verifier=<original_verifier>"

# → { "access_token": "...", "id_token": "...", "refresh_token": "...", ... }
```

## 7. Scenario: social login (Google)

Activate `social-login` and `public-auth`. In admin UI: **Plugins → Social Login → Settings**, set `googleClientId` / `googleClientSecret` (from Google Cloud Console).

In your login page:

```html
<a href="/api/auth/social/google?redirect_to=/dashboard">
  <img src="/google-signin.png" alt="Sign in with Google">
</a>
```

The plugin walks the user through Google's OAuth, creates a public_users row if needed, sets a session cookie, and redirects to `redirect_to`. No code in your login page beyond the `<a>`.

## 8. Scenario: rate-limited login

Activate `rate-limit` — that's it. The plugin auto-installs the right rule:

| Path | Method | Limit | Window |
|---|---|---|---|
| `/api/auth/login` | POST | 10 | 15 min |
| `/api/auth/register` | POST | 10 | 15 min |
| `/api/auth/password-reset/request` | POST | 5 | 15 min |

After 10 failed login attempts in 15 min, the IP gets a 429. No config needed.

## 9. Scenario: transactional email

Activate `notifications` + configure SMTP in its settings. Subscribe by listening to public-auth's events in your own plugin:

```ts
api.hooks.on('public-auth.passwordResetRequested', async (payload) => {
  await deliverEmail({
    to: payload.email,
    subject: 'Reset your password',
    body: `Click: ${payload.resetUrl}`,
  })
})
```

The `notifications` plugin ships default templates for the common events — see `plugins/notifications/README.md` for the full list of customisable templates.

## 10. Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| "no default export with activate()" | Plugin file uses old `definePlugin({...activate})` pattern | Refactor: `export default definePlugin({...})` + `export async function activate()` |
| Plugin id must be namespaced | SDK requires `vendor.name` format | Rename: `api-keys` → `instatic.api-keys` |
| Spread syntax requires ...iterable | `permissions: [...config.permissions]` with `config.permissions === undefined` | Add `permissions: []` to definePlugin call |
| 401 on plugin endpoint | Plugin requires capability the caller doesn't have | Check `api.cms.routes.register(path, 'users.manage', ...)` — that's the gate |
| Migration not applied | Plugin's `install()` wasn't called | `bun run scripts/build-plugins.ts` to rebuild, then re-upload |
| `viewer.tier` is undefined in template | Two plugins' viewerContext providers conflict | Check `viewerContext.register()` priority — last one wins per key |
| `viewer` not bound in template | Template syntax | Use `{viewer.tier}` (curly braces) for token, or `viewer.tier` for binding source |

## 11. Where to go from here

- **Add a new plugin**: see [`packages/plugin-sdk/README.md`](../packages/plugin-sdk/README.md)
- **Deploy to production**: see [`docs/deployment/`](./deployment/)
- **Understand the host extensions**: see [`docs/HOST_MODIFICATIONS.md`](./HOST_MODIFICATIONS.md)
- **Run the test suite**: `bun test plugins/` and `bun run test:plugins`
