/**
 * OIDC Provider plugin — server entrypoint.
 *
 * Implements a full OAuth 2.0 Authorization Server + OpenID Connect Provider:
 *   - Authorization Code flow with PKCE (RFC 7636)
 *   - Refresh Token rotation (RFC 6749 §6)
 *   - Client Credentials grant (machine-to-machine)
 *   - Discovery (/.well-known/openid-configuration)
 *   - JWKS (/.well-known/jwks.json)
 *   - Token introspection (RFC 7662)
 *   - Token revocation (RFC 7009)
 *   - RP-initiated logout
 *
 * End-user identity is delegated to @instatic/plugin-public-auth.
 * The plugin reads `public_users` directly (not through public-auth's API)
 * for performance — but only read-only fields needed for ID token claims.
 *
 * Signing keys are RS256, generated on first activation and persisted in
 * `plugin_secrets` (encrypted at rest by the host).
 *
 * Social login (Google, GitHub, etc.) is OUT OF SCOPE for this plugin —
 * that lives in a separate `plugin: social-login` plugin that bridges
 * this plugin's authorize endpoint to external OAuth providers via the
 * `network.outbound` permission.
 */

import { definePlugin } from '@instatic/plugin-sdk'
import migrations from './migrations'
import {
  handleAdminCreateClient,
  handleAdminDeleteClient,
  handleAdminListClients,
  handleAuthorize,
  handleConsent,
  handleDiscovery,
  handleIntrospect,
  handleJwks,
  handleLogout,
  handleRevoke,
  handleToken,
  handleUserinfo,
} from './routes'
import { generateKeyPair, type KeyPair } from './jwt'

interface OidcSettings {
  issuer: string
  accessTokenTtlSeconds: number
  refreshTokenTtlSeconds: number
  idTokenTtlSeconds: number
  authCodeTtlSeconds: number
  requirePkce: boolean
}

export default definePlugin({
id: 'instatic.oidc-provider',
  name: 'OIDC Provider',
  version: '0.1.0',
  permissions: ['cms.migrations', 'cms.routes', 'cms.routes.public', 'cms.publicRoutes']
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
    const settings: OidcSettings = {
      issuer: String(await api.settings.get('issuer') ?? ''),
      accessTokenTtlSeconds: Number(await api.settings.get('accessTokenTtlSeconds')) || 3600,
      refreshTokenTtlSeconds: Number(await api.settings.get('refreshTokenTtlSeconds')) || 2592000,
      idTokenTtlSeconds: Number(await api.settings.get('idTokenTtlSeconds')) || 3600,
      authCodeTtlSeconds: Number(await api.settings.get('authCodeTtlSeconds')) || 600,
      requirePkce: !!(await api.settings.get('requirePkce')),
    }
    if (!settings.issuer) {
      throw new Error('oidc-provider: issuer setting is required')
    }

    // ─── Signing keys ──────────────────────────────────────────────────────
    // Try to load existing key pair from plugin_secrets; generate fresh if missing.
    let keyPair: KeyPair | null = null
    try {
      const existing = await api.secrets.get('signingKey')
      if (existing) {
        const parsed = JSON.parse(existing) as KeyPair
        if (parsed.privatePem && parsed.publicPem && parsed.kid) {
          keyPair = parsed
        }
      }
    } catch (err) {
      api.log.warn('Failed to load existing signing key', err)
    }
    if (!keyPair) {
      keyPair = generateKeyPair()
      await api.secrets.set('signingKey', JSON.stringify(keyPair))
      api.log.info('Generated new RS256 signing key pair')
    }

    // ─── Public routes ─────────────────────────────────────────────────────
    // OIDC endpoints live at well-known paths; use publicRoutes to bypass the
    // /admin/api/cms/plugins/... prefix.
    await api.cms.publicRoutes.register('/.well-known', { exclusive: false })
    await api.cms.publicRoutes.register('/oauth', { exclusive: true })

    await api.cms.routes.register('GET', '/.well-known/openid-configuration', 'public', async (ctx) => {
      return handleDiscovery(ctx, settings)
    })
    await api.cms.routes.register('GET', '/.well-known/jwks.json', 'public', async (ctx) => {
      return handleJwks(ctx, keyPair!)
    })

    await api.cms.routes.register('GET', '/oauth/authorize', 'public', async (ctx, req) => {
      return handleAuthorize(ctx, req, settings)
    })
    await api.cms.routes.register('POST', '/oauth/authorize/consent', 'public', async (ctx, req) => {
      return handleConsent(ctx, req, settings)
    })
    await api.cms.routes.register('POST', '/oauth/token', 'public', async (ctx, req) => {
      return handleToken(ctx, req, settings, keyPair!)
    })
    await api.cms.routes.register('POST', '/oauth/revoke', 'public', async (ctx, req) => {
      return handleRevoke(ctx, req)
    })
    await api.cms.routes.register('POST', '/oauth/introspect', 'public', async (ctx, req) => {
      return handleIntrospect(ctx, req)
    })
    await api.cms.routes.register('GET', '/oauth/userinfo', 'public', async (ctx, req) => {
      return handleUserinfo(ctx, req)
    })
    await api.cms.routes.register('GET', '/oauth/logout', 'public', async (ctx, req) => {
      return handleLogout(ctx, req)
    })

    // ─── Admin client CRUD ─────────────────────────────────────────────────
    await api.cms.routes.register('GET', '/admin/api/oidc/clients', 'users.manage', handleAdminListClients)
    await api.cms.routes.register('POST', '/admin/api/oidc/clients', 'users.manage', async (ctx, req) => {
      return handleAdminCreateClient(ctx, req)
    })
    await api.cms.routes.register('DELETE', '/admin/api/oidc/clients/:id', 'users.manage', async (ctx, _req, params) => {
      return handleAdminDeleteClient(ctx, params.id)
    })

    // ─── Key rotation ────────────────────────────────────────────────────
    await api.cms.routes.register('POST', '/admin/api/oidc/rotate-keys', 'users.manage', async (_ctx) => {
      const newKeyPair = generateKeyPair()
      // 保留旧密钥供当前 token 验证使用（双密钥过渡期 1 小时）
      const oldKeyJson = JSON.stringify(keyPair!)
      await api.secrets.set('signingKeyPrevious', oldKeyJson)
      await api.secrets.set('signingKey', JSON.stringify(newKeyPair))
      // 替换运行时引用
      keyPair = newKeyPair
      api.log.info('OIDC signing keys rotated')
      return Response.json({ rotated: true, kid: newKeyPair.kid })
    })

    api.log.info(`oidc-provider activated; issuer=${settings.issuer}`)
}

export async function deactivate(api: any) {
// Host automatically removes registered routes. Signing key stays in
    // plugin_secrets so re-activation doesn't invalidate tokens (re-use the
    // same key pair). To rotate, use the plugin settings UI (TODO).
    api.log.info('oidc-provider deactivated')
}

