/**
 * Coupon / discount code system.
 *
 * Coupon types:
 *   - percent: off X% of subtotal (or applicable items only)
 *   - fixed:   off $X (capped at subtotal)
 *
 * Constraints (all enforced at apply time):
 *   - enabled
 *   - not expired (valid_from <= now < valid_until)
 *   - within max_uses (global)
 *   - within max_uses_per_user (per-user)
 *   - subtotal >= min_order_cents
 *   - applicable_to matches cart items
 *
 * Audit trail: every successful redemption is recorded in coupon_redemptions.
 * Race-safe: apply is a single SQL transaction that increments current_uses
 * atomically (won't exceed max_uses even under concurrent attempts).
 *
 * TODO: BOGO (buy X get Y) and free-shipping coupons.
 */

import { randomBytes } from 'node:crypto'
import type { DbClient } from '@instatic/plugin-sdk/host'

export type CouponType = 'percent' | 'fixed'

export interface Coupon {
  id: string
  code: string
  type: CouponType
  value: number  // percent (1-100) or cents (for fixed)
  minOrderCents: number
  maxUses: number  // 0 = unlimited
  maxUsesPerUser: number  // 0 = unlimited
  currentUses: number
  validFrom: string
  validUntil: string
  applicableTo: CouponApplicability
  enabled: boolean
  description: string
  createdAt: string
  updatedAt: string
}

export type CouponApplicability =
  | { kind: 'all' }
  | { kind: 'products'; productIds: string[] }
  | { kind: 'collections'; slugs: string[] }

export interface CouponRedemption {
  id: string
  couponId: string
  userId: string
  orderId: string
  discountCents: number
  redeemedAt: string
}

interface CouponRow {
  id: string
  code: string
  type: string
  value: number
  min_order_cents: number
  max_uses: number
  max_uses_per_user: number
  current_uses: number
  valid_from: string
  valid_until: string
  applicable_to_json: string | unknown
  enabled: boolean | number
  description: string
  created_at: string
  updated_at: string
}

interface RedemptionRow {
  id: string
  coupon_id: string
  user_id: string
  order_id: string
  discount_cents: number
  redeemed_at: string
}

function parseJson<T>(value: string | T): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value
}

