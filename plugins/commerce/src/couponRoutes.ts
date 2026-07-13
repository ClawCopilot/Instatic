/**
 * Coupon + variant route handlers.
 *
 * Public:
 *   POST /api/commerce/coupons/validate  { code, subtotalCents, items } → { discountCents, ... }
 *   POST /api/commerce/coupons/apply     { code, orderId } → 200 (records redemption)
 *
 * Admin (content.manage):
 *   GET    /api/admin/commerce/coupons
 *   POST   /api/admin/commerce/coupons
 *   PATCH  /api/admin/commerce/coupons/:id
 *   DELETE /api/admin/commerce/coupons/:id
 *   GET    /api/admin/commerce/coupons/:id/redemptions
 *
 * Variants (admin only):
 *   GET    /api/admin/commerce/products/:productId/variants
 *   POST   /api/admin/commerce/products/:productId/variants
 *   DELETE /api/admin/commerce/variants/:id
 *   POST   /api/admin/commerce/variants/:id/restock { delta, notes? }
 */

import { createHash, randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import {
  applyCoupon,
  computeDiscount,
  createCoupon,
  deleteCoupon,
  findCouponById,
  generateCouponCode,
  listCoupons,
  listRedemptionsForCoupon,
  recordCouponRedemption,
  updateCoupon,
  type Coupon,
  type CouponApplicability,
} from './coupons'
import {
  adjustVariantInventory,
  deleteVariant,
  findVariant,
  getVariantInventory,
  getVariantInventories,
  listVariantsForProduct,
  syncVariantsForProduct,
  upsertVariant,
} from './variants'

// ─── Coupon routes ──────────────────────────────────────────────────────

export async function handleValidateCoupon(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: { code?: string; subtotalCents?: number; items?: Array<{ productId: string; productSlug: string; priceCents: number }> }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.code || typeof body.subtotalCents !== 'number' || !Array.isArray(body.items)) {
    return Response.json({ error: 'code, subtotalCents, items required' }, { status: 400 })
  }
  const viewer = api.viewer as { userId?: string } | undefined
  if (!viewer?.userId) return Response.json({ error: 'login_required' }, { status: 401 })
  // We need a fake orderId for the validation transaction; we'll just use the user id.
  const result = await applyCoupon(api.db, {
    code: body.code,
    userId: viewer.userId,
    orderId: '__validate__',
    cartSubtotalCents: body.subtotalCents,
    cartItems: body.items,
  })
  if (!result.ok) {
    return Response.json({ valid: false, reason: result.reason }, { status: 200 })
  }
  return Response.json({
    valid: true,
    code: result.coupon!.code,
    type: result.coupon!.type,
    value: result.coupon!.value,
    discountCents: result.discountCents,
    description: result.coupon!.description,
  })
}

export async function handleApplyCoupon(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: { code?: string; orderId?: string; subtotalCents?: number; items?: Array<{ productId: string; productSlug: string; priceCents: number }> }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const viewer = api.viewer as { userId?: string } | undefined
  if (!viewer?.userId) return Response.json({ error: 'login_required' }, { status: 401 })
  if (!body.code || !body.orderId || typeof body.subtotalCents !== 'number' || !Array.isArray(body.items)) {
    return Response.json({ error: 'code, orderId, subtotalCents, items required' }, { status: 400 })
  }
  const validation = await applyCoupon(api.db, {
    code: body.code,
    userId: viewer.userId,
    orderId: body.orderId,
    cartSubtotalCents: body.subtotalCents,
    cartItems: body.items,
  })
  if (!validation.ok || !validation.coupon || validation.discountCents === undefined) {
    return Response.json({ error: validation.reason ?? 'invalid_coupon' }, { status: 400 })
  }
  const redemption = await recordCouponRedemption(api.db, {
    couponId: validation.coupon.id,
    userId: viewer.userId,
    orderId: body.orderId,
    discountCents: validation.discountCents,
  })
  return Response.json({
    applied: true,
    redemptionId: redemption.id,
    discountCents: redemption.discountCents,
  })
}

