/**
 * Stripe webhook signature verification (shared utility).
 *
 * Stripe signs webhooks using HMAC-SHA256 of `${timestamp}.${body}`.
 * The `Stripe-Signature` header contains a comma-separated list of
 * `t=<timestamp>,v1=<signature>[,v0=<legacy>]`.
 *
 * Verification:
 *   1. Parse the header to extract `t` and `v1`
 *   2. Compute expected = HMAC-SHA256(`${t}.${body}`, secret) hex
 *   3. Constant-time compare against `v1`
 *   4. Reject if the timestamp is more than 5 minutes old (replay defense)
 *
 * Reference: https://stripe.com/docs/webhooks/signatures
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_TOLERANCE_SECONDS = 300

export interface VerifyResult {
  ok: boolean
  error?: 'missing_header' | 'malformed_header' | 'timestamp_out_of_range' | 'invalid_signature'
}

export function verifyStripeSignature(
  body: string,
  header: string | null,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
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

/**
 * Read the raw body from a Request, run signature verification, and return
 * the parsed JSON event. Throws on signature failure.
 */
export async function verifyAndParseStripeWebhook(
  req: Request,
  secret: string,
  toleranceSeconds?: number,
): Promise<{ event: { type: string; data: { object: Record<string, unknown> } } } | { error: string }> {
  const body = await req.text()
  const header = req.headers.get('stripe-signature')
  const result = verifyStripeSignature(body, header, secret, toleranceSeconds)
  if (!result.ok) {
    return { error: result.error ?? 'unknown' }
  }
  try {
    return { event: JSON.parse(body) }
  } catch {
    return { error: 'malformed_body' }
  }
}