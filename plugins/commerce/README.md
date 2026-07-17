# @instatic/plugin-commerce

E-commerce catalog, cart, checkout, and order management for Instatic. Products are managed as CMS content (data tables); orders and inventory are plugin-owned transactional data.

## Features

- **Product catalog** -- managed as a `products` data table (created on first activation)
- **Product variants** -- size/color/etc. with independent stock tracking (admin CRUD + restock)
- **Shopping cart** -- per-user, persists across sessions, with inventory reservation during checkout
- **Stripe Checkout** -- hosted payment page, PCI-compliant by default
- **Order management** -- full lifecycle: pending -> paid -> fulfilled -> refunded / canceled
- **Order fulfillment** -- admin marks orders as fulfilled (status=paid -> fulfilled)
- **Order cancellation** -- admin cancels pending/paid orders, releases reserved inventory
- **Inventory tracking** -- append-only ledger with restock and order deduction
- **Inventory reservations** -- `SELECT FOR UPDATE` + transaction to prevent overselling; automatic expiry GC
- **Coupons** -- create/list/update/delete, apply with validation (percent, fixed, BOGO, free_shipping types), redemption tracking per coupon, per-user usage limits, date range, product/collection applicability
- **Shipping** -- rate table per country/region, free-shipping threshold, flat-rate fallback, carrier adapter framework (register custom carriers via `registerCarrierAdapter`)
- **Refunds** -- Stripe refund (API-initiated, confirmed via webhook) and manual refund (bank_transfer, store_credit, cash, other) with amount validation
- **Cart expiration cleanup** -- `expireOldCarts` removes stale carts (configurable max age, default 30 days)
- **Webhook sync** -- Stripe events keep order status accurate
- **viewerContext.cartCount** -- for "items in cart" badges in templates

## Installation

1. Set Stripe secret key + webhook signing secret in plugin settings
2. The plugin's `networkAllowedHosts` already includes `api.stripe.com`
3. Pack: `npm pack`
4. Upload via Instatic admin → Plugins
5. Approve permissions

## Stripe setup

1. Stripe Dashboard → Developers → API keys → copy Secret key (sk_...)
2. Stripe Dashboard → Developers → Webhooks → Add endpoint
   - URL: `https://<your-site>/api/commerce/stripe/webhook`
   - Events: `checkout.session.completed`, `charge.refunded`
3. Copy the signing secret (whsec_...) into plugin settings
4. Stripe webhook signature verification is implemented via `verifyAndParseStripeWebhook`

## API

### Catalog (public)

```http
GET /api/commerce/products
GET /api/commerce/products/:slug
```

### Cart (authenticated)

```http
GET    /api/commerce/cart
POST   /api/commerce/cart/items          { productId, quantity }
PATCH  /api/commerce/cart/items/:id      { quantity }
DELETE /api/commerce/cart/items/:id
DELETE /api/commerce/cart
```

### Checkout (authenticated)

```http
POST /api/commerce/checkout
{ "email": "buyer@example.com", "shippingAddress": { ... } }

→ 201 { orderId, checkoutUrl }
```

### Orders (authenticated)

```http
GET /api/commerce/orders
```

### Coupons (authenticated + admin)

```http
POST /api/commerce/cart/apply-coupon     { "code": "SAVE10" }        -- validate & apply
POST /api/commerce/cart/remove-coupon                                -- remove applied coupon
GET  /admin/.../admin/api/commerce/coupons                          -- list all
POST /admin/.../admin/api/commerce/coupons          { code, type, value, ... }  -- create
PATCH /admin/.../admin/api/commerce/coupons/:id     { ... }                     -- update
DELETE /admin/.../admin/api/commerce/coupons/:id                             -- soft-delete
GET  /admin/.../admin/api/commerce/coupons/:id/redemptions                -- redemption history
```

Coupon types: `percent`, `fixed`, `bogo`, `free_shipping`.

### Shipping (authenticated + admin)

```http
POST /api/commerce/shipping/quote          { "countryCode": "US", "items": [...] }  -- real-time quote
GET  /admin/.../admin/api/commerce/shipping-rates                               -- list rates
POST /admin/.../admin/api/commerce/shipping-rates          { countryCode, ... }   -- upsert
DELETE /admin/.../admin/api/commerce/shipping-rates/:id                         -- soft-delete
```

