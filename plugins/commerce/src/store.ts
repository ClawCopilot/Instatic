/**
 * DB CRUD for commerce plugin.
 *
 * Cart + order state lives in plugin-owned tables. Product data lives
 * in the host's data_tables (rows in the `products` table).
 */

import type { DbClient } from '@instatic/plugin-sdk/host'

export interface CartLineItem {
  productId: string
  variantId?: string
  quantity: number
  title: string
  unitPriceCents: number
  currency: string
  imageUrl?: string
}

export interface Cart {
  id: string
  userId: string
  currency: string
  lineItems: CartLineItem[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  expiresAt: string | null
}

export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'canceled' | 'refunded' | 'failed'

export interface Order {
  id: string
  orderNumber: string
  userId: string
  email: string
  status: OrderStatus
  currency: string
  subtotalCents: number
  taxCents: number
  shippingCents: number
  totalCents: number
  lineItems: CartLineItem[]
  shippingAddress: Record<string, unknown> | null
  billingAddress: Record<string, unknown> | null
  stripeCheckoutSessionId: string | null
  stripePaymentIntentId: string | null
  metadata: Record<string, unknown>
  paidAt: string | null
  fulfilledAt: string | null
  canceledAt: string | null
  refundedAt: string | null
  createdAt: string
  updatedAt: string
}

interface CartRow {
  id: string
  user_id: string
  currency: string
  line_items_json: string | unknown[]
  metadata_json: string | unknown
  created_at: string
  updated_at: string
  expires_at: string | null
}

interface OrderRow {
  id: string
  order_number: string
  user_id: string
  email: string
  status: string
  currency: string
  subtotal_cents: number
  tax_cents: number
  shipping_cents: number
  total_cents: number
  line_items_json: string | unknown[]
  shipping_address_json: string | unknown | null
  billing_address_json: string | unknown | null
  stripe_checkout_session_id: string | null
  stripe_payment_intent_id: string | null
  metadata_json: string | unknown
  paid_at: string | null
  fulfilled_at: string | null
  canceled_at: string | null
  refunded_at: string | null
  created_at: string
  updated_at: string
}

function parseJson<T>(value: string | T): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return value
}

function rowToCart(row: CartRow): Cart {
  return {
    id: row.id,
    userId: row.user_id,
    currency: row.currency,
    lineItems: parseJson<CartLineItem[]>(row.line_items_json),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  }
}

