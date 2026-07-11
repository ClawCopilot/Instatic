/**
 * Plugin migrations for commerce.
 *
 * Creates two tables:
 *   - carts        : per-user cart state (line items, totals, currency)
 *   - orders       : completed orders (post-payment, audit trail)
 *
 * Product catalog itself uses the host's data_tables system:
 *   - The plugin declares a 'products' data table on activate (idempotent)
 *   - Products have: title, slug, price, currency, inventory, images,
 *     variants, etc. (managed via the standard CMS admin UI)
 *   - The catalog route reads from data_rows WHERE table_id = 'products'
 *
 * This split is intentional: products are content (editable by the team
 * like any other post), carts/orders are transactional (plugin-owned).
 */

export default [
  {
    id: 'commerce.001_carts_and_orders',
    pgSql: `
      create table if not exists carts (
        id text primary key,
        user_id text not null,
        currency text not null default 'USD',
        line_items_json jsonb not null default '[]',
        metadata_json jsonb not null default '{}',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        expires_at timestamptz,
        constraint carts_user_unique unique (user_id)
      );

      create index if not exists carts_user_idx
        on carts (user_id);

      create table if not exists orders (
        id text primary key,
        order_number text not null unique,
        user_id text not null,
        email text not null,
        status text not null default 'pending',
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
        updated_at timestamptz not null default now(),
        constraint orders_status_check
          check (status in ('pending', 'paid', 'fulfilled', 'canceled', 'refunded', 'failed'))
      );

      create index if not exists orders_user_idx
        on orders (user_id, created_at desc);

      create index if not exists orders_status_idx
        on orders (status, created_at desc);

      create index if not exists orders_email_idx
        on orders (email, created_at desc)
        where email is not null;

      create index if not exists orders_stripe_session_idx
        on orders (stripe_checkout_session_id)
        where stripe_checkout_session_id is not null;

      -- Inventory ledger — one row per stock change. Products track
      -- available quantity via products.available_quantity; this table
      -- is the audit log of every change (orders, restocks, manual
      -- adjustments).
      create table if not exists inventory_ledger (
        id text primary key,
        product_id text not null,
        delta integer not null,
        reason text not null,
        reference_id text,
        notes text,
        created_at timestamptz not null default now(),
        constraint inventory_ledger_reason_check
          check (reason in ('order_placed', 'order_canceled', 'restock', 'manual_adjustment', 'return'))
      );

      create index if not exists inventory_ledger_product_idx
        on inventory_ledger (product_id, created_at desc);
    `,
    sqliteSql: `
      create table if not exists carts (
        id text primary key,
        user_id text not null unique,
        currency text not null default 'USD',
        line_items_json text not null default '[]',
        metadata_json text not null default '{}',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at text
      );

      create table if not exists orders (
        id text primary key,
        order_number text not null unique,
        user_id text not null,
        email text not null,
        status text not null default 'pending',
        currency text not null,
        subtotal_cents integer not null,
        tax_cents integer not null default 0,
        shipping_cents integer not null default 0,
        total_cents integer not null,
        line_items_json text not null,
        shipping_address_json text,
        billing_address_json text,
        stripe_checkout_session_id text,
        stripe_payment_intent_id text,
        metadata_json text not null default '{}',
        paid_at text,
        fulfilled_at text,
        canceled_at text,
        refunded_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint orders_status_check
          check (status in ('pending', 'paid', 'fulfilled', 'canceled', 'refunded', 'failed'))
      );

      create index if not exists orders_user_idx
        on orders (user_id, created_at desc);

      create index if not exists orders_status_idx
        on orders (status, created_at desc);

      create index if not exists orders_email_idx
        on orders (email, created_at desc);

      create index if not exists orders_stripe_session_idx
        on orders (stripe_checkout_session_id)
        where stripe_checkout_session_id is not null;

      create table if not exists inventory_ledger (
        id text primary key,
        product_id text not null,
        delta integer not null,
        reason text not null,
        reference_id text,
        notes text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint inventory_ledger_reason_check
          check (reason in ('order_placed', 'order_canceled', 'restock', 'manual_adjustment', 'return'))
      );

      create index if not exists inventory_ledger_product_idx
        on inventory_ledger (product_id, created_at desc);
    `,
  },
]