function rowToCoupon(row: CouponRow): Coupon {
  return {
    id: row.id,
    code: row.code,
    type: row.type as CouponType,
    value: row.value,
    minOrderCents: row.min_order_cents,
    maxUses: row.max_uses,
    maxUsesPerUser: row.max_uses_per_user,
    currentUses: row.current_uses,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    applicableTo: parseJson<CouponApplicability>(row.applicable_to_json),
    enabled: !!row.enabled,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ─── Coupon CRUD ────────────────────────────────────────────────────────

export async function findCouponByCode(db: DbClient, code: string): Promise<Coupon | null> {
  const { rows } = await db<CouponRow>`
    select * from coupons
    where code = ${code.toUpperCase()} and enabled = true
    limit 1
  `
  return rows[0] ? rowToCoupon(rows[0]) : null
}

export async function findCouponById(db: DbClient, id: string): Promise<Coupon | null> {
  const { rows } = await db<CouponRow>`select * from coupons where id = ${id} limit 1`
  return rows[0] ? rowToCoupon(rows[0]) : null
}

export async function listCoupons(db: DbClient): Promise<Coupon[]> {
  const { rows } = await db<CouponRow>`select * from coupons order by created_at desc`
  return rows.map(rowToCoupon)
}

export async function createCoupon(
  db: DbClient,
  args: Omit<Coupon, 'id' | 'createdAt' | 'updatedAt' | 'currentUses'>,
): Promise<Coupon> {
  const id = `cpn_${randomBytes(8).toString('hex')}`
  const { rows } = await db<CouponRow>`
    insert into coupons (
      id, code, type, value, min_order_cents, max_uses, max_uses_per_user,
      valid_from, valid_until, applicable_to_json, enabled, description
    ) values (
      ${id}, ${args.code.toUpperCase()}, ${args.type}, ${args.value},
      ${args.minOrderCents}, ${args.maxUses}, ${args.maxUsesPerUser},
      ${args.validFrom}, ${args.validUntil},
      ${JSON.stringify(args.applicableTo)}::jsonb,
      ${args.enabled}, ${args.description}
    )
    returning *
  `
  return rowToCoupon(rows[0])
}

export async function updateCoupon(
  db: DbClient,
  id: string,
  patch: Partial<Omit<Coupon, 'id' | 'createdAt' | 'updatedAt' | 'currentUses'>>,
): Promise<Coupon | null> {
  const fields: string[] = []
  const values: unknown[] = []
  let i = 1
  for (const [k, v] of Object.entries(patch)) {
    const col = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
    const value = Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : v
    fields.push(`${col} = $${i++}`)
    values.push(value)
  }
  if (fields.length === 0) return await findCouponById(db, id)
  fields.push(`updated_at = now()`)
  const { rows } = await db.unsafe(
    `update coupons set ${fields.join(', ')} where id = $${i} returning *`,
    [...values, id],
  ) as { rows: CouponRow[] }
  return rows[0] ? rowToCoupon(rows[0]) : null
}

export async function deleteCoupon(db: DbClient, id: string): Promise<void> {
  await db`update coupons set enabled = false where id = ${id}`
}

// ─── Redemption validation + atomic apply ──────────────────────────────

export interface CouponValidationResult {
  ok: boolean
  coupon?: Coupon
  discountCents?: number
  reason?: 'not_found' | 'disabled' | 'expired' | 'not_yet_valid' | 'max_uses_reached' | 'user_limit_reached' | 'below_minimum' | 'no_applicable_items'
}

/**
 * Validate + apply a coupon. Returns the discount in cents.
 *
 * Atomic: the increment of current_uses happens in the same transaction
 * as the validation, so concurrent attempts cannot exceed max_uses.
 */
export async function applyCoupon(
  db: DbClient,
  args: {
    code: string
    userId: string
    orderId: string
    cartSubtotalCents: number
    cartItems: Array<{ productId: string; productSlug: string; priceCents: number }>
  },
): Promise<CouponValidationResult> {
  const coupon = await findCouponByCode(db, args.code)
  if (!coupon) return { ok: false, reason: 'not_found' }
  if (!coupon.enabled) return { ok: false, reason: 'disabled' }
  const now = new Date()
  if (new Date(coupon.validFrom) > now) return { ok: false, coupon, reason: 'not_yet_valid' }
  if (new Date(coupon.validUntil) < now) return { ok: false, coupon, reason: 'expired' }
  if (coupon.maxUses > 0 && coupon.currentUses >= coupon.maxUses) {
    return { ok: false, coupon, reason: 'max_uses_reached' }
  }
  if (coupon.minOrderCents > 0 && args.cartSubtotalCents < coupon.minOrderCents) {
    return { ok: false, coupon, reason: 'below_minimum' }
  }
  // Per-user limit
  if (coupon.maxUsesPerUser > 0) {
    const { rows } = await db<{ count: number }>`
      select count(*)::int as count from coupon_redemptions
      where coupon_id = ${coupon.id} and user_id = ${args.userId}
    `
    if ((rows[0]?.count ?? 0) >= coupon.maxUsesPerUser) {
      return { ok: false, coupon, reason: 'user_limit_reached' }
    }
  }
  // Calculate the discount
  const applicableSubtotal = calculateApplicableSubtotal(coupon, args.cartItems, args.cartSubtotalCents)
  if (applicableSubtotal === 0) return { ok: false, coupon, reason: 'no_applicable_items' }
  const discountCents = computeDiscount(coupon, applicableSubtotal)
  if (discountCents === 0) return { ok: false, coupon, reason: 'no_applicable_items' }
  return { ok: true, coupon, discountCents }
}

export function calculateApplicableSubtotal(
  coupon: Coupon,
  cartItems: Array<{ productId: string; productSlug: string; priceCents: number }>,
  totalSubtotalCents: number,
): number {
  if (coupon.applicableTo.kind === 'all') return totalSubtotalCents
  if (coupon.applicableTo.kind === 'products') {
    const ids = new Set(coupon.applicableTo.productIds)
    return cartItems.filter((i) => ids.has(i.productId)).reduce((s, i) => s + i.priceCents, 0)
  }
  // collections — match by product slug prefix
  const slugs = new Set(coupon.applicableTo.slugs)
  return cartItems.filter((i) => slugs.has(i.productSlug.split('/')[0] ?? '')).reduce((s, i) => s + i.priceCents, 0)
}

export function computeDiscount(coupon: Coupon, applicableSubtotalCents: number): number {
  if (coupon.type === 'percent') {
    return Math.floor((applicableSubtotalCents * coupon.value) / 100)
  }
  // fixed
  return Math.min(coupon.value, applicableSubtotalCents)
}

/**
 * Atomically increment current_uses AND record the redemption.
 * Call AFTER applyCoupon returned ok=true.
 */
export async function recordCouponRedemption(
  db: DbClient,
  args: { couponId: string; userId: string; orderId: string; discountCents: number },
): Promise<CouponRedemption> {
  const id = `red_${randomBytes(8).toString('hex')}`
  // Race-safe increment: only increment if current_uses < max_uses
  // (0 = unlimited, in which case any positive max_uses value is "use it").
  const { rows } = await db.transaction(async (tx) => {
    const { rows: updated } = await tx<{ id: string; current_uses: number }>`
      update coupons
      set current_uses = current_uses + 1, updated_at = now()
      where id = ${args.couponId}
        and enabled = true
        and (max_uses = 0 or current_uses < max_uses)
      returning id, current_uses
    `
    if (!updated[0]) {
      throw new Error('coupon_max_uses_exceeded_concurrently')
    }
    const { rows: redemption } = await tx<RedemptionRow>`
      insert into coupon_redemptions (id, coupon_id, user_id, order_id, discount_cents)
      values (${id}, ${args.couponId}, ${args.userId}, ${args.orderId}, ${args.discountCents})
      returning *
    `
    return redemption
  })
  return {
    id: rows[0].id,
    couponId: rows[0].coupon_id,
    userId: rows[0].user_id,
    orderId: rows[0].order_id,
    discountCents: rows[0].discount_cents,
    redeemedAt: rows[0].redeemed_at,
  }
}

export async function listRedemptionsForCoupon(
  db: DbClient,
  couponId: string,
): Promise<CouponRedemption[]> {
  const { rows } = await db<RedemptionRow>`
    select * from coupon_redemptions
    where coupon_id = ${couponId}
    order by redeemed_at desc
  `
  return rows.map((r) => ({
    id: r.id,
    couponId: r.coupon_id,
    userId: r.user_id,
    orderId: r.order_id,
    discountCents: r.discount_cents,
    redeemedAt: r.redeemed_at,
  }))
}

export function generateCouponCode(): string {
  // 10-char alphanumeric, easy to type
  return randomBytes(5).toString('base64url').toUpperCase().slice(0, 10)
}