/**
 * Order refunds — supports full + partial refunds with audit trail.
 *
 * Lifecycle:
 *   1. Admin POST /api/admin/commerce/orders/:id/refund { amountCents, reason }
 *   2. Insert into order_refunds with status='pending'
 *   3. Call Stripe API to create the refund
 *   4. On Stripe success: update status='succeeded', update orders.refunded_cents
 *   5. On Stripe failure: update status='failed', leave refunded_cents alone
 *
 * Constraints:
 *   - amountCents ≤ (orders.total_cents - orders.refunded_cents)
 *   - Only one pending refund per order at a time (to prevent double-issues)
 *
 * TODO: support non-Stripe refund methods (manual bank transfer, store credit).
 */

import { randomBytes } from 'node:crypto'
import type { DbClient } from '@instatic/plugin-sdk/host'

export type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'canceled'

export interface Refund {
  id: string
  orderId: string
  amountCents: number
  currency: string
  reason: string
  stripeRefundId: string | null
  status: RefundStatus
  refundedByUserId: string | null
  notes: string | null
  createdAt: string
  completedAt: string | null
}

interface RefundRow {
  id: string
  order_id: string
  amount_cents: number
  currency: string
  reason: string
  stripe_refund_id: string | null
  status: string
  refunded_by_user_id: string | null
  notes: string | null
  created_at: string
  completed_at: string | null
}

function rowToRefund(row: RefundRow): Refund {
  return {
    id: row.id,
    orderId: row.order_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    reason: row.reason,
    stripeRefundId: row.stripe_refund_id,
    status: row.status as RefundStatus,
    refundedByUserId: row.refunded_by_user_id,
    notes: row.notes,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

export async function createRefund(
  db: DbClient,
  args: Omit<Refund, 'status' | 'createdAt' | 'completedAt' | 'stripeRefundId'>,
): Promise<Refund> {
  const id = `ref_${randomBytes(8).toString('hex')}`
  const { rows } = await db<RefundRow>`
    insert into order_refunds (id, order_id, amount_cents, currency, reason, status, refunded_by_user_id, notes)
    values (${id}, ${args.orderId}, ${args.amountCents}, ${args.currency}, ${args.reason}, 'pending',
            ${args.refundedByUserId}, ${args.notes})
    returning *
  `
  return rowToRefund(rows[0])
}

export async function markRefundSucceeded(
  db: DbClient,
  id: string,
  stripeRefundId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows: refundRows } = await tx<{ order_id: string; amount_cents: number }>`
      update order_refunds
      set status = 'succeeded',
          stripe_refund_id = ${stripeRefundId},
          completed_at = now()
      where id = ${id} and status = 'pending'
      returning order_id, amount_cents
    `
    if (refundRows[0]) {
      await tx`
        update orders
        set refunded_cents = refunded_cents + ${refundRows[0].amount_cents},
            status = case
              when refunded_cents + ${refundRows[0].amount_cents} >= total_cents then 'refunded'
              when refunded_cents + ${refundRows[0].amount_cents} > 0 then 'partially_refunded'
              else status
            end,
            updated_at = now()
        where id = ${refundRows[0].order_id}
      `
    }
  })
}

export async function markRefundFailed(db: DbClient, id: string, error: string): Promise<void> {
  await db`
    update order_refunds
    set status = 'failed', notes = ${error}, completed_at = now()
    where id = ${id} and status = 'pending'
  `
}

export async function listRefundsForOrder(db: DbClient, orderId: string): Promise<Refund[]> {
  const { rows } = await db<RefundRow>`
    select * from order_refunds where order_id = ${orderId} order by created_at desc
  `
  return rows.map(rowToRefund)
}

/**
 * Validate that a refund amount is within the remaining refundable balance
 * for an order. Returns null if OK, error reason if not.
 */
export async function validateRefundAmount(
  db: DbClient,
  orderId: string,
  amountCents: number,
): Promise<{ ok: true; order: { id: string; totalCents: number; refundedCents: number; currency: string; status: string } } | { ok: false; reason: string }> {
  const { rows } = await db<{ id: string; total_cents: number; refunded_cents: number; currency: string; status: string }>`
    select id, total_cents, refunded_cents, currency, status
    from orders where id = ${orderId} limit 1
  `
  const order = rows[0]
  if (!order) return { ok: false, reason: 'order_not_found' }
  if (order.status !== 'paid' && order.status !== 'fulfilled' && order.status !== 'partially_refunded') {
    return { ok: false, reason: 'order_not_paid' }
  }
  if (amountCents <= 0) return { ok: false, reason: 'amount_must_be_positive' }
  const remaining = order.total_cents - order.refunded_cents
  if (amountCents > remaining) {
    return { ok: false, reason: `amount_exceeds_remaining_refundable (${remaining})` }
  }
  return {
    ok: true,
    order: {
      id: order.id,
      totalCents: order.total_cents,
      refundedCents: order.refunded_cents,
      currency: order.currency,
      status: order.status,
    },
  }
}