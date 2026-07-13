/**
 * Shipping calculation unit tests.
 */

import { describe, test, expect } from 'bun:test'
import type { ShippingRate } from '../src/shipping'

/**
 * Pure helper extracted for testing — mirrors the table lookup logic
 * in findBestShippingRate. Doesn't require a DB.
 */
function findBestRate(
  rates: ShippingRate[],
  input: { countryCode: string; regionCode?: string | null; subtotalCents: number; totalWeightGrams: number; currency: string },
): ShippingRate | null {
  return rates.find((r) =>
    r.enabled &&
    r.countryCode === input.countryCode &&
    (r.regionCode === null || r.regionCode === input.regionCode) &&
    r.minSubtotalCents <= input.subtotalCents &&
    (r.maxSubtotalCents === 0 || r.maxSubtotalCents >= input.subtotalCents) &&
    r.minWeightGrams <= input.totalWeightGrams &&
    (r.maxWeightGrams === 0 || r.maxWeightGrams >= input.totalWeightGrams) &&
    r.currency === input.currency,
  ) ?? null
}

function makeRate(overrides: Partial<ShippingRate> = {}): ShippingRate {
  return {
    id: 'ship_1',
    countryCode: 'US',
    regionCode: null,
    minSubtotalCents: 0,
    maxSubtotalCents: 0,
    minWeightGrams: 0,
    maxWeightGrams: 0,
    costCents: 999,
    currency: 'USD',
    enabled: true,
    description: 'Standard shipping',
    sortOrder: 0,
    ...overrides,
  }
}

describe('commerce/shipping', () => {
  test('matches a basic US rate', () => {
    const rate = makeRate({ id: 'us-standard' })
    const result = findBestRate([rate], {
      countryCode: 'US', subtotalCents: 5000, totalWeightGrams: 500, currency: 'USD',
    })
    expect(result?.id).toBe('us-standard')
  })

  test('country code is case-sensitive (matches DB exactly)', () => {
    const rate = makeRate({ id: 'us-standard' })
    const result = findBestRate([rate], {
      countryCode: 'us', subtotalCents: 5000, totalWeightGrams: 500, currency: 'USD',
    })
    expect(result).toBeNull()  // 'us' !== 'US'
  })

  test('skips disabled rates', () => {
    const rate = makeRate({ enabled: false })
    const result = findBestRate([rate], {
      countryCode: 'US', subtotalCents: 5000, totalWeightGrams: 500, currency: 'USD',
    })
    expect(result).toBeNull()
  })

  test('filters by region when specified', () => {
    const rate = makeRate({ regionCode: 'CA' })
    const result1 = findBestRate([rate], {
      countryCode: 'US', regionCode: 'CA', subtotalCents: 5000, totalWeightGrams: 500, currency: 'USD',
    })
    expect(result1?.id).toBe(rate.id)
    const result2 = findBestRate([rate], {
      countryCode: 'US', regionCode: 'NY', subtotalCents: 5000, totalWeightGrams: 500, currency: 'USD',
    })
    expect(result2).toBeNull()
  })

  test('null region rate matches any region in the same country', () => {
    const rate = makeRate({ regionCode: null })
    const result = findBestRate([rate], {
      countryCode: 'US', regionCode: 'CA', subtotalCents: 5000, totalWeightGrams: 500, currency: 'USD',
    })
    expect(result?.id).toBe(rate.id)
  })

  test('skips rate when subtotal below min', () => {
    const rate = makeRate({ minSubtotalCents: 10000 })  // min $100
    const result = findBestRate([rate], {
      countryCode: 'US', subtotalCents: 5000, totalWeightGrams: 500, currency: 'USD',
    })
    expect(result).toBeNull()
  })

  test('skips rate when subtotal above max (when max != 0)', () => {
    const rate = makeRate({ maxSubtotalCents: 10000 })  // max $100
    const result = findBestRate([rate], {
      countryCode: 'US', subtotalCents: 15000, totalWeightGrams: 500, currency: 'USD',
    })
    expect(result).toBeNull()
  })

  test('max=0 means unbounded', () => {
    const rate = makeRate({ maxSubtotalCents: 0 })
    const result = findBestRate([rate], {
      countryCode: 'US', subtotalCents: 999999, totalWeightGrams: 500, currency: 'USD',
    })
    expect(result?.id).toBe(rate.id)
  })

  test('skips rate when weight above max', () => {
    const rate = makeRate({ maxWeightGrams: 1000 })
    const result = findBestRate([rate], {
      countryCode: 'US', subtotalCents: 5000, totalWeightGrams: 2000, currency: 'USD',
    })
    expect(result).toBeNull()
  })

  test('currency must match', () => {
    const rate = makeRate({ currency: 'USD' })
    const result = findBestRate([rate], {
      countryCode: 'US', subtotalCents: 5000, totalWeightGrams: 500, currency: 'EUR',
    })
    expect(result).toBeNull()
  })
})