// ─── Admin: coupon CRUD ──────────────────────────────────────────────────

export async function handleAdminListCoupons(api: ApiCallContext): Promise<Response> {
  const coupons = await listCoupons(api.db)
  return Response.json({ coupons })
}

export async function handleAdminCreateCoupon(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const code = body.code ? String(body.code) : generateCouponCode()
  const applicableTo: CouponApplicability = body.applicableTo
    ? (body.applicableTo as CouponApplicability)
    : { kind: 'all' }
  const coupon = await createCoupon(api.db, {
    id: `cpn_${randomBytes(8).toString('hex')}`,
    code,
    type: (body.type as 'percent' | 'fixed') ?? 'percent',
    value: Number(body.value ?? 0),
    minOrderCents: Number(body.minOrderCents ?? 0),
    maxUses: Number(body.maxUses ?? 0),
    maxUsesPerUser: Number(body.maxUsesPerUser ?? 0),
    currentUses: 0,
    validFrom: String(body.validFrom ?? new Date().toISOString()),
    validUntil: String(body.validUntil ?? new Date(Date.now() + 30 * 86_400_000).toISOString()),
    applicableTo,
    enabled: body.enabled !== false,
    description: String(body.description ?? ''),
  })
  return Response.json({ coupon }, { status: 201 })
}

export async function handleAdminUpdateCoupon(
  api: ApiCallContext,
  req: Request,
  couponId: string,
): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const coupon = await updateCoupon(api.db, couponId, body as Partial<Coupon>)
  if (!coupon) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json({ coupon })
}

export async function handleAdminDeleteCoupon(
  api: ApiCallContext,
  couponId: string,
): Promise<Response> {
  await deleteCoupon(api.db, couponId)
  return Response.json({ deleted: true })
}

export async function handleAdminListRedemptions(
  api: ApiCallContext,
  couponId: string,
): Promise<Response> {
  const redemptions = await listRedemptionsForCoupon(api.db, couponId)
  return Response.json({ redemptions })
}

// ─── Admin: variant CRUD ────────────────────────────────────────────────

export async function handleAdminListVariants(
  api: ApiCallContext,
  productId: string,
): Promise<Response> {
  const variants = await listVariantsForProduct(api.db, productId)
  const inventories = await getVariantInventories(api.db, productId)
  return Response.json({
    variants: variants.map((v) => ({ ...v, available: inventories.get(v.id) ?? 0 })),
  })
}

export async function handleAdminSyncVariants(
  api: ApiCallContext,
  req: Request,
  productId: string,
): Promise<Response> {
  let body: { variants?: Array<{ variantKey: string; sku: string; label: string; priceCents: number; attributes?: Record<string, string> }> }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!Array.isArray(body.variants)) {
    return Response.json({ error: 'variants array required' }, { status: 400 })
  }
  const synced = await syncVariantsForProduct(api.db, productId, body.variants)
  return Response.json({ variants: synced })
}

export async function handleAdminDeleteVariant(
  api: ApiCallContext,
  variantId: string,
): Promise<Response> {
  await deleteVariant(api.db, variantId)
  return Response.json({ deleted: true })
}

export async function handleAdminRestockVariant(
  api: ApiCallContext,
  req: Request,
  variantId: string,
): Promise<Response> {
  let body: { delta?: number; notes?: string }
  try {
    body = await req.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (typeof body.delta !== 'number' || body.delta === 0) {
    return Response.json({ error: 'non-zero delta required' }, { status: 400 })
  }
  // Look up the variant to get product_id
  const { rows } = await api.db`select product_id from product_variants where id = ${variantId} limit 1`
  if (!rows[0]) return Response.json({ error: 'not_found' }, { status: 404 })
  await adjustVariantInventory(
    api.db,
    rows[0].product_id,
    variantId,
    body.delta,
    'restock',
    null,
  )
  return Response.json({ adjusted: true })
}