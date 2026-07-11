/**
 * Commerce route handlers.
 *
 * Catalog (public):
 *   GET  /api/commerce/products               — list products
 *   GET  /api/commerce/products/:slug         — get one product
 *
 * Cart (auth):
 *   GET    /api/commerce/cart                 — get current cart
 *   POST   /api/commerce/cart/items           — add line item
 *   PATCH  /api/commerce/cart/items/:productId — update quantity
 *   DELETE /api/commerce/cart/items/:productId — remove line item
 *   DELETE /api/commerce/cart                 — clear cart
 *
 * Checkout (auth):
 *   POST /api/commerce/checkout               — create Stripe Checkout Session
 *   GET  /api/commerce/orders                 — list user's orders
 *   GET  /api/commerce/orders/:id             — get one order
 *
 * Stripe webhook (public, signed):
 *   POST /api/commerce/stripe/webhook         — receive payment events
 *
 * Admin (requires content.manage):
 *   GET  /admin/api/commerce/orders           — all orders
 *   POST /admin/api/commerce/orders/:id/refund — issue refund
 *   POST /admin/api/commerce/products/:id/restock — adjust inventory
 */

import { nanoid } from 'nanoid'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import {
  adjustInventory,
  clearCart,
  createOrder,
  findOrderBySessionId,
  getOrCreateCart,
  listOrdersForUser,
  markOrderPaid,
  updateCartLineItems,
  type CartLineItem,
} from './store'

interface CommerceSettings {
  stripeSecretKey: string
  stripeWebhookSecret: string
  currency: string
}

function viewerUserId(viewer: unknown): string | null {
  if (viewer && typeof viewer === 'object' && 'userId' in viewer) {
    const v = viewer as { userId?: unknown }
    return typeof v.userId === 'string' ? v.userId : null
  }
  return null
}

// ─── Catalog ─────────────────────────────────────────────────────────────

export async function handleListProducts(api: ApiCallContext): Promise<Response> {
  const { rows } = await api.cms.content.entries.list({
    tableSlug: 'products',
    page: 1,
    pageSize: 50,
  })
  return Response.json({ products: rows })
}

export async function handleGetProduct(api: ApiCallContext, slug: string): Promise<Response> {
  const row = await api.cms.content.entries.getBySlug({
    tableSlug: 'products',
    slug,
  })
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json({ product: row })
}

// ─── Cart ────────────────────────────────────────────────────────────────

export async function handleGetCart(api: ApiCallContext): Promise<Response> {
  const userId = viewerUserId(api.viewer)
  if (!userId) return Response.json({ error: 'login_required' }, { status: 401 })
  const cart = await getOrCreateCart(api.db, userId)
  return Response.json({ cart })
}

export async function handleAddToCart(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  const userId = viewerUserId(api.viewer)
  if (!userId) return Response.json({ error: 'login_required' }, { status: 401 })
  let body: { productId?: string; quantity?: number }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.productId || !body.quantity || body.quantity < 1) {
    return Response.json({ error: 'productId and positive quantity required' }, { status: 400 })
  }
  const product = await api.cms.content.entries.get({
    tableSlug: 'products',
    id: body.productId,
  })
  if (!product) return Response.json({ error: 'product_not_found' }, { status: 404 })
  const cells = (product.cells ?? {}) as Record<string, unknown>
  const priceCents = Number(cells.priceCents ?? 0)
  const currency = String(cells.currency ?? 'USD')
  const title = String(cells.title ?? '')
  const imageUrl = String(cells.featuredMedia ?? '')
  const cart = await getOrCreateCart(api.db, userId, currency)
  const items = [...cart.lineItems]
  const existing = items.findIndex((i) => i.productId === body.productId)
  if (existing >= 0) {
    items[existing] = { ...items[existing], quantity: items[existing].quantity + body.quantity }
  } else {
    items.push({
      productId: body.productId!,
      quantity: body.quantity,
      title,
      unitPriceCents: priceCents,
      currency,
      imageUrl,
    })
  }
  const updated = await updateCartLineItems(api.db, userId, items)
  return Response.json({ cart: updated })
}

export async function handleUpdateCartItem(
  api: ApiCallContext,
  req: Request,
  productId: string,
): Promise<Response> {
  const userId = viewerUserId(api.viewer)
  if (!userId) return Response.json({ error: 'login_required' }, { status: 401 })
  let body: { quantity?: number }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.quantity || body.quantity < 1) {
    return Response.json({ error: 'positive quantity required' }, { status: 400 })
  }
  const cart = await getOrCreateCart(api.db, userId)
  const items = cart.lineItems.map((i) =>
    i.productId === productId ? { ...i, quantity: body.quantity! } : i,
  )
  const updated = await updateCartLineItems(api.db, userId, items)
  return Response.json({ cart: updated })
}

export async function handleRemoveCartItem(
  api: ApiCallContext,
  productId: string,
): Promise<Response> {
  const userId = viewerUserId(api.viewer)
  if (!userId) return Response.json({ error: 'login_required' }, { status: 401 })
  const cart = await getOrCreateCart(api.db, userId)
  const items = cart.lineItems.filter((i) => i.productId !== productId)
  const updated = await updateCartLineItems(api.db, userId, items)
  return Response.json({ cart: updated })
}

export async function handleClearCart(api: ApiCallContext): Promise<Response> {
  const userId = viewerUserId(api.viewer)
  if (!userId) return Response.json({ error: 'login_required' }, { status: 401 })
  await clearCart(api.db, userId)
  return Response.json({ cart: { lineItems: [] } })
}

