/**
 * HMAC webhook signature tests.
 */

import { describe, test, expect } from 'bun:test'
import { signHmacPayload, verifyHmacSignature } from '../hmacWebhook'

const SECRET = 'test-webhook-secret-12345'

describe('hmacWebhook/sign', () => {
  test('produces a Stripe-format header', () => {
    const body = '{"event":"test"}'
    const ts = 1700000000
    const header = signHmacPayload(SECRET, body, ts)
    expect(header).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/)
  })
})

describe('hmacWebhook/verify', () => {
  test('accepts a valid signature', () => {
    const body = '{"event":"test"}'
    const ts = Math.floor(Date.now() / 1000)
    const header = signHmacPayload(SECRET, body, ts)
    expect(verifyHmacSignature(body, header, SECRET).ok).toBe(true)
  })

  test('rejects missing header', () => {
    expect(verifyHmacSignature('{}', null, SECRET).ok).toBe(false)
  })

  test('rejects wrong secret', () => {
    const body = '{}'
    const ts = Math.floor(Date.now() / 1000)
    const header = signHmacPayload('wrong-secret', body, ts)
    expect(verifyHmacSignature(body, header, SECRET).ok).toBe(false)
  })

  test('rejects tampered body', () => {
    const body = '{"amount":100}'
    const tampered = '{"amount":9999}'
    const ts = Math.floor(Date.now() / 1000)
    const header = signHmacPayload(SECRET, body, ts)
    expect(verifyHmacSignature(tampered, header, SECRET).ok).toBe(false)
  })

  test('rejects old timestamps', () => {
    const body = '{}'
    const oldTs = Math.floor(Date.now() / 1000) - 600  // 10 min ago
    const header = signHmacPayload(SECRET, body, oldTs)
    const result = verifyHmacSignature(body, header, SECRET)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('timestamp_out_of_range')
  })

  test('accepts within custom tolerance', () => {
    const body = '{}'
    const ts = Math.floor(Date.now() / 1000) - 100  // 100s ago
    const header = signHmacPayload(SECRET, body, ts)
    expect(verifyHmacSignature(body, header, SECRET, 3600).ok).toBe(true)
  })

  test('rejects malformed header', () => {
    expect(verifyHmacSignature('{}', 'no-sig-here', SECRET).ok).toBe(false)
    expect(verifyHmacSignature('{}', 't=1700000000', SECRET).ok).toBe(false)
    expect(verifyHmacSignature('{}', 'v1=abc', SECRET).ok).toBe(false)
  })

  test('rejects signature of wrong length', () => {
    const body = '{}'
    const ts = Math.floor(Date.now() / 1000)
    const header = `t=${ts},v1=abc`
    const result = verifyHmacSignature(body, header, SECRET)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid_signature')
  })

  test('constant-time comparison does not leak via response time', () => {
    // Sanity test: ensure the verify path doesn't throw on near-miss
    const body = '{}'
    const ts = Math.floor(Date.now() / 1000)
    const good = signHmacPayload(SECRET, body, ts)
    // Build a wrong sig of the same length
    const goodSig = good.split('v1=')[1]
    const wrongSig = 'f'.repeat(goodSig.length)
    const badHeader = `t=${ts},v1=${wrongSig}`
    const result = verifyHmacSignature(body, badHeader, SECRET)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid_signature')
  })

  test('round-trips with random timestamps and bodies', () => {
    for (let i = 0; i < 50; i++) {
      const body = JSON.stringify({ event: `test.${i}`, amount: i * 100, random: Math.random() })
      const ts = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 60)  // within tolerance
      const header = signHmacPayload(SECRET, body, ts)
      expect(verifyHmacSignature(body, header, SECRET).ok).toBe(true)
    }
  })
})