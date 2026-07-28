/**
 * Notifications plugin — server entrypoint.
 *
 * Listens to hook events from other plugins and delivers them via email or
 * webhook. Installs default templates for the common events on first activate.
 *
 * Hook subscriptions:
 *   public-auth.userRegistered             → welcome email
 *   public-auth.passwordResetRequested     → password reset link
 *   public-auth.userLoggedIn               → (optional) login notification
 *   commerce.orderPaid                     → order confirmation
 *   commerce.orderRefunded                 → refund confirmation
 *   membership.subscriptionCanceled        → cancellation confirmation
 *   membership.subscriptionCreated         → (optional) welcome to tier
 *
 * The plugin is intentionally conservative on which events auto-deliver:
 *   - Welcome emails (one per registration)
 *   - Security emails (password reset)
 *   - Transactional emails (order paid, subscription canceled)
 *   - All other events require explicit template configuration
 */

import { definePlugin } from '@instatic/plugin-sdk'
import migrations from './migrations'
import { DEFAULT_TEMPLATES, deliver, handleAdminCreateWebhook, handleAdminListLog, handleAdminListTemplates, handleAdminUpsertTemplate, handleWebhookInbound } from './routes'
import { upsertTemplate } from './store'

interface NotificationSettings {
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPassword: string
  smtpFromAddress: string
  smtpFromName: string
  webhookRetries: number
  siteName: string
  siteUrl: string
}

export default definePlugin({
id: 'instatic.notifications',
  name: 'Notifications',
  version: '0.1.0',
  permissions: ['cms.migrations', 'cms.routes', 'cms.routes.public', 'cms.publicRoutes', 'cms.hooks', 'network.outbound']
})

export async function install(api: any) {
  for (const migration of migrations) {
    await api.cms.migrations.register(migration)
  }
}

export async function activate(api: any) {
for (const migration of migrations) {
      await api.cms.migrations.register(migration)
    }

    const settings: NotificationSettings = {
      smtpHost: (await api.settings.get('smtpHost') as string) ?? '',
      smtpPort: Number(await api.settings.get('smtpPort')) || 587,
      smtpUser: (await api.settings.get('smtpUser') as string) ?? '',
      smtpPassword: (await api.settings.get('smtpPassword') as string) ?? '',
      smtpFromAddress: (await api.settings.get('smtpFromAddress') as string) ?? '',
      smtpFromName: (await api.settings.get('smtpFromName') as string) ?? 'Instatic',
      webhookRetries: Number(await api.settings.get('webhookRetries')) || 3,
      siteName: (await api.settings.get('siteName') as string) ?? 'Our Site',
      siteUrl: (await api.settings.get('siteUrl') as string) ?? '',
    }

    // Install default templates (only on first activate; on subsequent
    // activations the ON CONFLICT clause makes this a no-op).
    for (const t of DEFAULT_TEMPLATES) {
      try {
        await upsertTemplate(api.db, {
          id: `tmpl_default_${t.event}_${t.channel}_${t.format}`,
          event: t.event,
          channel: t.channel,
          subject: t.subject,
          body: t.body,
          format: t.format,
          locale: 'en',
          enabled: true,
        })
      } catch (err) {
        api.log.warn(`Failed to install default template ${t.event}/${t.channel}`, err)
      }
    }

    // ─── Hook subscriptions ────────────────────────────────────────────────
    api.cms.hooks.on('public-auth.userRegistered', async (payload) => {
      const p = payload as { userId: string; email: string; displayName: string; verificationToken?: string }
      await deliver(api, settings, 'public-auth.userRegistered', p.email, {
        displayName: p.displayName,
        userId: p.userId,
        verificationUrl: p.verificationToken ? `${settings.siteUrl}/verify-email?token=${p.verificationToken}` : '',
      }, { dedupKey: `register:${p.userId}` })
    })

    api.cms.hooks.on('public-auth.passwordResetRequested', async (payload) => {
      const p = payload as { userId: string; email: string; resetToken: string }
      await deliver(api, settings, 'public-auth.passwordResetRequested', p.email, {
        displayName: '',
        resetToken: p.resetToken,
        userId: p.userId,
      }, { dedupKey: `pwreset:${p.userId}:${p.resetToken.slice(0, 8)}` })
    })

    api.cms.hooks.on('commerce.orderPaid', async (payload) => {
      const p = payload as { orderId: string; email: string; displayName?: string; orderNumber?: string; total?: string }
      // Look up the order's email if not provided
      const recipient = p.email
      if (!recipient) return
      await deliver(api, settings, 'commerce.orderPaid', recipient, {
        displayName: p.displayName ?? '',
        orderNumber: p.orderNumber ?? '',
        total: p.total ?? '',
        orderId: p.orderId,
      }, { dedupKey: `order:${p.orderId}` })
    })

    api.cms.hooks.on('commerce.orderRefunded', async (payload) => {
      const p = payload as { orderId: string; email: string; displayName?: string; orderNumber?: string }
      if (!p.email) return
      await deliver(api, settings, 'commerce.orderRefunded', p.email, {
        displayName: p.displayName ?? '',
        orderNumber: p.orderNumber ?? '',
        orderId: p.orderId,
      }, { dedupKey: `refund:${p.orderId}` })
    })

    api.cms.hooks.on('membership.subscriptionCanceled', async (payload) => {
      const p = payload as { userId: string; email?: string; displayName?: string; expiresAt: string }
      if (!p.email) return
      await deliver(api, settings, 'membership.subscriptionCanceled', p.email, {
        displayName: p.displayName ?? '',
        expiresAt: p.expiresAt,
        userId: p.userId,
      }, { dedupKey: `cancel:${p.userId}:${p.expiresAt}` })
    })

    // ─── Admin routes ─────────────────────────────────────────────────────
    await api.cms.publicRoutes.register('/api/admin/notifications', { exclusive: true })
    await api.cms.routes.register('GET', '/api/admin/notifications/templates', 'users.manage', handleAdminListTemplates)
    await api.cms.routes.register('POST', '/api/admin/notifications/templates', 'users.manage', async (ctx, req) => {
      return handleAdminUpsertTemplate(ctx, req)
    })
    await api.cms.routes.register('GET', '/api/admin/notifications/log', 'users.manage', handleAdminListLog)
    await api.cms.routes.register('POST', '/api/admin/notifications/webhooks', 'users.manage', async (ctx, req) => {
      return handleAdminCreateWebhook(ctx, req)
    })

    // ─── 入站 Webhook 路由（公开，由外部系统回调） ──────────────────────
    await api.cms.routes.register('POST', '/api/notifications/webhooks/:webhookId/inbound', 'public', async (ctx, req, params) => {
      return handleWebhookInbound(ctx, req, params.webhookId)
    })

    api.log.info('notifications plugin activated')
}

export async function deactivate(api: any) {
api.log.info('notifications plugin deactivated')
}

