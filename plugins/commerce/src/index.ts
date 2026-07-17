/**
 * Commerce plugin — server entrypoint.
 *
 * Architecture:
 *   - Products live in the host's `data_tables` (one table per catalog)
 *   - Carts + orders + inventory ledger are plugin-owned tables
 *   - Stripe handles payment processing + checkout UI
 *   - Webhooks keep order status in sync with Stripe
 *
 * On first activation:
 *   1. Creates the `products` data table (if missing) with sensible fields
 *   2. Creates the carts/orders/inventory tables via migration
 *   3. Registers all routes (catalog, cart, checkout, webhooks)
 */

import { definePlugin } from '@instatic/plugin-sdk'
import migrations from './migrations'
import {
  handleAddToCart,
  handleAdminListOrders,
  handleAdminManualRefund,
  handleAdminRefundOrder,
  handleAdminRestock,
  handleAdminFulfillOrder,
  handleAdminCancelOrder,
  handleCheckout,
  handleClearCart,
  handleGetCart,
  handleGetProduct,
  handleListMyOrders,
  handleListProducts,
  handleRemoveCartItem,
  handleStripeWebhook,
  handleUpdateCartItem,
} from './routes'
import {
  handleAdminCreateCoupon,
  handleAdminDeleteCoupon,
  handleAdminDeleteVariant,
  handleAdminListCoupons,
  handleAdminListRedemptions,
  handleAdminListVariants,
  handleAdminRestockVariant,
  handleAdminSyncVariants,
  handleAdminUpdateCoupon,
  handleApplyCoupon,
  handleValidateCoupon,
} from './couponRoutes'
import {
  handleAdminCreateRefund,
  handleAdminDeleteShippingRate,
  handleAdminListRefunds,
  handleAdminListShippingRates,
  handleAdminUpsertShippingRate,
  handleReleaseCart,
  handleReserveCart,
  handleShippingQuote,
} from './fulfillmentRoutes'

interface CommerceSettings {
  stripeSecretKey: string
  stripeWebhookSecret: string
  currency: string
}

const PRODUCTS_TABLE_SCHEMA = {
  id: 'products',
  name: 'Products',
  slug: 'products',
  kind: 'data',
  routeBase: '/products',
  singularLabel: 'Product',
  pluralLabel: 'Products',
  primaryFieldId: 'title',
  fieldsJson: JSON.stringify([
    { type: 'text', id: 'title', label: 'Title', required: true, builtIn: false },
    { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: false },
    { type: 'longText', id: 'description', label: 'Description', builtIn: false },
    { type: 'media', id: 'featuredMedia', label: 'Featured image', mediaKind: 'image', builtIn: false },
    { type: 'number', id: 'priceCents', label: 'Price (cents)', integer: true, required: true, builtIn: false },
    { type: 'text', id: 'currency', label: 'Currency code', builtIn: false },
    { type: 'number', id: 'availableQuantity', label: 'Available quantity', integer: true, builtIn: false },
    { type: 'boolean', id: 'trackInventory', label: 'Track inventory', builtIn: false },
    { type: 'boolean', id: 'isPublished', label: 'Published', builtIn: false },
  ]),
  system: false,
}

export default definePlugin({
id: 'instatic.commerce',
  name: 'Commerce',
  version: '0.1.0',
  permissions: ['cms.migrations', 'cms.routes', 'cms.routes.public', 'cms.publicRoutes', 'cms.content.read', 'cms.content.write', 'cms.content.publish', 'cms.content.tables.manage', 'network.outbound', 'cms.hooks']
})

export async function install(api: any) {
  for (const migration of migrations) {
    await api.cms.migrations.register(migration)
  }
}

