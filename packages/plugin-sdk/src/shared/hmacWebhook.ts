/**
 * HMAC-SHA256 webhook signature — for Instatic plugins sending outbound
 * webhooks (e.g. notifications → external systems).
 *
 * Format (identical to Stripe's):
 *   Header: X-Instatic-Signature: t=<unix>,v1=<hex>
 *   Sign:  HMAC-SHA256(`<t>.<body>`, secret)
 *
 * Replay protection: 5-minute tolerance on the timestamp.
 *
 * Usage in the sender (notifications plugin):
 *
 *     const secret = generateWebhookSecret()  // shown once on create
 *     const payload = JSON.stringify({ event, ... })
 *     const ts = Math.floor(Date.now() / 1000)
 *     const sig = `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`
 *     await fetch(webhookUrl, {
 *       method: 'POST',
 *       headers: { 'X-Instatic-Signature': sig, 'content-type': 'application/json' },
 *       body: payload,
 *     })
 *
 * Usage in the receiver:
 *
 *     import { verifyHmacSignature } from '@instatic/plugin-shared/hmacWebhook'
 *     const result = verifyHmacSignature(body, req.headers.get('x-instatic-signature'), secret)
 *     if (!result.ok) return new Response('Invalid signature', { status: 401 })
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_TOLERANCE_SECONDS = 300

export interface HmacVerifyResult {
  ok: boolean
  error?: 'missing_header' | 'malformed_header' | 'timestamp_out_of_range' | 'invalid_signature'
}

export function signHmacPayload(secret: string, body: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${sig}`
}

export function verifyHmacSignature(
  body: string,
  header: string | null,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): HmacVerifyResult {
  if (!header) return { ok: false, error: 'missing_header' }
  const parts: Record<string, string> = {}
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2)
    if (k && v) parts[k.trim()] = v.trim()
  }
  const timestamp = parts.t
  const signature = parts.v1
  if (!timestamp || !signature) return { ok: false, error: 'malformed_header' }
  const tsNum = parseInt(timestamp, 10)
  if (Number.isNaN(tsNum)) return { ok: false, error: 'malformed_header' }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - tsNum) > toleranceSeconds) {
    return { ok: false, error: 'timestamp_out_of_range' }
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest()
  let provided: Buffer
  try {
    provided = Buffer.from(signature, 'hex')
  } catch {
    return { ok: false, error: 'malformed_header' }
  }
  if (expected.length !== provided.length) {
    return { ok: false, error: 'invalid_signature' }
  }
  if (!timingSafeEqual(expected, provided)) {
    return { ok: false, error: 'invalid_signature' }
  }
  return { ok: true }
}