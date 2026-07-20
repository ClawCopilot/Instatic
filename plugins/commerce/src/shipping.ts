/**
 * Shipping cost calculation.
 *
 * Strategies:
 *   1. Free shipping — if subtotal >= freeThreshold, cost = 0
 *   2. Table-based rate — match a shipping_rates row by (country, region, subtotal range)
 *   2.5. Carrier API — query real-time rates from registered carrier adapters
 *   3. Weight-based — sum of (variant.weight_grams * quantity), pick rate by weight range
 *   4. Fallback — flat rate from plugin settings
 *
 * Lookup order: free -> table -> carrier API -> flat fallback.
 *
 * Carrier adapter framework is implemented. Individual carrier integrations
 * (UPS, FedEx, USPS) should be registered via `registerCarrierAdapter()` at plugin startup.
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
  method: string  // 'free', 'rate-table', 'carrier-api', 'flat-fallback'
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
  postalCode?: string | null
  subtotalCents: number
  totalWeightGrams: number
  originCountryCode?: string
  originRegionCode?: string
  originPostalCode?: string
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
 *   1. If subtotal >= freeShippingThreshold, return free shipping
 *   2. Look up the best matching shipping_rates row
 *   2.5. Query registered carrier adapters for real-time rates
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
  // 2.5. Carrier API — query registered adapters for real-time rates
  try {
    const carrierRates = await queryCarrierRates({
      origin: {
        country: input.originCountryCode ?? 'US',
        region: input.originRegionCode ?? '',
        postalCode: input.originPostalCode ?? '',
      },
      destination: {
        country: input.countryCode,
        region: input.regionCode ?? '',
        postalCode: input.postalCode ?? '',
      },
      weightGrams: input.totalWeightGrams,
    })
    if (carrierRates.length > 0) {
      const best = carrierRates[0] // already sorted by cost ascending
      return {
        costCents: best.costCents,
        currency: best.currency,
        method: 'carrier-api',
        rateId: null,
        estimatedDaysMin: best.estimatedDaysMin,
        estimatedDaysMax: best.estimatedDaysMax,
      }
    }
  } catch (err) {
    // Carrier API failure should not block checkout; fall through to flat rate
    console.warn('Carrier API query failed, falling back to flat rate:', err)
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

/**
 * 实时物流 API 适配器接口。
 * 运营商实现此接口后注册到 carrierAdapters Map 中。
 * calculateShipping 在找不到本地费率表匹配时，会逐一尝试已注册的运营商适配器。
 */
export interface CarrierAdapter {
  id: string           // 如 'ups', 'fedex', 'usps'
  name: string
  /** 查询实时费率，返回从低到高排序的报价列表 */
  getRates(input: {
    origin: { country: string; region: string; postalCode: string }
    destination: { country: string; region: string; postalCode: string }
    weightGrams: number
    packageDimensions?: { lengthCm: number; widthCm: number; heightCm: number }
  }): Promise<Array<{
    serviceLevel: string
    costCents: number
    currency: string
    estimatedDaysMin: number
    estimatedDaysMax: number
  }>>
}

/** 已注册的运营商适配器 */
export const carrierAdapters = new Map<string, CarrierAdapter>()

/**
 * 注册运营商适配器。插件或宿主在启动时调用。
 * 示例: registerCarrierAdapter({ id: 'ups', name: 'UPS', getRates: async (input) => [...] })
 */
export function registerCarrierAdapter(adapter: CarrierAdapter): void {
  carrierAdapters.set(adapter.id, adapter)
}

/**
 * 通过运营商 API 查询实时费率。
 * 依次尝试每个已注册的适配器，合并结果并按价格排序。
 * 如果没有注册任何适配器，返回空数组。
 */
export async function queryCarrierRates(
  input: CarrierAdapter['getRates'] extends (input: infer I) => Promise<Array<infer _R>> ? I : never,
): Promise<Array<{
  serviceLevel: string
  costCents: number
  currency: string
  estimatedDaysMin: number
  estimatedDaysMax: number
  carrierId: string
}>> {
  if (carrierAdapters.size === 0) return []
  const allRates: Array<{
    serviceLevel: string
    costCents: number
    currency: string
    estimatedDaysMin: number
    estimatedDaysMax: number
    carrierId: string
  }> = []
  for (const [carrierId, adapter] of carrierAdapters) {
    try {
      const rates = await adapter.getRates(input as Parameters<CarrierAdapter['getRates']>[0])
      for (const rate of rates) {
        allRates.push({ ...rate, carrierId })
      }
    } catch (err) {
      // 单个运营商失败不影响其他运营商
      console.warn(`Carrier ${carrierId} rate query failed:`, err)
    }
  }
  return allRates.sort((a, b) => a.costCents - b.costCents)
}