export async function activate(api: any) {
// ─── Migrations ─────────────────────────────────────────────────────────
    for (const migration of migrations) {
      await api.cms.migrations.register(migration)
    }

    // ─── Ensure products table exists ──────────────────────────────────────
    try {
      const existing = await api.cms.content.tables.get('products')
      if (!existing) {
        await api.cms.content.tables.create(PRODUCTS_TABLE_SCHEMA)
      }
    } catch (err) {
      api.log.warn('Failed to create products table', err)
    }

    // ─── Settings ───────────────────────────────────────────────────────────
    const settings: CommerceSettings = {
      stripeSecretKey: (await api.settings.get('stripeSecretKey') as string) ?? '',
      stripeWebhookSecret: (await api.settings.get('stripeWebhookSecret') as string) ?? '',
      currency: (await api.settings.get('currency') as string) ?? 'USD',
    }

    // ─── Public routes ─────────────────────────────────────────────────────
    await api.cms.publicRoutes.register('/api/commerce', { exclusive: true })
    await api.cms.routes.register('GET', '/api/commerce/products', 'public', handleListProducts)
    await api.cms.routes.register('GET', '/api/commerce/products/:slug', 'public', async (ctx, _req, params) => {
      return handleGetProduct(ctx, params.slug)
    })
    await api.cms.routes.register('POST', '/api/commerce/stripe/webhook', 'public', async (ctx, req) => {
      return handleStripeWebhook(ctx, req, settings)
    })

    // ─── Authenticated routes ──────────────────────────────────────────────
    await api.cms.routes.register('GET', '/api/commerce/cart', 'authenticated', handleGetCart)
    await api.cms.routes.register('POST', '/api/commerce/cart/items', 'authenticated', handleAddToCart)
    await api.cms.routes.register('PATCH', '/api/commerce/cart/items/:productId', 'authenticated', async (ctx, req, params) => {
      return handleUpdateCartItem(ctx, req, params.productId)
    })
    await api.cms.routes.register('DELETE', '/api/commerce/cart/items/:productId', 'authenticated', async (ctx, _req, params) => {
      return handleRemoveCartItem(ctx, params.productId)
    })
    await api.cms.routes.register('DELETE', '/api/commerce/cart', 'authenticated', handleClearCart)
    await api.cms.routes.register('POST', '/api/commerce/checkout', 'authenticated', async (ctx, req) => {
      return handleCheckout(ctx, req, settings)
    })
    await api.cms.routes.register('GET', '/api/commerce/orders', 'authenticated', handleListMyOrders)

    // ─── Admin routes ──────────────────────────────────────────────────────
    await api.cms.routes.register('GET', '/admin/api/commerce/orders', 'content.manage', handleAdminListOrders)
    await api.cms.routes.register('POST', '/admin/api/commerce/orders/:id/refund', 'content.manage', async (ctx, _req, params) => {
      return handleAdminRefundOrder(ctx, settings, params.id)
    })
    await api.cms.routes.register('POST', '/admin/api/commerce/orders/:id/refund/manual', 'content.manage', async (ctx, req, params) => {
      return handleAdminManualRefund(ctx, req, params.id)
    })
    await api.cms.routes.register('POST', '/admin/api/commerce/products/:id/restock', 'content.manage', async (ctx, req, params) => {
      return handleAdminRestock(ctx, req, params.id)
    })
    await api.cms.routes.register('POST', '/admin/api/commerce/orders/:id/fulfill', 'content.manage', async (ctx, _req, params) => {
      return handleAdminFulfillOrder(ctx, params.id)
    })
    await api.cms.routes.register('POST', '/admin/api/commerce/orders/:id/cancel', 'content.manage', async (ctx, _req, params) => {
      return handleAdminCancelOrder(ctx, params.id)
    })

    // ─── Coupon routes ────────────────────────────────────────────────────
    await api.cms.routes.register('POST', '/api/commerce/coupons/validate', 'authenticated', handleValidateCoupon)
    await api.cms.routes.register('POST', '/api/commerce/coupons/apply', 'authenticated', handleApplyCoupon)
    await api.cms.routes.register('GET', '/api/admin/commerce/coupons', 'content.manage', handleAdminListCoupons)
    await api.cms.routes.register('POST', '/api/admin/commerce/coupons', 'content.manage', async (ctx, req) => {
      return handleAdminCreateCoupon(ctx, req)
    })
    await api.cms.routes.register('PATCH', '/api/admin/commerce/coupons/:id', 'content.manage', async (ctx, req, params) => {
      return handleAdminUpdateCoupon(ctx, req, params.id)
    })
    await api.cms.routes.register('DELETE', '/api/admin/commerce/coupons/:id', 'content.manage', async (ctx, _req, params) => {
      return handleAdminDeleteCoupon(ctx, params.id)
    })
    await api.cms.routes.register('GET', '/api/admin/commerce/coupons/:id/redemptions', 'content.manage', async (ctx, _req, params) => {
      return handleAdminListRedemptions(ctx, params.id)
    })

    // ─── Variant routes (admin) ───────────────────────────────────────────
    await api.cms.routes.register('GET', '/api/admin/commerce/products/:productId/variants', 'content.manage', async (ctx, _req, params) => {
      return handleAdminListVariants(ctx, params.productId)
    })
    await api.cms.routes.register('POST', '/api/admin/commerce/products/:productId/variants', 'content.manage', async (ctx, req, params) => {
      return handleAdminSyncVariants(ctx, req, params.productId)
    })
    await api.cms.routes.register('DELETE', '/api/admin/commerce/variants/:id', 'content.manage', async (ctx, _req, params) => {
      return handleAdminDeleteVariant(ctx, params.id)
    })
    await api.cms.routes.register('POST', '/api/admin/commerce/variants/:id/restock', 'content.manage', async (ctx, req, params) => {
      return handleAdminRestockVariant(ctx, req, params.id)
    })

    // ─── Shipping routes ──────────────────────────────────────────────────
    const shippingSettings = {
      freeShippingThresholdCents: Number(await api.settings.get('freeShippingThresholdCents')) || 0,
      fallbackFlatRateCents: Number(await api.settings.get('fallbackFlatRateCents')) || 999,
      defaultCurrency: (await api.settings.get('currency') as string) ?? 'USD',
    }
    await api.cms.routes.register('POST', '/api/commerce/shipping/quote', 'public', async (ctx, req) => {
      return handleShippingQuote(ctx, req, shippingSettings)
    })
    await api.cms.routes.register('GET', '/api/admin/commerce/shipping-rates', 'content.manage', handleAdminListShippingRates)
    await api.cms.routes.register('POST', '/api/admin/commerce/shipping-rates', 'content.manage', async (ctx, req) => {
      return handleAdminUpsertShippingRate(ctx, req)
    })
    await api.cms.routes.register('DELETE', '/api/admin/commerce/shipping-rates/:id', 'content.manage', async (ctx, _req, params) => {
      return handleAdminDeleteShippingRate(ctx, params.id)
    })

    // ─── Reservation routes ───────────────────────────────────────────────
    await api.cms.routes.register('POST', '/api/commerce/cart/reserve', 'authenticated', async (ctx, _req) => {
      const userId = ((ctx as { userId?: string }).userId ?? '') as string
      if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return handleReserveCart(ctx, userId)
    })
    await api.cms.routes.register('POST', '/api/commerce/cart/release', 'authenticated', async (ctx, _req) => {
      const userId = ((ctx as { userId?: string }).userId ?? '') as string
      if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return handleReleaseCart(ctx, userId)
    })

    // ─── Refund routes (admin) ────────────────────────────────────────────
    await api.cms.routes.register('GET', '/api/admin/commerce/orders/:id/refunds', 'content.manage', async (ctx, _req, params) => {
      return handleAdminListRefunds(ctx, params.id)
    })
    await api.cms.routes.register('POST', '/api/admin/commerce/orders/:id/refund', 'content.manage', async (ctx, req, params) => {
      const userId = (ctx as { userId?: string }).userId ?? ''
      return handleAdminCreateRefund(ctx, req, params.id, settings, String(userId))
    })

    // ─── viewerContext: cart count ─────────────────────────────────────────
    api.viewerContext.register(async (ctx) => {
      const viewer = ctx.viewer as { loggedIn?: boolean; userId?: string } | undefined
      if (!viewer?.loggedIn || !viewer.userId) return {}
      const { rows } = await ctx.db`
        select coalesce(sum(quantity), 0)::int as count
        from carts, jsonb_array_elements(line_items_json) as item
        where user_id = ${viewer.userId}
          and jsonb_typeof(line_items_json) = 'array'
      `
      return { cartCount: rows[0]?.count ?? 0 }
    })

    // ─── Cart expiration cron ──────────────────────────────────────────
    // 每小时清理超过 30 天未更新的购物车
    const cartExpiryInterval = setInterval(async () => {
      try {
        const expired = await (await import('./store')).expireOldCarts(api.db, 30)
        if (expired > 0) api.log.info(`Expired ${expired} old carts`)
      } catch (err) {
        api.log.warn(`Cart expiry cron failed: ${err}`)
      }
    }, 3600_000)  // 每小时
    // 存储引用以便 deactivate 时清理
    ;(api as Record<string, unknown>)._commerceCartExpiryInterval = cartExpiryInterval

    api.log.info('commerce plugin activated')
}

export async function deactivate(api: any) {
  if ((api as Record<string, unknown>)._commerceCartExpiryInterval) {
    clearInterval((api as Record<string, unknown>)._commerceCartExpiryInterval as ReturnType<typeof setInterval>)
  }
  api.log.info('commerce plugin deactivated')
}

