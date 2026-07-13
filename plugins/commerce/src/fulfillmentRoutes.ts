/**
 * Shipping + refund + reservation route handlers.
 *
 * Public:
 *   POST /api/commerce/shipping/quote      { countryCode, regionCode?, subtotalCents, weightGrams }
 *                                           → { costCents, method, estimatedDays }
 *
 * Cart (authenticated):
 *   POST /api/commerce/cart/reserve         → reserves stock for 15 min
 *   POST /api/commerce/cart/release         → releases reservations
 *
 * Admin (content.manage):
 *   GET    /api/admin/commerce/shipping-rates
 *   POST   /api/admin/commerce/shipping-rates
 *   DELETE /api/admin/commerce/shipping-rates/:id
 *   GET    /api/admin/commerce/orders/:id/refunds
 *   POST   /api/admin/commerce/orders/:id/refund  { amountCents, reason }
 */

import { nanoid } from 'nanoid'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import {
  calculateShipping,
  deleteShippingRate,
  listShippingRates,
  upsertShippingRate,
  type ShippingSettings,
} from './shipping'
import {
  createRefund,
  listRefundsForOrder,
  markRefundFailed,
  markRefundSucceeded,
  validateRefundAmount,
  type Refund,
} from './refunds'
import {
  gcExpiredReservations,
  listReservationsForCart,
  releaseReservationsForCart,
  reserveStock,
} from './reservations'

// ─── Shipping ───────────────────────────────────────────────────────────

export async function handleShippingQuote(
  api: ApiCallContext,
  req: Request,
  settings: ShippingSettings,
): Promise<Response> {
  let body: { countryCode?: string; regionCode?: string; subtotalCents?: number; weightGrams?: number; currency?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.countryCode || typeof body.subtotalCents !== 'number') {
    return Response.json({ error: 'countryCode and subtotalCents required' }, { status: 400 })
  }
  const result = await calculateShipping(api.db, {
    countryCode: body.countryCode,
    regionCode: body.regionCode,
    subtotalCents: body.subtotalCents,
    totalWeightGrams: body.weightGrams ?? 0,
    currency: body.currency,
  }, settings)
  return Response.json(result)
}

export async function handleAdminListShippingRates(api: ApiCallContext): Promise<Response> {
  const rates = await listShippingRates(api.db)
  return Response.json({ rates })
}

export async function handleAdminUpsertShippingRate(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const rate = await upsertShippingRate(api.db, {
    id: (body.id as string) ?? '',
    countryCode: String(body.countryCode ?? ''),
    regionCode: (body.regionCode as string) ?? null,
    minSubtotalCents: Number(body.minSubtotalCents ?? 0),
    maxSubtotalCents: Number(body.maxSubtotalCents ?? 0),
    minWeightGrams: Number(body.minWeightGrams ?? 0),
    maxWeightGrams: Number(body.maxWeightGrams ?? 0),
    costCents: Number(body.costCents ?? 0),
    currency: String(body.currency ?? 'USD'),
    enabled: body.enabled !== false,
    description: String(body.description ?? ''),
    sortOrder: Number(body.sortOrder ?? 0),
  })
  return Response.json({ rate })
}

export async function handleAdminDeleteShippingRate(
  api: ApiCallContext,
  id: string,
): Promise<Response> {
  await deleteShippingRate(api.db, id)
  return Response.json({ deleted: true })
}

// ─── Reservations ───────────────────────────────────────────────────────

