# @instatic/plugin-membership

Tiered memberships, subscriptions, and content paywalls for Instatic. Built on `@instatic/plugin-public-auth` for end-user identity.

## Features

- **Tier catalog** with display order, rank, price, billing interval
- **Subscription lifecycle** — trialing → active → past_due → canceled (with grace period)
- **Stripe integration** (optional) — creates Checkout Sessions, syncs subscription state via webhooks
- **Manual mode** — admins manage subscriptions directly when Stripe isn't configured
- **viewerContext provider** — exposes `{ tier, tierRank, expiresAt }` to templates and gates
- **contentGate** — paywalls rows whose `cells.requiresTier` is set

## Installation

1. Install dependencies: `@instatic/plugin-public-auth`
2. (Optional) Configure Stripe webhook in plugin settings
3. Pack: `npm pack`
4. Upload via Instatic admin → Plugins
5. Approve permissions

## Setting up paywalls

### 1. Create tiers

```http
POST /admin/api/cms/plugins/membership/runtime/admin/api/membership/tiers
Content-Type: application/json
Cookie: <admin session>

{
  "slug": "premium",
  "name": "Premium",
  "rank": 10,
  "priceCents": 999,
  "currency": "USD",
  "billingInterval": "month",
  "features": ["All posts", "Member-only posts", "Newsletter"],
  "isPublic": true
}
```

### 2. Mark rows as gated

In the content table definition, add a `text` field called `requiresTier`:

```json
{
  "type": "text",
  "id": "requiresTier",
  "label": "Required tier",
  "description": "Members-only content: set to a tier slug (e.g. 'premium')"
}
```

Edit a row → set `requiresTier = "premium"` → publish.

### 3. Visitor experience

- **Anonymous visitor** visits a `requiresTier=premium` row → redirected to `/login?next=...`
- **Free-tier visitor** visits a `requiresTier=premium` row → redirected to `/pricing`
- **Premium subscriber** sees the row normally

### Template gating

Use viewer tokens for in-template gating:

```html
{{#if (gte viewer.tierRank 10)}}
  <a href="/members-only-resource">Download PDF</a>
{{/if}}
```

## API

### Public endpoints

```http
GET  /api/membership/tiers
GET  /api/membership/me/subscription
POST /api/membership/subscribe       { tierSlug }
POST /api/membership/cancel
POST /api/membership/stripe/webhook  (Stripe-signed)
```

### Admin endpoints

```http
GET    /admin/api/cms/plugins/membership/runtime/admin/api/membership/tiers
POST   /admin/api/cms/plugins/membership/runtime/admin/api/membership/tiers
PATCH  /admin/api/cms/plugins/membership/runtime/admin/api/membership/tiers/:id
DELETE /admin/api/cms/plugins/membership/runtime/admin/api/membership/tiers/:id
```

## Stripe setup

1. Create products + prices in Stripe Dashboard (one price per tier × billing interval)
2. Copy the price ID (e.g. `price_1ABC...`) — paste into each tier's `stripePriceId`
3. Set the `stripeSecretKey` plugin setting
4. Add a Stripe webhook endpoint pointing to `https://<your-site>/api/membership/stripe/webhook`
   - Subscribe to events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
5. Save the webhook signing secret in plugin settings (signature verification is implemented via `verifyAndParseStripeWebhook`)

## Database schema

```sql
create table membership_tiers (
  id text primary key,
  slug text not null unique,
  name text not null,
  description text not null default '',
  rank integer not null default 0,
  price_cents integer not null default 0,
  currency text not null default 'USD',
  billing_interval text not null default 'month',
  stripe_price_id text,
  features_json jsonb not null default '[]',
  is_default boolean not null default false,
  is_public boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table subscriptions (
  id text primary key,
  user_id text not null,
  tier_id text not null references membership_tiers(id),
  status text not null check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  trial_ends_at timestamptz,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  canceled_at timestamptz,
  cancel_at timestamptz,
  stripe_subscription_id text,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index subscriptions_user_active_unique
  on subscriptions (user_id)
  where status in ('trialing', 'active', 'past_due');
```

## Lifecycle example

```
User subscribes to premium ($9.99/month)
  → POST /api/membership/subscribe { tierSlug: "premium" }
  → Subscription row created: status=trialing, trialEndsAt=now+7d
  → If Stripe: returns { checkoutUrl } → user pays
  → Stripe webhook: customer.subscription.created
  → Subscription row updated: status=active, current_period_end=now+1mo

7 days pass (if trial)
  → Stripe webhook: customer.subscription.updated
  → status=active

1 month later
  → Stripe webhook: customer.subscription.updated (renewal)
  → current_period_end += 1 month

User clicks "Cancel"
  → POST /api/membership/cancel
  → cancel_at = current_period_end, status still active

current_period_end passes
  → Stripe webhook: customer.subscription.deleted
  → status=canceled

User resubscribes (new sub row, old stays canceled)
```

## License

MIT