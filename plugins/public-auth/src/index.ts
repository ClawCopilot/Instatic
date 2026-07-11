/**
 * Public Authentication plugin — server entrypoint.
 *
 * Provides:
 *   - End-user registration, login, logout, session refresh
 *   - Email verification + password reset flows
 *   - Server-side session allowlist (instant revocation)
 *   - JWT access tokens (HS256, per-installation secret)
 *   - `viewerContext` provider that exposes the resolved user as
 *     `{ loggedIn, userId, email, displayName, emailVerified }` for
 *     every page render — consumed by membership / commerce / OIDC plugins
 *
 * Plugin coordination:
 *   - Emits `public-auth.userRegistered` (with verification token if enabled)
 *   - Emits `public-auth.userLoggedIn`
 *   - Emits `public-auth.passwordResetRequested`
 *   Other plugins (notifications) subscribe and send the actual email.
 */

import { definePlugin } from '@instatic/plugin-sdk'
import migrations from './migrations'
import {
  handleLogin,
  handleLogout,
  handleMe,
  handlePasswordResetConfirm,
  handlePasswordResetRequest,
  handleRefresh,
  handleRegister,
  handleVerifyEmail,
  resolveUserFromRequest,
} from './routes'
import { extractBearerToken, extractCookieToken, hashForStorage, verifyAccessToken } from './tokens'
import { findActiveSession } from './store'

const COOKIE_NAME = 'public_auth_token'

interface PublicAuthSettings {
  jwtSecret: string
  accessTokenTtlSeconds: number
  requireEmailVerification: boolean
}

export default definePlugin({
  id: 'public-auth',
  name: 'Public Authentication',
  version: '0.1.0',

  migrations,

  async activate(api) {
    // ─── Migrations ─────────────────────────────────────────────────────────
    for (const migration of migrations) {
      await api.cms.migrations.register(migration)
    }

    // ─── Settings ───────────────────────────────────────────────────────────
    const settings: PublicAuthSettings = {
      jwtSecret: (await api.settings.get('jwtSecret')) as string,
      accessTokenTtlSeconds: (await api.settings.get('accessTokenTtlSeconds')) as number ?? 3600,
      requireEmailVerification: !!(await api.settings.get('requireEmailVerification')),
    }
    if (!settings.jwtSecret) {
      throw new Error('public-auth: jwtSecret setting is required')
    }

    // ─── Public route prefix ───────────────────────────────────────────────
    await api.cms.publicRoutes.register('/api/auth', { exclusive: true })

    // ─── Public endpoints ──────────────────────────────────────────────────
    const publicHandlers = {
      extractBearerToken, extractCookieToken, hashForStorage,
    }
    await api.cms.routes.register('POST', '/api/auth/register', 'public', async (ctx, req) => {
      return handleRegister({ ...ctx, ...publicHandlers }, req, settings)
    })
    await api.cms.routes.register('POST', '/api/auth/login', 'public', async (ctx, req) => {
      const res = await handleLogin({ ...ctx, ...publicHandlers }, req, settings)
      // Set HttpOnly cookie for browser-based clients; mobile clients
      // use the Authorization header instead.
      const body = await res.clone().json() as { accessToken?: string }
      if (body.accessToken) {
        res.headers.append('set-cookie',
          `${COOKIE_NAME}=${encodeURIComponent(body.accessToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${settings.accessTokenTtlSeconds}`,
        )
      }
      return res
    })
    await api.cms.routes.register('POST', '/api/auth/logout', 'public', async (ctx, req) => {
      return handleLogout({ ...ctx, ...publicHandlers }, req)
    })
    await api.cms.routes.register('POST', '/api/auth/refresh', 'public', async (ctx, req) => {
      return handleRefresh({ ...ctx, ...publicHandlers }, req, settings)
    })
    await api.cms.routes.register('GET', '/api/auth/me', 'public', async (ctx, req) => {
      return handleMe({ ...ctx, ...publicHandlers }, req, settings)
    })
    await api.cms.routes.register('POST', '/api/auth/verify-email', 'public', async (ctx, req) => {
      return handleVerifyEmail({ ...ctx, ...publicHandlers }, req)
    })
    await api.cms.routes.register('POST', '/api/auth/password-reset/request', 'public', async (ctx, req) => {
      return handlePasswordResetRequest({ ...ctx, ...publicHandlers }, req)
    })
    await api.cms.routes.register('POST', '/api/auth/password-reset/confirm', 'public', async (ctx, req) => {
      return handlePasswordResetConfirm({ ...ctx, ...publicHandlers }, req)
    })

    // ─── Admin endpoints ───────────────────────────────────────────────────
    await api.cms.routes.register('GET', '/admin/api/public-auth/users', 'users.manage', async (ctx) => {
      // List is intentionally minimal — full CRUD lives in the admin UI.
      const { rows } = await ctx.db`
        select id, email, display_name, status, email_verified_at,
               last_login_at, created_at
        from public_users
        where deleted_at is null
        order by created_at desc
        limit 100
      `
      return Response.json({ users: rows })
    })
    await api.cms.routes.register('POST', '/admin/api/public-auth/users/:id/suspend', 'users.manage', async (ctx, req, params) => {
      await ctx.db`update public_users set status = 'suspended', updated_at = now() where id = ${params.id}`
      await ctx.db`update public_sessions set revoked_at = now() where user_id = ${params.id} and revoked_at is null`
      return Response.json({ suspended: true })
    })
    await api.cms.routes.register('POST', '/admin/api/public-auth/users/:id/unsuspend', 'users.manage', async (ctx, _req, params) => {
      await ctx.db`update public_users set status = 'active', updated_at = now() where id = ${params.id}`
      return Response.json({ unsuspended: true })
    })

    // ─── viewerContext provider ────────────────────────────────────────────
    // Exposes the resolved user as a viewer frame for templates and content
    // gates. Membership / commerce plugins can read these values to decide
    // whether the visitor qualifies for member-only content.
    api.viewerContext.register(async (ctx) => {
      const user = await resolveUserFromRequest(
        { db: ctx.db, ...publicHandlers },
        ctx.req,
        settings,
      )
      if (!user) {
        return { loggedIn: false }
      }
      return {
        loggedIn: true,
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        emailVerified: !!user.emailVerifiedAt,
        status: user.status,
      }
    })

    api.log.info('public-auth plugin activated')
  },

  async deactivate(api) {
    api.log.info('public-auth plugin deactivated')
  },

  // ─── Exported helpers for downstream plugins ─────────────────────────────
  exports: {
    resolveUserFromRequest,
  },
})