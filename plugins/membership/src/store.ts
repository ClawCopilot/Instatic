/**
 * DB CRUD for membership plugin.
 *
 * Subscription state machine:
 *   trialing   → active    (trial converted, payment OK)
 *   trialing   → canceled  (trial ended without conversion)
 *   active     → past_due  (payment failed, grace period)
 *   active     → canceled  (user cancellation effective)
 *   past_due   → active    (payment recovered)
 *   past_due   → canceled  (grace period elapsed)
 */

import type { DbClient } from '@instatic/plugin-sdk/host'

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete'
export type BillingInterval = 'month' | 'year' | 'one_time'

export interface MembershipTier {
  id: string
  slug: string
  name: string
  description: string
  rank: number
  priceCents: number
  currency: string
  billingInterval: BillingInterval
  stripePriceId: string | null
  features: string[]
  isDefault: boolean
  isPublic: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface Subscription {
  id: string
  userId: string
  tierId: string
  status: SubscriptionStatus
  trialEndsAt: string | null
  currentPeriodStart: string
  currentPeriodEnd: string
  canceledAt: string | null
  cancelAt: string | null
  stripeSubscriptionId: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

interface TierRow {
  id: string
  slug: string
  name: string
  description: string
  rank: number
  price_cents: number
  currency: string
  billing_interval: string
  stripe_price_id: string | null
  features_json: string | unknown[]
  is_default: boolean | number
  is_public: boolean | number
  sort_order: number
  created_at: string
  updated_at: string
}

interface SubRow {
  id: string
  user_id: string
  tier_id: string
  status: string
  trial_ends_at: string | null
  current_period_start: string
  current_period_end: string
  canceled_at: string | null
  cancel_at: string | null
  stripe_subscription_id: string | null
  metadata_json: string | unknown
  created_at: string
  updated_at: string
}

function rowToTier(row: TierRow): MembershipTier {
  const features = row.features_json
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    rank: row.rank,
    priceCents: row.price_cents,
    currency: row.currency,
    billingInterval: row.billing_interval as BillingInterval,
    stripePriceId: row.stripe_price_id,
    features: Array.isArray(features) ? (features as string[]) : JSON.parse(String(features)),
    isDefault: !!row.is_default,
    isPublic: !!row.is_public,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSub(row: SubRow): Subscription {
  const meta = row.metadata_json
  return {
    id: row.id,
    userId: row.user_id,
    tierId: row.tier_id,
    status: row.status as SubscriptionStatus,
    trialEndsAt: row.trial_ends_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    canceledAt: row.canceled_at,
    cancelAt: row.cancel_at,
    stripeSubscriptionId: row.stripe_subscription_id,
    metadata: typeof meta === 'string' ? JSON.parse(meta) : (meta as Record<string, unknown>),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ─── Tiers ────────────────────────────────────────────────────────────────

export async function listPublicTiers(db: DbClient): Promise<MembershipTier[]> {
  const { rows } = await db<TierRow>`
    select * from membership_tiers
    where deleted_at is null and is_public = true
    order by sort_order, rank
  `
  return rows.map(rowToTier)
}

export async function listAllTiers(db: DbClient): Promise<MembershipTier[]> {
  const { rows } = await db<TierRow>`
    select * from membership_tiers
    where deleted_at is null
    order by sort_order, rank
  `
  return rows.map(rowToTier)
}

export async function findTierBySlug(db: DbClient, slug: string): Promise<MembershipTier | null> {
  const { rows } = await db<TierRow>`
    select * from membership_tiers
    where slug = ${slug} and deleted_at is null
    limit 1
  `
  return rows[0] ? rowToTier(rows[0]) : null
}

export async function findTierById(db: DbClient, id: string): Promise<MembershipTier | null> {
  const { rows } = await db<TierRow>`
    select * from membership_tiers
    where id = ${id} and deleted_at is null
    limit 1
  `
  return rows[0] ? rowToTier(rows[0]) : null
}

export async function createTier(
  db: DbClient,
  args: Omit<MembershipTier, 'createdAt' | 'updatedAt'>,
): Promise<MembershipTier> {
  const { rows } = await db<TierRow>`
    insert into membership_tiers (
      id, slug, name, description, rank, price_cents, currency, billing_interval,
      stripe_price_id, features_json, is_default, is_public, sort_order
    ) values (
      ${args.id}, ${args.slug}, ${args.name}, ${args.description}, ${args.rank},
      ${args.priceCents}, ${args.currency}, ${args.billingInterval},
      ${args.stripePriceId}, ${JSON.stringify(args.features)}::jsonb,
      ${args.isDefault}, ${args.isPublic}, ${args.sortOrder}
    )
    returning *
  `
  return rowToTier(rows[0])
}

export async function updateTier(
  db: DbClient,
  id: string,
  patch: Partial<Omit<MembershipTier, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<MembershipTier | null> {
  const fields: string[] = []
  const values: unknown[] = []
  let i = 1
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k === 'priceCents' ? 'price_cents' : k === 'billingInterval' ? 'billing_interval' : k === 'stripePriceId' ? 'stripe_price_id' : k === 'isDefault' ? 'is_default' : k === 'isPublic' ? 'is_public' : k === 'sortOrder' ? 'sort_order' : k} = $${i++}`)
    values.push(k === 'features' ? JSON.stringify(v) : v)
  }
  fields.push(`updated_at = now()`)
  const { rows } = await db.unsafe(
    `update membership_tiers set ${fields.join(', ')} where id = $${i} and deleted_at is null returning *`,
    [...values, id],
  ) as { rows: TierRow[] }
  return rows[0] ? rowToTier(rows[0]) : null
}

// ─── Subscriptions ────────────────────────────────────────────────────────

/**
 * Get the user's currently active (or trial) subscription, if any.
 * Past-due subscriptions still count as "active" during the grace period.
 */
export async function getActiveSubscription(
  db: DbClient,
  userId: string,
  gracePeriodDays: number = 3,
): Promise<{ subscription: Subscription; tier: MembershipTier } | null> {
  const graceCutoff = new Date(Date.now() - gracePeriodDays * 86_400_000).toISOString()
  const { rows } = await db<SubRow>`
    select * from subscriptions
    where user_id = ${userId}
      and status in ('trialing', 'active', 'past_due')
      and current_period_end > ${graceCutoff}
    order by current_period_end desc
    limit 1
  `
  if (!rows[0]) return null
  const sub = rowToSub(rows[0])
  const tier = await findTierById(db, sub.tierId)
  if (!tier) return null
  return { subscription: sub, tier }
}

export async function createSubscription(
  db: DbClient,
  args: Omit<Subscription, 'createdAt' | 'updatedAt' | 'canceledAt' | 'cancelAt'>,
): Promise<Subscription> {
  const { rows } = await db<SubRow>`
    insert into subscriptions (
      id, user_id, tier_id, status, trial_ends_at,
      current_period_start, current_period_end,
      stripe_subscription_id, metadata_json
    ) values (
      ${args.id}, ${args.userId}, ${args.tierId}, ${args.status},
      ${args.trialEndsAt}, ${args.currentPeriodStart}, ${args.currentPeriodEnd},
      ${args.stripeSubscriptionId}, ${JSON.stringify(args.metadata)}::jsonb
    )
    returning *
  `
  return rowToSub(rows[0])
}

export async function cancelSubscription(
  db: DbClient,
  userId: string,
  atPeriodEnd: boolean = true,
): Promise<Subscription | null> {
  if (atPeriodEnd) {
    // Defer cancellation to the end of the current period.
    const { rows } = await db<SubRow>`
      update subscriptions
      set cancel_at = current_period_end, updated_at = now()
      where user_id = ${userId}
        and status in ('trialing', 'active', 'past_due')
        and cancel_at is null
      returning *
    `
    return rows[0] ? rowToSub(rows[0]) : null
  }
  const { rows } = await db<SubRow>`
    update subscriptions
    set status = 'canceled', canceled_at = now(), updated_at = now()
    where user_id = ${userId}
      and status in ('trialing', 'active', 'past_due')
    returning *
  `
  return rows[0] ? rowToSub(rows[0]) : null
}

export async function recordSubscriptionStatus(
  db: DbClient,
  stripeSubscriptionId: string,
  status: SubscriptionStatus,
  currentPeriodEnd: string,
): Promise<void> {
  await db`
    update subscriptions
    set status = ${status},
        current_period_end = ${currentPeriodEnd},
        updated_at = now()
    where stripe_subscription_id = ${stripeSubscriptionId}
  `
}