export async function handleReserveCart(
  api: ApiCallContext,
  userId: string,
): Promise<Response> {
  // Garbage-collect expired reservations first
  await gcExpiredReservations(api.db)
  // Read cart
  const { rows: cartRows } = await api.db`
    select id, line_items_json from carts where user_id = ${userId} limit 1
  `
  if (!cartRows[0]) return Response.json({ error: 'cart_not_found' }, { status: 404 })
  const cartId = cartRows[0].id
  const lineItems = JSON.parse(cartRows[0].line_items_json) as Array<{ productId: string; variantId?: string; quantity: number }>
  // Reserve each line item
  const reservations = []
  for (const item of lineItems) {
    const result = await reserveStock(api.db, {
      userId,
      cartId,
      productId: item.productId,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
    })
    if (!result.ok) {
      // Rollback already-made reservations
      await releaseReservationsForCart(api.db, cartId)
      return Response.json({
        error: 'insufficient_stock',
        productId: item.productId,
        variantId: item.variantId,
        available: result.available,
        requested: result.requested,
      }, { status: 409 })
    }
    reservations.push(result.reservation)
  }
  return Response.json({ reservations, expiresInSeconds: 900 })
}

export async function handleReleaseCart(
  api: ApiCallContext,
  userId: string,
): Promise<Response> {
  const { rows: cartRows } = await api.db`
    select id from carts where user_id = ${userId} limit 1
  `
  if (!cartRows[0]) return Response.json({ released: 0 })
  const released = await releaseReservationsForCart(api.db, cartRows[0].id)
  return Response.json({ released })
}

// ─── Refunds ────────────────────────────────────────────────────────────

export async function handleAdminListRefunds(
  api: ApiCallContext,
  orderId: string,
): Promise<Response> {
  const refunds = await listRefundsForOrder(api.db, orderId)
  return Response.json({ refunds })
}

export async function handleAdminCreateRefund(
  api: ApiCallContext,
  req: Request,
  orderId: string,
  settings: { stripeSecretKey: string },
  userId: string,
): Promise<Response> {
  let body: { amountCents?: number; reason?: string; notes?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (typeof body.amountCents !== 'number') {
    return Response.json({ error: 'amountCents required' }, { status: 400 })
  }
  const validation = await validateRefundAmount(api.db, orderId, body.amountCents)
  if (!validation.ok) {
    return Response.json({ error: validation.reason }, { status: 400 })
  }
  // Create the pending refund
  const refund = await createRefund(api.db, {
    id: `ref_${nanoid(10)}`,
    orderId,
    amountCents: body.amountCents,
    currency: validation.order.currency,
    reason: body.reason ?? '',
    refundedByUserId: userId,
    notes: body.notes ?? null,
  })
  // Call Stripe
  if (!settings.stripeSecretKey) {
    return Response.json({
      refund,
      warning: 'stripe_not_configured — refund recorded but not processed',
    }, { status: 201 })
  }
  // Look up the order's payment intent
  const { rows: orderRows } = await api.db`
    select stripe_payment_intent_id from orders where id = ${orderId} limit 1
  `
  const paymentIntentId = orderRows[0]?.stripe_payment_intent_id
  if (!paymentIntentId) {
    await markRefundFailed(api.db, refund.id, 'no_payment_intent')
    return Response.json({ error: 'order_has_no_payment_intent' }, { status: 400 })
  }
  try {
    const res = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        payment_intent: String(paymentIntentId),
        amount: String(body.amountCents),
        reason: body.reason === 'duplicate' || body.reason === 'fraudulent' ? body.reason : 'requested_by_customer',
      }),
    })
    if (!res.ok) {
      const errBody = await res.text()
      await markRefundFailed(api.db, refund.id, `stripe_error: ${res.status} ${errBody}`)
      return Response.json({ error: 'stripe_error', detail: errBody }, { status: 502 })
    }
    const stripeRefund = await res.json() as { id: string }
    await markRefundSucceeded(api.db, refund.id, stripeRefund.id)
    return Response.json({ refundId: refund.id, stripeRefundId: stripeRefund.id, status: 'succeeded' })
  } catch (err) {
    await markRefundFailed(api.db, refund.id, err instanceof Error ? err.message : String(err))
    return Response.json({ error: 'stripe_call_failed' }, { status: 502 })
  }
}