/**
 * Inventory reservations — prevent overselling under concurrency.
 *
 * The naive "sum inventory_ledger on checkout" approach has a race:
 * two customers check out the same item simultaneously; both see stock=1;
 * both succeed; you now have a negative balance.
 *
 * Reservation flow:
 *   1. User adds item to cart (no reservation yet)
 *   2. User clicks "Checkout" → API reserves stock for 15 min
 *      - INSERT into reservations with expires_at = now() + 15min
 *      - Return success only if available >= requested (read+reserve atomic)
 *   3. User completes payment → reservation converted to deduction
 *   4. User abandons → reservation expires, stock available again
 *
 * The atomic check uses a single transaction with a SELECT ... FOR UPDATE
 * on the inventory_ledger sum, ensuring no race.
 *
 * For SQLite (single-writer), the same logic is correct (transactions
 * are serial).
 *
 * Concurrency caveats:
 *   - Two plugins on different hosts (HA setup) can still race; for that
 *     we'd need an external lock manager (Redis, etcd). The current
 *     implementation assumes single-host.
 *   - The reservation table uses a unique index on (variant_id, cart_id)
 *     to prevent double-reservation.
 */

import { randomBytes } from 'node:crypto'
import type { DbClient } from '@instatic/plugin-sdk/host'

export const RESERVATION_TTL_SECONDS = 900  // 15 min

export interface Reservation {
  id: string
  userId: string
  cartId: string
  variantId: string | null  // null = product-level (no variant)
  productId: string
  quantity: number
  expiresAt: string
  consumedAt: string | null
  releasedAt: string | null
  orderId: string | null
  createdAt: string
}

interface ReservationRow {
  id: string
  user_id: string
  cart_id: string
  variant_id: string | null
  product_id: string
  quantity: number
  expires_at: string
  consumed_at: string | null
  released_at: string | null
  order_id: string | null
  created_at: string
}

function rowToReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    userId: row.user_id,
    cartId: row.cart_id,
    variantId: row.variant_id,
    productId: row.product_id,
    quantity: row.quantity,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    releasedAt: row.released_at,
    orderId: row.order_id,
    createdAt: row.created_at,
  }
}

// ─── Available stock calculation ────────────────────────────────────────

/**
 * Compute available stock for a (product, variant) tuple.
 *
 *   available = sum(inventory_ledger.delta)
 *              - sum(active reservations.quantity)
 *
 * Active = expires_at > now() AND consumed_at IS NULL AND released_at IS NULL
 */
export async function getAvailableStock(
  db: DbClient,
  productId: string,
  variantId: string | null,
): Promise<number> {
  // Stock from ledger
  const stockQuery = variantId
    ? db<{ sum: number | null }>`
        select coalesce(sum(delta), 0)::int as sum
        from inventory_ledger
        where product_id = ${productId} and notes = ${variantId}
      `
    : db<{ sum: number | null }>`
        select coalesce(sum(delta), 0)::int as sum
        from inventory_ledger
        where product_id = ${productId} and notes is null
      `
  const { rows: stockRows } = await stockQuery
  const stock = stockRows[0]?.sum ?? 0
  // Active reservations
  const resQuery = variantId
    ? db<{ sum: number | null }>`
        select coalesce(sum(quantity), 0)::int as sum
        from inventory_reservations
        where product_id = ${productId} and variant_id = ${variantId}
          and consumed_at is null
          and released_at is null
          and expires_at > now()
      `
    : db<{ sum: number | null }>`
        select coalesce(sum(quantity), 0)::int as sum
        from inventory_reservations
        where product_id = ${productId} and variant_id is null
          and consumed_at is null
          and released_at is null
          and expires_at > now()
      `
  const { rows: resRows } = await resQuery
  const reserved = resRows[0]?.sum ?? 0
  return stock - reserved
}

// ─── Reserve / release / consume ────────────────────────────────────────

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: 'insufficient_stock'; available: number; requested: number }

/**
 * Reserve stock atomically. Returns the new reservation on success;
 * `insufficient_stock` with the current available count on failure.
 */
export async function reserveStock(
  db: DbClient,
  args: {
    userId: string
    cartId: string
    productId: string
    variantId: string | null
    quantity: number
  },
): Promise<ReserveResult> {
  const id = `res_${randomBytes(8).toString('hex')}`
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_SECONDS * 1000).toISOString()

  // Atomic check: SELECT FOR UPDATE the available stock, then INSERT if OK.
  // The transaction wraps the read+write so concurrent attempts serialise.
  return await db.transaction(async (tx) => {
    // Lock + read current available
    const available = await getAvailableStockInTx(tx, args.productId, args.variantId)
    if (available < args.quantity) {
      return { ok: false as const, reason: 'insufficient_stock' as const, available, requested: args.quantity }
    }
    const { rows } = await tx<ReservationRow>`
      insert into inventory_reservations (
        id, user_id, cart_id, variant_id, product_id, quantity, expires_at
      ) values (
        ${id}, ${args.userId}, ${args.cartId}, ${args.variantId},
        ${args.productId}, ${args.quantity}, ${expiresAt}
      )
      on conflict (cart_id, variant_id) do update
      set quantity = inventory_reservations.quantity + ${args.quantity},
          expires_at = ${expiresAt},
          updated_at = now()
      returning *
    `
    return { ok: true as const, reservation: rowToReservation(rows[0]) }
  })
}

