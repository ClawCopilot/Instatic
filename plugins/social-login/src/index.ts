/**
 * Social Login plugin — server entrypoint.
 *
 * Bridges third-party OAuth identity providers (Google, GitHub, Apple,
 * WeChat) into the Instatic public-auth + oidc-provider flow.
 *
 * Flow:
 *   1. User clicks "Sign in with Google" → /api/auth/social/google?redirect_to=/dashboard
 *   2. Plugin stores state in DB, redirects to Google's authorize URL
 *   3. Google redirects back to /api/auth/social/google/callback?code=...&state=...
 *   4. Plugin validates state, exchanges code for tokens, fetches profile
 *   5. Plugin finds/creates the public_users row, links social_identities
 *   6. Plugin emits public-auth.userLoggedIn hook
 *   7. Plugin redirects to user's original target
 *
 * Account linking: if the social email matches an existing public_user
 * (who has a password), the accounts are linked (same public_user_id).
 * The user can then sign in either way.
 *
 * Apple Sign in has a quirk: it uses POST for callbacks (response_mode=form_post)
 * and the identity comes from the id_token rather than a userinfo endpoint.
 * The Apple adapter handles this by generating the ES256 client_secret
 * from the configured private key.
 */

import { definePlugin } from '@instatic/plugin-sdk'
import migrations from './migrations'
import { getProviderAdapters } from './providers'
import { handleAdminListMyIdentities, handleAdminUnlinkIdentity, handleCallback, handleStart } from './routes'

interface SocialSettings {
  googleClientId: string
  googleClientSecret: string
  githubClientId: string
  githubClientSecret: string
  appleClientId: string
  appleTeamId: string
  appleKeyId: string
  applePrivateKey: string
  wechatAppId: string
  wechatAppSecret: string
  enabledProviders: string
}

export default definePlugin({
id: 'instatic.social-login',
  name: 'Social Login',
  version: '0.1.0',
  permissions: ['cms.migrations', 'cms.routes', 'cms.routes.public', 'cms.publicRoutes', 'network.outbound', 'cms.hooks']
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

    const settings: SocialSettings = {
      googleClientId: (await api.settings.get('googleClientId') as string) ?? '',
      googleClientSecret: (await api.settings.get('googleClientSecret') as string) ?? '',
      githubClientId: (await api.settings.get('githubClientId') as string) ?? '',
      githubClientSecret: (await api.settings.get('githubClientSecret') as string) ?? '',
      appleClientId: (await api.settings.get('appleClientId') as string) ?? '',
      appleTeamId: (await api.settings.get('appleTeamId') as string) ?? '',
      appleKeyId: (await api.settings.get('appleKeyId') as string) ?? '',
      applePrivateKey: (await api.settings.get('applePrivateKey') as string) ?? '',
      wechatAppId: (await api.settings.get('wechatAppId') as string) ?? '',
      wechatAppSecret: (await api.settings.get('wechatAppSecret') as string) ?? '',
      enabledProviders: (await api.settings.get('enabledProviders') as string) ?? 'google,github',
    }
    const adapters = getProviderAdapters(settings)
    if (adapters.size === 0) {
      api.log.warn('social-login: no providers configured')
    } else {
      api.log.info(`social-login: enabled providers: ${[...adapters.keys()].join(', ')}`)
    }

    // ─── Public routes ─────────────────────────────────────────────────────
    await api.cms.publicRoutes.register('/api/auth/social', { exclusive: true })

    // /api/auth/social/:provider       → start
    // /api/auth/social/:provider/callback → callback (GET or POST)
    for (const provider of adapters.keys()) {
      await api.cms.routes.register('GET', `/api/auth/social/${provider}`, 'public', async (ctx, req) => {
        return handleStart(ctx, req, adapters)
      })
      await api.cms.routes.register('GET', `/api/auth/social/${provider}/callback`, 'public', async (ctx, req) => {
        return handleCallback(ctx, req, adapters)
      })
      // Apple uses POST
      await api.cms.routes.register('POST', `/api/auth/social/${provider}/callback`, 'public', async (ctx, req) => {
        return handleCallback(ctx, req, adapters)
      })
    }

    // ─── Admin routes ─────────────────────────────────────────────────────
    await api.cms.routes.register('GET', '/api/admin/social/identities', 'authenticated', handleAdminListMyIdentities)
    await api.cms.routes.register('DELETE', '/api/admin/social/identities/:provider', 'authenticated', async (ctx, _req, params) => {
      return handleAdminUnlinkIdentity(ctx, params.provider)
    })

    api.log.info('social-login plugin activated')
}

export async function deactivate(api: any) {
api.log.info('social-login plugin deactivated')
}