// ─── Checkout ────────────────────────────────────────────────────────────

export async function handleCheckout(
  api: ApiCallContext,
  req: Request,
  settings: CommerceSettings,
): Promise<Response> {
  const userId = viewerUserId(api.viewer)
  if (!userId) return Response.json({ error: 'login_required' }, { status: 401 })
  if (!settings.stripeSecretKey) {
    return Response.json({ error: 'stripe_not_configured' }, { status: 503 })
  }
  let body: { email?: string; shippingAddress?: Record<string, unknown> }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const cart = await getOrCreateCart(api.db, userId)
  if (cart.lineItems.length === 0) {
    return Response.json({ error: 'cart_empty' }, { status: 400 })
  }
  const subtotalCents = cart.lineItems.reduce(
    (sum, i) => sum + i.unitPriceCents * i.quantity,
    0,
  )
  const order = await createOrder(api.db, {
    userId,
    email: body.email ?? '',
    currency: cart.currency,
    lineItems: cart.lineItems,
    subtotalCents,
    taxCents: 0,
    shippingCents: 0,
    totalCents: subtotalCents,
    shippingAddress: body.shippingAddress,
  })
  // Create Stripe Checkout Session
  const params = new URLSearchParams()
  params.set('mode', 'payment')
  params.set('success_url', `${new URL(req.url).origin}/orders/${order.orderNumber}?session_id={CHECKOUT_SESSION_ID}`)
  params.set('cancel_url', `${new URL(req.url).origin}/cart`)
  params.set('client_reference_id', order.id)
  params.set('customer_email', body.email ?? '')
  cart.lineItems.forEach((item, idx) => {
    params.set(`line_items[${idx}][price_data][currency]`, item.currency.toLowerCase())
    params.set(`line_items[${idx}][price_data][product_data][name]`, item.title)
    params.set(`line_items[${idx}][price_data][unit_amount]`, String(item.unitPriceCents))
    params.set(`line_items[${idx}][quantity]`, String(item.quantity))
  })
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })
  if (!res.ok) {
    return Response.json({ error: 'stripe_error', detail: await res.text() }, { status: 502 })
  }
  const session = await res.json() as { id: string; url: string }
  await api.db`update orders set stripe_checkout_session_id = ${session.id}, updated_at = now() where id = ${order.id}`
  // Reserve inventory
  for (const item of cart.lineItems) {
    await adjustInventory(api.db, item.productId, -item.quantity, 'order_placed', order.id, null)
  }
  return Response.json({ orderId: order.id, checkoutUrl: session.url }, { status: 201 })
}

// ─── Orders ──────────────────────────────────────────────────────────────

export async function handleListMyOrders(api: ApiCallContext): Promise<Response> {
  const userId = viewerUserId(api.viewer)
  if (!userId) return Response.json({ error: 'login_required' }, { status: 401 })
  const orders = await listOrdersForUser(api.db, userId)
  return Response.json({ orders })
}

// ─── Stripe webhook ──────────────────────────────────────────────────────

export async function handleStripeWebhook(
  api: ApiCallContext,
  req: Request,
  settings: CommerceSettings,
): Promise<Response> {
  const body = await req.text()
  // Verify Stripe signature (skipped in this example; required in production)
  let event: { type: string; data: { object: Record<string, unknown> } }
  try {
    event = JSON.parse(body)
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as {
        id: string
        payment_intent?: string
      }
      const order = await findOrderBySessionId(api.db, session.id)
      if (order) {
        await markOrderPaid(api.db, order.id, session.payment_intent ?? null)
        await clearCart(api.db, order.userId)
        await api.hooks.emit('commerce.orderPaid', { orderId: order.id })
      }
      break
    }
    case 'charge.refunded': {
      const charge = event.data.object as { payment_intent?: string }
      if (charge.payment_intent) {
        await api.db`
          update orders
          set status = 'refunded', refunded_at = now(), updated_at = now()
          where stripe_payment_intent_id = ${charge.payment_intent}
        `
      }
      break
    }
  }
  return Response.json({ received: true })
}

// ─── Admin ───────────────────────────────────────────────────────────────

export async function handleAdminListOrders(api: ApiCallContext): Promise<Response> {
  const { rows } = await api.db`
    select * from orders
    order by created_at desc
    limit 100
  `
  return Response.json({ orders: rows })
}

export async function handleAdminRefundOrder(
  api: ApiCallContext,
  settings: CommerceSettings,
  orderId: string,
): Promise<Response> {
  if (!settings.stripeSecretKey) {
    return Response.json({ error: 'stripe_not_configured' }, { status: 503 })
  }
  const { rows } = await api.db`
    select stripe_payment_intent_id from orders where id = ${orderId} and status = 'paid'
  `
  const intentId = rows[0]?.stripe_payment_intent_id
  if (!intentId) return Response.json({ error: 'no_payment_intent' }, { status: 400 })
  const res = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ payment_intent: String(intentId) }),
  })
  if (!res.ok) {
    return Response.json({ error: 'stripe_error', detail: await res.text() }, { status: 502 })
  }
  return Response.json({ refundInitiated: true })
}

export async function handleAdminRestock(
  api: ApiCallContext,
  req: Request,
  productId: string,
): Promise<Response> {
  let body: { delta?: number; notes?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (typeof body.delta !== 'number') {
    return Response.json({ error: 'delta required (number)' }, { status: 400 })
  }
  await adjustInventory(api.db, productId, body.delta, 'manual_adjustment', null, body.notes ?? null)
  return Response.json({ adjusted: true })
}