async function getAvailableStockInTx(
  tx: Parameters<Parameters<DbClient['transaction']>[0]>[0],
  productId: string,
  variantId: string | null,
): Promise<number> {
  const stockFilter = variantId
    ? tx<{ sum: number | null }>`
        select coalesce(sum(delta), 0)::int as sum
        from inventory_ledger
        where product_id = ${productId} and notes = ${variantId}
        for update
      `
    : tx<{ sum: number | null }>`
        select coalesce(sum(delta), 0)::int as sum
        from inventory_ledger
        where product_id = ${productId} and notes is null
        for update
      `
  const { rows: stock } = await stockFilter
  const resFilter = variantId
    ? tx<{ sum: number | null }>`
        select coalesce(sum(quantity), 0)::int as sum
        from inventory_reservations
        where product_id = ${productId} and variant_id = ${variantId}
          and consumed_at is null
          and released_at is null
          and expires_at > now()
        for update
      `
    : tx<{ sum: number | null }>`
        select coalesce(sum(quantity), 0)::int as sum
        from inventory_reservations
        where product_id = ${productId} and variant_id is null
          and consumed_at is null
          and released_at is null
          and expires_at > now()
        for update
      `
  const { rows: reserved } = await resFilter
  return (stock[0]?.sum ?? 0) - (reserved[0]?.sum ?? 0)
}

/**
 * Mark a reservation as consumed (stock permanently deducted). Called
 * by the checkout success handler. Also writes the inventory_ledger row
 * (the actual stock change) in the same transaction.
 */
export async function consumeReservation(
  db: DbClient,
  reservationId: string,
  orderId: string,
): Promise<{ ok: boolean; reason?: 'not_found' | 'already_consumed' | 'expired' }> {
  return await db.transaction(async (tx) => {
    const { rows } = await tx<ReservationRow>`
      update inventory_reservations
      set consumed_at = now(), order_id = ${orderId}
      where id = ${reservationId}
        and consumed_at is null
        and released_at is null
      returning *
    `
    if (!rows[0]) {
      // Check why we didn't get a row back
      const { rows: existing } = await tx<{ consumed_at: string | null; expires_at: string }>`
        select consumed_at, expires_at from inventory_reservations where id = ${reservationId} limit 1
      `
      if (!existing[0]) return { ok: false, reason: 'not_found' }
      if (existing[0].consumed_at) return { ok: false, reason: 'already_consumed' }
      if (new Date(existing[0].expires_at) < new Date()) return { ok: false, reason: 'expired' }
      return { ok: false, reason: 'not_found' }
    }
    // Write the inventory ledger row (permanent deduction)
    const r = rows[0]
    await tx`
      insert into inventory_ledger (id, product_id, delta, reason, reference_id, notes)
      values (
        ${`inv_${randomBytes(8).toString('hex')}`},
        ${r.product_id}, ${-r.quantity}, 'order_placed', ${orderId}, ${r.variant_id}
      )
    `
    return { ok: true }
  })
}

/**
 * Release a reservation (cancelled checkout, abandoned cart). Called
 * automatically when the reservation expires (via lazy GC on next
 * check) or explicitly when the user cancels.
 */
export async function releaseReservation(db: DbClient, reservationId: string): Promise<void> {
  await db`
    update inventory_reservations
    set released_at = now()
    where id = ${reservationId} and consumed_at is null and released_at is null
  `
}

export async function releaseReservationsForCart(db: DbClient, cartId: string): Promise<number> {
  const { rows } = await db`
    update inventory_reservations
    set released_at = now()
    where cart_id = ${cartId} and consumed_at is null and released_at is null
    returning id
  `
  return rows.length
}

/**
 * Garbage-collect expired reservations. Called on demand (the next
 * getAvailableStock/cleanReservations call) and via the inventory
 * middleware on each checkout attempt.
 */
export async function gcExpiredReservations(db: DbClient): Promise<number> {
  const { rows } = await db`
    update inventory_reservations
    set released_at = now()
    where consumed_at is null
      and released_at is null
      and expires_at <= now()
    returning id
  `
  return rows.length
}

export async function listReservationsForCart(db: DbClient, cartId: string): Promise<Reservation[]> {
  const { rows } = await db<ReservationRow>`
    select * from inventory_reservations
    where cart_id = ${cartId} and consumed_at is null and released_at is null
    order by created_at
  `
  return rows.map(rowToReservation)
}