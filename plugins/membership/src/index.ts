/**
 * Membership & Paywalls plugin — server entrypoint.
 *
 * Layers:
 *   1. Tier catalog       (admin-managed, public-readable)
 *   2. Subscription state (per-user, with Stripe integration)
 *   3. viewerContext      — exposes { tier, rank, status, expiresAt }
 *   4. contentGate        — blocks member-only content for non-subscribers
 *   5. Stripe webhooks    — keeps local sub state in sync with Stripe
 *
 * Content gating convention:
 *   A content row with cells.requiresTier = 'premium' (or any tier slug)
 *   is hidden from viewers whose highest active tier rank is below the
 *   premium tier's rank. Admins set the tier requirement per row in the
 *   data table definition.
 *
 * Depends on:
 *   - @instatic/plugin-public-auth — provides viewer.userId
 *   - (optional) Stripe — for paid subscriptions
 */

import { definePlugin } from '@instatic/plugin-sdk'
import migrations from './migrations'
import {
  handleAdminCreateTier,
  handleAdminDeleteTier,
  handleAdminListTiers,
  handleAdminUpdateTier,
  handleCancel,
  handleListPublicTiers,
  handleMySubscription,
  handleStripeWebhook,
  handleSubscribe,
} from './routes'
import {
  findTierBySlug,
  getActiveSubscription,
} from './store'

interface MembershipSettings {
  gracePeriodDays: number
  trialDays: number
  stripeSecretKey?: string
  stripeWebhookSecret?: string
}

export default definePlugin({
  id: 'membership',
  name: 'Membership & Paywalls',
  version: '0.1.0',

  migrations,

  async activate(api) {
    // ─── Migrations ─────────────────────────────────────────────────────────
    for (const migration of migrations) {
      await api.cms.migrations.register(migration)
    }

    // ─── Settings ───────────────────────────────────────────────────────────
    const settings: MembershipSettings = {
      gracePeriodDays: Number(await api.settings.get('gracePeriodDays')) || 3,
      trialDays: Number(await api.settings.get('trialDays')) || 7,
      stripeSecretKey: (await api.settings.get('stripeSecretKey') as string) || undefined,
      stripeWebhookSecret: (await api.settings.get('stripeWebhookSecret') as string) || undefined,
    }

    // ─── Public routes ─────────────────────────────────────────────────────
    await api.cms.publicRoutes.register('/api/membership', { exclusive: true })
    await api.cms.routes.register('GET', '/api/membership/tiers', 'public', async (ctx) => {
      return handleListPublicTiers(ctx)
    })
    await api.cms.routes.register('GET', '/api/membership/me/subscription', 'public', async (ctx) => {
      return handleMySubscription(ctx, settings)
    })
    await api.cms.routes.register('POST', '/api/membership/subscribe', 'public', async (ctx, req) => {
      return handleSubscribe(ctx, req, settings)
    })
    await api.cms.routes.register('POST', '/api/membership/cancel', 'public', async (ctx) => {
      return handleCancel(ctx)
    })
    await api.cms.routes.register('POST', '/api/membership/stripe/webhook', 'public', async (ctx, req) => {
      return handleStripeWebhook(ctx, req, settings)
    })

    // ─── Admin routes ──────────────────────────────────────────────────────
    await api.cms.routes.register('GET', '/admin/api/membership/tiers', 'content.manage', async (ctx) => {
      return handleAdminListTiers(ctx)
    })
    await api.cms.routes.register('POST', '/admin/api/membership/tiers', 'content.manage', async (ctx, req) => {
      return handleAdminCreateTier(ctx, req)
    })
    await api.cms.routes.register('PATCH', '/admin/api/membership/tiers/:id', 'content.manage', async (ctx, req, params) => {
      return handleAdminUpdateTier(ctx, req, params.id)
    })
    await api.cms.routes.register('DELETE', '/admin/api/membership/tiers/:id', 'content.manage', async (ctx, _req, params) => {
      return handleAdminDeleteTier(ctx, params.id)
    })

    // ─── viewerContext provider ────────────────────────────────────────────
    // Adds tier/rank/expiresAt to the viewer frame for content gates and
    // template bindings. Reads public-auth's viewer.userId to find the
    // user's subscription. Falls back to the default (free) tier if no
    // active sub.
    api.viewerContext.register(async (ctx) => {
      const viewer = ctx.viewer as { loggedIn?: boolean; userId?: string } | undefined
      if (!viewer?.loggedIn || !viewer.userId) {
        return { tier: 'free', tierRank: 0 }
      }
      const sub = await getActiveSubscription(ctx.db, viewer.userId, settings.gracePeriodDays)
      if (!sub) {
        return { tier: 'free', tierRank: 0 }
      }
      return {
        tier: sub.tier.slug,
        tierRank: sub.tier.rank,
        tierName: sub.tier.name,
        subscriptionId: sub.subscription.id,
        subscriptionStatus: sub.subscription.status,
        expiresAt: sub.subscription.currentPeriodEnd,
        cancelAt: sub.subscription.cancelAt,
      }
    })

    // ─── contentGate — paywall enforcement ─────────────────────────────────
    // A row is gated when cells.requiresTier is set to a tier slug. The
    // gate reads the viewer's tier rank and blocks if it's lower than
    // the required tier's rank.
    api.contentGate.register(async (ctx) => {
      const cells = ctx.row.cells as Record<string, unknown>
      const requiredTierSlug = typeof cells.requiresTier === 'string' ? cells.requiresTier : null
      if (!requiredTierSlug) {
        return { kind: 'allow' as const }
      }
      const viewer = ctx.viewer as { tier?: string; tierRank?: number } | undefined
      const requiredTier = await findTierBySlug(ctx.db, requiredTierSlug)
      if (!requiredTier) {
        return { kind: 'allow' as const }  // unknown tier — fail open
      }
      const viewerRank = viewer?.tierRank ?? 0
      if (viewerRank >= requiredTier.rank) {
        return { kind: 'allow' as const }
      }
      // Block — redirect to login or pricing.
      return {
        kind: 'block' as const,
        status: viewer?.tier ? 402 : 302,
        redirectTo: viewer?.tier ? '/pricing' : `/login?next=${encodeURIComponent(ctx.pathname)}`,
        reason: `Requires ${requiredTierSlug} tier`,
      }
    }, 100)  // higher priority than generic gates

    api.log.info('membership plugin activated')
  },

  async deactivate(api) {
    api.log.info('membership plugin deactivated')
  },
})