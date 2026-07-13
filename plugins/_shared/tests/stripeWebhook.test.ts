/**
 * Stripe webhook signature verification tests.
 *
 * Tests the canonical Stripe signature flow including replay protection.
 */

import { describe, test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { verifyStripeSignature } from '../stripeWebhook'

const TEST_SECRET = 'whsec_test_secret_12345'

function signStripePayload(body: string, timestamp: number, secret: string = TEST_SECRET): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${sig}`
}

describe('stripeWebhook/verify', () => {
  test('accepts a valid signature', () => {
    const body = JSON.stringify({ type: 'test.event', data: { object: {} } })
    const timestamp = Math.floor(Date.now() / 1000)
    const header = signStripePayload(body, timestamp)
    expect(verifyStripeSignature(body, header, TEST_SECRET).ok).toBe(true)
  })

  test('rejects when header is missing', () => {
    expect(verifyStripeSignature('{}', null, TEST_SECRET).ok).toBe(false)
  })

  test('rejects when signature is wrong', () => {
    const body = '{}'
    const timestamp = Math.floor(Date.now() / 1000)
    const wrong = `t=${timestamp},v1=${'a'.repeat(64)}`
    const result = verifyStripeSignature(body, wrong, TEST_SECRET)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid_signature')
  })

  test('rejects when body is tampered', () => {
    const body = JSON.stringify({ type: 'original', amount: 100 })
    const tampered = JSON.stringify({ type: 'original', amount: 9999 })
    const timestamp = Math.floor(Date.now() / 1000)
    const header = signStripePayload(body, timestamp)
    expect(verifyStripeSignature(tampered, header, TEST_SECRET).ok).toBe(false)
  })

  test('rejects when secret is wrong', () => {
    const body = '{}'
    const timestamp = Math.floor(Date.now() / 1000)
    const header = signStripePayload(body, timestamp, TEST_SECRET)
    expect(verifyStripeSignature(body, header, 'whsec_wrong').ok).toBe(false)
  })

  test('rejects timestamp out of tolerance (>5 min old)', () => {
    const body = '{}'
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600  // 10 min ago
    const header = signStripePayload(body, oldTimestamp)
    const result = verifyStripeSignature(body, header, TEST_SECRET)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('timestamp_out_of_range')
  })

  test('rejects timestamp from the future (>5 min ahead)', () => {
    const body = '{}'
    const futureTimestamp = Math.floor(Date.now() / 1000) + 600
    const header = signStripePayload(body, futureTimestamp)
    const result = verifyStripeSignature(body, header, TEST_SECRET)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('timestamp_out_of_range')
  })

  test('accepts timestamp within custom tolerance', () => {
    const body = '{}'
    const oldTimestamp = Math.floor(Date.now() / 1000) - 60  // 1 min ago
    const header = signStripePayload(body, oldTimestamp)
    expect(verifyStripeSignature(body, header, TEST_SECRET, 3600).ok).toBe(true)
  })

  test('rejects malformed header (missing t)', () => {
    const body = '{}'
    const wrong = `v1=${'a'.repeat(64)}`
    const result = verifyStripeSignature(body, wrong, TEST_SECRET)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('malformed_header')
  })

  test('rejects malformed header (missing v1)', () => {
    const body = '{}'
    const ts = Math.floor(Date.now() / 1000)
    const wrong = `t=${ts}`
    const result = verifyStripeSignature(body, wrong, TEST_SECRET)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('malformed_header')
  })

  test('rejects signature of wrong length', () => {
    const body = '{}'
    const ts = Math.floor(Date.now() / 1000)
    const wrong = `t=${ts},v1=abc`  // too short
    const result = verifyStripeSignature(body, wrong, TEST_SECRET)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid_signature')
  })
})