### Order fulfillment & cancellation (admin)

```http
POST /admin/.../admin/api/commerce/orders/:id/fulfill   -- paid -> fulfilled
POST /admin/.../admin/api/commerce/orders/:id/cancel    -- pending/paid -> canceled (releases inventory)
```

### Refunds (admin)

```http
GET  /admin/.../admin/api/commerce/orders/:id/refunds                         -- list refunds
POST /admin/.../admin/api/commerce/orders/:id/refund   { "amountCents", "reason", "method": "stripe"|"bank_transfer"|"store_credit"|"cash"|"other" }
```

### Product variants (admin)

```http
GET    /admin/.../admin/api/commerce/products/:id/variants
POST   /admin/.../admin/api/commerce/products/:id/variants          -- sync variants from CMS data
DELETE /admin/.../admin/api/commerce/variants/:id
POST   /admin/.../admin/api/commerce/variants/:id/restock            { "delta": 10, "notes": "..." }
```

### Admin (requires `content.manage`)

```http
GET  /admin/api/cms/plugins/commerce/runtime/admin/api/commerce/orders
POST /admin/api/cms/plugins/commerce/runtime/admin/api/commerce/orders/:id/refund
POST /admin/api/cms/plugins/commerce/runtime/admin/api/commerce/products/:id/restock
                                   { "delta": 10, "notes": "Q2 restock" }
```

### Webhooks (public, Stripe-signed)

```http
POST /api/commerce/stripe/webhook
```

Receives:
- `checkout.session.completed` → marks order paid, clears cart, decrements inventory
- `charge.refunded` → marks order refunded

## Database schema

```sql
create table carts (
  id text primary key,
  user_id text not null unique,
  currency text not null default 'USD',
  line_items_json jsonb not null default '[]',
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);

create table orders (
  id text primary key,
  order_number text not null unique,
  user_id text not null,
  email text not null,
  status text not null check (status in ('pending', 'paid', 'fulfilled', 'canceled', 'refunded', 'failed')),
  currency text not null,
  subtotal_cents integer not null,
  tax_cents integer not null default 0,
  shipping_cents integer not null default 0,
  total_cents integer not null,
  line_items_json jsonb not null,
  shipping_address_json jsonb,
  billing_address_json jsonb,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  metadata_json jsonb not null default '{}',
  paid_at timestamptz,
  fulfilled_at timestamptz,
  canceled_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table inventory_ledger (
  id text primary key,
  product_id text not null,
  delta integer not null,
  reason text not null check (reason in ('order_placed', 'order_canceled', 'restock', 'manual_adjustment', 'return')),
  reference_id text,
  notes text,
  created_at timestamptz not null default now()
);
```

## Order lifecycle

```
User adds items to cart (cart.lineItems)
  → POST /api/commerce/cart/items { productId, quantity }
  → cart.line_items_json updated

User clicks "Checkout"
  → POST /api/commerce/checkout { email, shippingAddress }
  → order created: status=pending, line_items_snapshot
  → Stripe Checkout Session created (checkoutUrl returned)
  → inventory_ledger: -quantity for each item (reason='order_placed')

User pays on Stripe
  → Stripe webhook → /api/commerce/stripe/webhook
  → checkout.session.completed → order.status=paid, paid_at=now
  → cart cleared

Admin fulfills
  → POST /admin/api/commerce/orders/:id/fulfill
  → order.status=fulfilled, fulfilled_at=now

Admin cancels
  → POST /admin/api/commerce/orders/:id/cancel
  → order.status=canceled, canceled_at=now (releases reserved inventory)

Admin refunds (or Stripe refund)
  → POST /admin/.../orders/:id/refund
  → Stripe API call → charge.refunded webhook
  → order.status=refunded
```

## Security notes

- **PCI compliance** — Stripe Checkout means card data never touches Instatic
- **Webhook signature verification** — implemented via `verifyAndParseStripeWebhook`
- **Inventory race conditions** — `reservations.ts` uses `SELECT FOR UPDATE` + transaction to prevent overselling
- **Cart expiration** — `expireOldCarts` runs hourly via cron (configurable max age, default 30 days)

## License

MIT