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
import { handleDelete, handleExport } from './gdprRoutes'
import {
  handleMfaDisable,
  handleMfaEnable,
  handleMfaRegenerateRecoveryCodes,
  handleMfaSetup,
  handleMfaVerify,
  issueMfaToken,
} from './mfaRoutes'
import { handlePasswordlessRequest, handlePasswordlessVerify } from './passwordless'
import { extractBearerToken, extractCookieToken, hashForStorage, verifyAccessToken as _verifyAccessToken } from './tokens'
import { findActiveSession as _findActiveSession } from './store'

interface MfaSettings {
  jwtSecret: string
  mfaTokenTtlSeconds: number
}

const COOKIE_NAME = 'public_auth_token'

interface PublicAuthSettings {
  jwtSecret: string
  accessTokenTtlSeconds: number
  requireEmailVerification: boolean
}

export default definePlugin({
id: 'instatic.public-auth',
  name: 'Public Authentication',
  version: '0.1.0',
  permissions: ['cms.migrations', 'cms.routes', 'cms.routes.public', 'cms.publicRoutes', 'cms.hooks']
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

    // ─── GDPR routes (authenticated) ──────────────────────────────────────
    await api.cms.routes.register('GET', '/api/auth/me/export', 'authenticated', async (ctx, _req) => {
      const userId = (ctx.userId ?? '') as string
      if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return handleExport(ctx, userId)
    })
    await api.cms.routes.register('POST', '/api/auth/me/delete', 'authenticated', async (ctx, req) => {
      const userId = (ctx.userId ?? '') as string
      if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return handleDelete(ctx, userId, req)
    })

    // ─── MFA / 2FA routes ───────────────────────────────────────────────────
    const mfaSettings: MfaSettings = {
      jwtSecret: settings.jwtSecret,
      mfaTokenTtlSeconds: 300,  // 5 min
    }
    await api.cms.routes.register('POST', '/api/auth/mfa/setup', 'authenticated', async (ctx, _req) => {
      const userId = (ctx.userId ?? '') as string
      if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return handleMfaSetup(ctx, userId, mfaSettings)
    })
    await api.cms.routes.register('POST', '/api/auth/mfa/enable', 'authenticated', async (ctx, req) => {
      const userId = (ctx.userId ?? '') as string
      if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return handleMfaEnable(ctx, userId, req, mfaSettings)
    })
    await api.cms.routes.register('POST', '/api/auth/mfa/disable', 'authenticated', async (ctx, req) => {
      const userId = (ctx.userId ?? '') as string
      if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return handleMfaDisable(ctx, userId, req)
    })
    await api.cms.routes.register('POST', '/api/auth/mfa/verify', 'public', async (ctx, req) => {
      return handleMfaVerify(ctx, req, mfaSettings)
    })
    await api.cms.routes.register('POST', '/api/auth/mfa/recovery-codes/regenerate', 'authenticated', async (ctx, req) => {
      const userId = (ctx.userId ?? '') as string
      if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return handleMfaRegenerateRecoveryCodes(ctx, userId, req)
    })

    // Expose issueMfaToken for downstream plugins (login flow integration)
    ;(api as { exports?: Record<string, unknown> }).exports = {
      issueMfaToken: (userId: string) => issueMfaToken(userId, mfaSettings),
    }

    // ─── Passwordless login ────────────────────────────────────────────────
    const passwordlessSettings = {
      baseUrl: (await api.settings.get('siteUrl') as string) ?? 'http://localhost:3000',
      jwtSecret: settings.jwtSecret,
      mfaTokenTtlSeconds: 300,
    }
    await api.cms.routes.register('POST', '/api/auth/passwordless/request', 'public', async (ctx, req) => {
      return handlePasswordlessRequest(ctx, req, passwordlessSettings)
    })
    await api.cms.routes.register('GET', '/api/auth/passwordless/verify', 'public', async (ctx, req) => {
      return handlePasswordlessVerify(ctx, req, passwordlessSettings)
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
}

export async function deactivate(api: any) {
api.log.info('public-auth plugin deactivated')
}

