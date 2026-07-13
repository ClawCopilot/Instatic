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
  {
    id: 'commerce.002_coupons_and_variants',
    pgSql: `
      -- ─── Coupons / discount codes ──────────────────────────────────────
      create table if not exists coupons (
        id text primary key,
        code text not null unique,
        type text not null,
        value integer not null,
        min_order_cents integer not null default 0,
        max_uses integer not null default 0,
        max_uses_per_user integer not null default 0,
        current_uses integer not null default 0,
        valid_from timestamptz not null,
        valid_until timestamptz not null,
        applicable_to_json jsonb not null default '{}'::jsonb,
        enabled boolean not null default true,
        description text not null default '',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint coupons_type_check check (type in ('percent', 'fixed'))
      );

      create index if not exists coupons_enabled_valid_idx
        on coupons (enabled, valid_from, valid_until);

      create table if not exists coupon_redemptions (
        id text primary key,
        coupon_id text not null references coupons(id) on delete cascade,
        user_id text not null,
        order_id text not null references orders(id) on delete cascade,
        discount_cents integer not null,
        redeemed_at timestamptz not null default now()
      );

      create index if not exists coupon_redemptions_coupon_idx
        on coupon_redemptions (coupon_id, redeemed_at desc);

      create index if not exists coupon_redemptions_user_idx
        on coupon_redemptions (user_id, redeemed_at desc);

      -- ─── Product variants ──────────────────────────────────────────────
      create table if not exists product_variants (
        id text primary key,
        product_id text not null,
        variant_key text not null,
        sku text not null,
        label text not null,
        price_cents integer not null,
        currency text not null default 'USD',
        enabled boolean not null default true,
        sort_order integer not null default 0,
        attributes_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (product_id, variant_key)
      );

      create index if not exists product_variants_product_idx
        on product_variants (product_id, sort_order);

      -- ─── Inventory reservations (prevent overselling) ───────────────
      create table if not exists inventory_reservations (
        id text primary key,
        user_id text not null,
        cart_id text not null,
        product_id text not null,
        variant_id text,
        quantity integer not null check (quantity > 0),
        expires_at timestamptz not null,
        consumed_at timestamptz,
        released_at timestamptz,
        order_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint inventory_reservations_variant_unique
          unique (cart_id, variant_id)
      );

      create index if not exists inventory_reservations_active_idx
        on inventory_reservations (product_id, variant_id, expires_at)
        where consumed_at is null and released_at is null;

      create index if not exists inventory_reservations_cart_idx
        on inventory_reservations (cart_id);

      -- ─── Shipping rates ────────────────────────────────────────────────
      create table if not exists shipping_rates (
        id text primary key,
        country_code text not null,
        region_code text,
        min_subtotal_cents integer not null default 0,
        max_subtotal_cents integer not null default 0,
        min_weight_grams integer not null default 0,
        max_weight_grams integer not null default 0,
        cost_cents integer not null,
        currency text not null default 'USD',
        enabled boolean not null default true,
        description text not null default '',
        sort_order integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists shipping_rates_lookup_idx
        on shipping_rates (country_code, enabled, sort_order)
        where enabled = true;

      -- ─── Order refunds ────────────────────────────────────────────────
      create table if not exists order_refunds (
        id text primary key,
        order_id text not null references orders(id) on delete cascade,
        amount_cents integer not null,
        currency text not null,
        reason text not null default '',
        stripe_refund_id text,
        status text not null default 'pending',
        refunded_by_user_id text,
        notes text,
        created_at timestamptz not null default now(),
        completed_at timestamptz,
        constraint order_refunds_status_check
          check (status in ('pending', 'succeeded', 'failed', 'canceled'))
      );

      create index if not exists order_refunds_order_idx
        on order_refunds (order_id, created_at desc);

      alter table orders
        add column if not exists refunded_cents integer not null default 0;

      alter table orders
        add column if not exists shipping_method text;
    `,
    sqliteSql: `
      create table if not exists coupons (
        id text primary key,
        code text not null unique,
        type text not null,
        value integer not null,
        min_order_cents integer not null default 0,
        max_uses integer not null default 0,
        max_uses_per_user integer not null default 0,
        current_uses integer not null default 0,
        valid_from text not null,
        valid_until text not null,
        applicable_to_json text not null default '{}',
        enabled integer not null default 1,
        description text not null default '',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint coupons_type_check check (type in ('percent', 'fixed'))
      );

      create table if not exists coupon_redemptions (
        id text primary key,
        coupon_id text not null references coupons(id) on delete cascade,
        user_id text not null,
        order_id text not null references orders(id) on delete cascade,
        discount_cents integer not null,
        redeemed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create table if not exists product_variants (
        id text primary key,
        product_id text not null,
        variant_key text not null,
        sku text not null,
        label text not null,
        price_cents integer not null,
        currency text not null default 'USD',
        enabled integer not null default 1,
        sort_order integer not null default 0,
        attributes_json text not null default '{}',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        unique (product_id, variant_key)
      );

      create table if not exists inventory_reservations (
        id text primary key,
        user_id text not null,
        cart_id text not null,
        product_id text not null,
        variant_id text,
        quantity integer not null check (quantity > 0),
        expires_at text not null,
        consumed_at text,
        released_at text,
        order_id text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint inventory_reservations_variant_unique
          unique (cart_id, variant_id)
      );

      create table if not exists shipping_rates (
        id text primary key,
        country_code text not null,
        region_code text,
        min_subtotal_cents integer not null default 0,
        max_subtotal_cents integer not null default 0,
        min_weight_grams integer not null default 0,
        max_weight_grams integer not null default 0,
        cost_cents integer not null,
        currency text not null default 'USD',
        enabled integer not null default 1,
        description text not null default '',
        sort_order integer not null default 0,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create table if not exists order_refunds (
        id text primary key,
        order_id text not null references orders(id) on delete cascade,
        amount_cents integer not null,
        currency text not null,
        reason text not null default '',
        stripe_refund_id text,
        status text not null default 'pending',
        refunded_by_user_id text,
        notes text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        completed_at text,
        constraint order_refunds_status_check
          check (status in ('pending', 'succeeded', 'failed', 'canceled'))
      );

      -- SQLite: ALTER TABLE ADD COLUMN is supported but not idempotent.
      -- Use the try/catch wrapper via the schema_migrations safety.
      alter table orders add column refunded_cents integer not null default 0;
      alter table orders add column shipping_method text;
    `,
  },
]