function rowToOrder(row: OrderRow): Order {
  return {
    id: row.id,
    orderNumber: row.order_number,
    userId: row.user_id,
    email: row.email,
    status: row.status as OrderStatus,
    currency: row.currency,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    shippingCents: row.shipping_cents,
    totalCents: row.total_cents,
    lineItems: parseJson<CartLineItem[]>(row.line_items_json),
    shippingAddress: row.shipping_address_json ? parseJson<Record<string, unknown>>(row.shipping_address_json) : null,
    billingAddress: row.billing_address_json ? parseJson<Record<string, unknown>>(row.billing_address_json) : null,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
    paidAt: row.paid_at,
    fulfilledAt: row.fulfilled_at,
    canceledAt: row.canceled_at,
    refundedAt: row.refunded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ─── Carts ────────────────────────────────────────────────────────────────

export async function getOrCreateCart(db: DbClient, userId: string, currency = 'USD'): Promise<Cart> {
  const { rows } = await db<CartRow>`
    select * from carts where user_id = ${userId} limit 1
  `
  if (rows[0]) return rowToCart(rows[0])
  const id = `cart_${Math.random().toString(36).slice(2, 10)}`
  const inserted = await db<CartRow>`
    insert into carts (id, user_id, currency, line_items_json)
    values (${id}, ${userId}, ${currency}, '[]')
    returning *
  `
  return rowToCart(inserted[0])
}

export async function updateCartLineItems(
  db: DbClient,
  userId: string,
  items: CartLineItem[],
): Promise<Cart> {
  const { rows } = await db<CartRow>`
    update carts
    set line_items_json = ${JSON.stringify(items)}::jsonb,
        updated_at = now()
    where user_id = ${userId}
    returning *
  `
  return rowToCart(rows[0])
}

export async function clearCart(db: DbClient, userId: string): Promise<void> {
  await db`
    update carts
    set line_items_json = '[]'::jsonb, updated_at = now()
    where user_id = ${userId}
  `
}

// ─── Orders ───────────────────────────────────────────────────────────────

function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `${ts}-${rand}`
}

export interface CreateOrderArgs {
  userId: string
  email: string
  currency: string
  lineItems: CartLineItem[]
  subtotalCents: number
  taxCents: number
  shippingCents: number
  totalCents: number
  shippingAddress?: Record<string, unknown>
  billingAddress?: Record<string, unknown>
  stripeCheckoutSessionId?: string
  metadata?: Record<string, unknown>
}

export async function createOrder(db: DbClient, args: CreateOrderArgs): Promise<Order> {
  const id = `ord_${Math.random().toString(36).slice(2, 10)}`
  const orderNumber = generateOrderNumber()
  const { rows } = await db<OrderRow>`
    insert into orders (
      id, order_number, user_id, email, status, currency,
      subtotal_cents, tax_cents, shipping_cents, total_cents,
      line_items_json, shipping_address_json, billing_address_json,
      stripe_checkout_session_id, metadata_json
    ) values (
      ${id}, ${orderNumber}, ${args.userId}, ${args.email}, 'pending', ${args.currency},
      ${args.subtotalCents}, ${args.taxCents}, ${args.shippingCents}, ${args.totalCents},
      ${JSON.stringify(args.lineItems)}::jsonb,
      ${args.shippingAddress ? JSON.stringify(args.shippingAddress) : null}::jsonb,
      ${args.billingAddress ? JSON.stringify(args.billingAddress) : null}::jsonb,
      ${args.stripeCheckoutSessionId ?? null},
      ${JSON.stringify(args.metadata ?? {})}::jsonb
    )
    returning *
  `
  return rowToOrder(rows[0])
}

export async function findOrderBySessionId(
  db: DbClient,
  sessionId: string,
): Promise<Order | null> {
  const { rows } = await db<OrderRow>`
    select * from orders
    where stripe_checkout_session_id = ${sessionId}
    limit 1
  `
  return rows[0] ? rowToOrder(rows[0]) : null
}

export async function findOrderById(db: DbClient, id: string): Promise<Order | null> {
  const { rows } = await db<OrderRow>`
    select * from orders where id = ${id} limit 1
  `
  return rows[0] ? rowToOrder(rows[0]) : null
}

export async function markOrderPaid(
  db: DbClient,
  id: string,
  paymentIntentId: string | null,
): Promise<Order | null> {
  const { rows } = await db<OrderRow>`
    update orders
    set status = 'paid',
        paid_at = now(),
        stripe_payment_intent_id = ${paymentIntentId},
        updated_at = now()
    where id = ${id} and status in ('pending')
    returning *
  `
  return rows[0] ? rowToOrder(rows[0]) : null
}

export async function listOrdersForUser(db: DbClient, userId: string): Promise<Order[]> {
  const { rows } = await db<OrderRow>`
    select * from orders
    where user_id = ${userId}
    order by created_at desc
    limit 50
  `
  return rows.map(rowToOrder)
}

// ─── Inventory ────────────────────────────────────────────────────────────

export async function adjustInventory(
  db: DbClient,
  productId: string,
  delta: number,
  reason: 'order_placed' | 'order_canceled' | 'restock' | 'manual_adjustment' | 'return',
  referenceId: string | null,
  notes: string | null,
): Promise<void> {
  await db`
    insert into inventory_ledger (id, product_id, delta, reason, reference_id, notes)
    values (
      ${`inv_${Math.random().toString(36).slice(2, 10)}`},
      ${productId}, ${delta}, ${reason}, ${referenceId}, ${notes}
    )
  `
}

export async function getProductInventory(
  db: DbClient,
  productId: string,
): Promise<number> {
  // Sum all deltas. Caller is responsible for product availability flags
  // (e.g. unlimited digital downloads might not be tracked here).
  const { rows } = await db<{ sum: number | null }>`
    select coalesce(sum(delta), 0)::int as sum from inventory_ledger where product_id = ${productId}
  `
  return rows[0]?.sum ?? 0
}

// ─── Cart 过期清理 ──────────────────────────────────────────────────────

/**
 * 清理过期购物车。删除超过指定天数未更新的购物车。
 * 建议由 cron job 或 hooks 调度器定期调用。
 */
export async function expireOldCarts(db: DbClient, maxAgeDays = 30): Promise<number> {
  const { rows } = await db`
    delete from carts
    where updated_at < now() - interval '${maxAgeDays} days'
    returning id
  `
  return rows.length
}