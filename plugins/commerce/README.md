# @instatic/plugin-commerce

E-commerce catalog, cart, checkout, and order management for Instatic. Products are managed as CMS content (data tables); orders and inventory are plugin-owned transactional data.

## Features

- **Product catalog** — managed as a `products` data table (created on first activation)
- **Shopping cart** — per-user, persists across sessions
- **Stripe Checkout** — hosted payment page, PCI-compliant by default
- **Order management** — full lifecycle: pending → paid → fulfilled → refunded
- **Inventory tracking** — append-only ledger with restock and order deduction
- **Webhook sync** — Stripe events keep order status accurate
- **Refund API** — admin-initiated refunds via Stripe
- **viewerContext.cartCount** — for "items in cart" badges in templates

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
4. **TODO before production**: implement Stripe signature verification in `handleStripeWebhook`

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
  → (manual via admin UI — TODO)
  → order.status=fulfilled, fulfilled_at=now

Admin refunds (or Stripe refund)
  → POST /admin/.../orders/:id/refund
  → Stripe API call → charge.refunded webhook
  → order.status=refunded
```

## Security notes

- **PCI compliance** — Stripe Checkout means card data never touches Instatic
- **Webhook signature verification** — TODO before production
- **Inventory race conditions** — current implementation allows overselling under high concurrency; for high-volume stores, wrap checkout in a serializable transaction
- **Cart abandonment** — carts persist forever; add a cron job (via another plugin) to expire old carts

## License

MIT