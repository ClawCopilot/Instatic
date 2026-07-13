/**
 * Shipping cost calculation.
 *
 * Strategies:
 *   1. Free shipping — if subtotal ≥ freeThreshold, cost = 0
 *   2. Table-based rate — match a shipping_rates row by (country, region, subtotal range)
 *   3. Weight-based — sum of (variant.weight_grams * quantity), pick rate by weight range
 *   4. Fallback — flat rate from plugin settings
 *
 * Lookup order: free → table → flat fallback.
 *
 * TODO: real-time carrier API (UPS, FedEx, USPS) integration.
 */

import { randomBytes } from 'node:crypto'
import type { DbClient } from '@instatic/plugin-sdk/host'

export interface ShippingRate {
  id: string
  countryCode: string
  regionCode: string | null
  minSubtotalCents: number
  maxSubtotalCents: number
  minWeightGrams: number
  maxWeightGrams: number
  costCents: number
  currency: string
  enabled: boolean
  description: string
  sortOrder: number
}

export interface ShippingCalculation {
  costCents: number
  currency: string
  method: string  // 'free', 'rate-table', 'flat-fallback'
  rateId: string | null
  estimatedDaysMin: number | null
  estimatedDaysMax: number | null
}

interface RateRow {
  id: string
  country_code: string
  region_code: string | null
  min_subtotal_cents: number
  max_subtotal_cents: number
  min_weight_grams: number
  max_weight_grams: number
  cost_cents: number
  currency: string
  enabled: boolean | number
  description: string
  sort_order: number
}

function rowToRate(row: RateRow): ShippingRate {
  return {
    id: row.id,
    countryCode: row.country_code,
    regionCode: row.region_code,
    minSubtotalCents: row.min_subtotal_cents,
    maxSubtotalCents: row.max_subtotal_cents,
    minWeightGrams: row.min_weight_grams,
    maxWeightGrams: row.max_weight_grams,
    costCents: row.cost_cents,
    currency: row.currency,
    enabled: !!row.enabled,
    description: row.description,
    sortOrder: row.sort_order,
  }
}

export async function listShippingRates(db: DbClient): Promise<ShippingRate[]> {
  const { rows } = await db<RateRow>`select * from shipping_rates where enabled = true order by sort_order, country_code`
  return rows.map(rowToRate)
}

export async function upsertShippingRate(
  db: DbClient,
  args: Omit<ShippingRate, 'enabled'> & { enabled: boolean },
): Promise<ShippingRate> {
  const id = args.id || `ship_${randomBytes(8).toString('hex')}`
  const { rows } = await db<RateRow>`
    insert into shipping_rates (id, country_code, region_code, min_subtotal_cents, max_subtotal_cents,
                                min_weight_grams, max_weight_grams, cost_cents, currency,
                                enabled, description, sort_order)
    values (${id}, ${args.countryCode}, ${args.regionCode}, ${args.minSubtotalCents}, ${args.maxSubtotalCents},
            ${args.minWeightGrams}, ${args.maxWeightGrams}, ${args.costCents}, ${args.currency},
            ${args.enabled}, ${args.description}, ${args.sortOrder})
    on conflict (id) do update
    set country_code = excluded.country_code,
        region_code = excluded.region_code,
        min_subtotal_cents = excluded.min_subtotal_cents,
        max_subtotal_cents = excluded.max_subtotal_cents,
        min_weight_grams = excluded.min_weight_grams,
        max_weight_grams = excluded.max_weight_grams,
        cost_cents = excluded.cost_cents,
        currency = excluded.currency,
        enabled = excluded.enabled,
        description = excluded.description,
        sort_order = excluded.sort_order,
        updated_at = now()
    returning *
  `
  return rowToRate(rows[0])
}

export async function deleteShippingRate(db: DbClient, id: string): Promise<void> {
  await db`update shipping_rates set enabled = false where id = ${id}`
}

export interface ShippingInput {
  countryCode: string
  regionCode?: string | null
  subtotalCents: number
  totalWeightGrams: number
  currency?: string
}

export interface ShippingSettings {
  freeShippingThresholdCents: number
  fallbackFlatRateCents: number
  defaultCurrency: string
}

/**
 * Calculate the shipping cost for a cart.
 *
 * Lookup order:
 *   1. If subtotal ≥ freeShippingThreshold, return free shipping
 *   2. Look up the best matching shipping_rates row
 *   3. Fall back to flat rate from settings
 */
export async function calculateShipping(
  db: DbClient,
  input: ShippingInput,
  settings: ShippingSettings,
): Promise<ShippingCalculation> {
  const currency = input.currency ?? settings.defaultCurrency
  // 1. Free shipping threshold
  if (settings.freeShippingThresholdCents > 0 && input.subtotalCents >= settings.freeShippingThresholdCents) {
    return {
      costCents: 0,
      currency,
      method: 'free',
      rateId: null,
      estimatedDaysMin: 3,
      estimatedDaysMax: 7,
    }
  }
  // 2. Table lookup
  const rate = await findBestShippingRate(db, input, currency)
  if (rate) {
    return {
      costCents: rate.costCents,
      currency: rate.currency,
      method: 'rate-table',
      rateId: rate.id,
      estimatedDaysMin: 3,
      estimatedDaysMax: 7,
    }
  }
  // 3. Flat fallback
  return {
    costCents: settings.fallbackFlatRateCents,
    currency,
    method: 'flat-fallback',
    rateId: null,
    estimatedDaysMin: 5,
    estimatedDaysMax: 14,
  }
}

async function findBestShippingRate(
  db: DbClient,
  input: ShippingInput,
  currency: string,
): Promise<ShippingRate | null> {
  const { rows } = await db<RateRow>`
    select * from shipping_rates
    where enabled = true
      and country_code = ${input.countryCode}
      and (region_code is null or region_code = ${input.regionCode ?? ''})
      and min_subtotal_cents <= ${input.subtotalCents}
      and (max_subtotal_cents = 0 or max_subtotal_cents >= ${input.subtotalCents})
      and min_weight_grams <= ${input.totalWeightGrams}
      and (max_weight_grams = 0 or max_weight_grams >= ${input.totalWeightGrams})
      and currency = ${currency}
    order by sort_order, cost_cents asc
    limit 1
  `
  return rows[0] ? rowToRate(rows[0]) : null
}