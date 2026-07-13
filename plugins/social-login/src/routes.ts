/**
 * Social login route handlers.
 */

import { nanoid } from 'nanoid'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import {
  consumeState, createState, findIdentityByProviderEmail,
  findIdentityByProviderUser, generateState,
  listIdentitiesForUser, unlinkIdentity, upsertIdentity,
} from './store'
import { getProviderAdapters, type ProviderAdapter, type SocialProfile } from './providers'

const SCOPES_BY_PROVIDER: Record<string, string[]> = {
  google: ['openid', 'email', 'profile'],
  github: ['read:user', 'user:email'],
  apple: ['name', 'email'],
  wechat: ['snsapi_login'],
}

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

function buildCallbackUrl(req: Request, provider: string): string {
  const url = new URL(req.url)
  return `${url.protocol}//${url.host}/api/auth/social/${provider}/callback`
}

function resolveProvider(pathname: string): string | null {
  // /api/auth/social/<provider>[/callback]
  const match = pathname.match(/^\/api\/auth\/social\/([^/]+)(?:\/(?:callback))?$/)
  return match ? match[1] : null
}

export async function handleStart(
  api: ApiCallContext, req: Request,
  adapters: Map<string, ProviderAdapter>,
): Promise<Response> {
  const url = new URL(req.url)
  const provider = resolveProvider(url.pathname)
  if (!provider) return Response.json({ error: 'invalid_provider' }, { status: 400 })
  const adapter = adapters.get(provider)
  if (!adapter) return Response.json({ error: 'provider_not_configured' }, { status: 404 })

  const redirectTo = url.searchParams.get('redirect_to') ?? '/'
  const state = generateState()
  await createState(api.db, {
    state, provider, redirectTo, nonce: nanoid(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })
  const callbackUrl = buildCallbackUrl(req, provider)
  const scopes = SCOPES_BY_PROVIDER[provider] ?? []
  return Response.redirect(adapter.getAuthorizeUrl({ state, redirectUri: callbackUrl, scopes }), 302)
}

export async function handleCallback(
  api: ApiCallContext, req: Request,
  adapters: Map<string, ProviderAdapter>,
): Promise<Response> {
  let code: string | null = null
  let state: string | null = null
  if (req.method === 'POST') {
    const form = await req.formData()
    code = String(form.get('code') ?? '')
    state = String(form.get('state') ?? '')
  } else {
    const url = new URL(req.url)
    code = url.searchParams.get('code')
    state = url.searchParams.get('state')
  }
  if (!code || !state) return Response.json({ error: 'invalid_callback' }, { status: 400 })
  const stateRow = await consumeState(api.db, state)
  if (!stateRow) return Response.json({ error: 'invalid_or_expired_state' }, { status: 400 })
  const adapter = adapters.get(stateRow.provider)
  if (!adapter) return Response.json({ error: 'provider_not_configured' }, { status: 404 })

  const callbackUrl = buildCallbackUrl(req, stateRow.provider)
  let profile: SocialProfile
  let tokens
  try {
    tokens = await adapter.exchangeCode({ code, redirectUri: callbackUrl })
    profile = await adapter.fetchProfile(tokens.accessToken)
  } catch (err) {
    api.log.error(`Social exchange failed: ${err}`)
    return Response.json({ error: 'exchange_failed' }, { status: 502 })
  }

  // Resolve the public_users row
  let userId: string
  const existingById = await findIdentityByProviderUser(api.db, adapter.id, profile.providerUserId)
  if (existingById) {
    userId = existingById.userId
  } else if (profile.email) {
    const byEmail = await findIdentityByProviderEmail(api.db, adapter.id, profile.email)
    userId = byEmail ? byEmail.userId : await provisionNewUser(api, profile, profile.email)
  } else {
    userId = await provisionNewUser(api, profile, null)
  }
  await upsertIdentity(api.db, {
    userId,
    provider: adapter.id,
    providerUserId: profile.providerUserId,
    providerEmail: profile.email,
    providerDisplayName: profile.displayName,
    providerAvatarUrl: profile.avatarUrl,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : null,
    rawProfile: profile.raw,
  })
  await api.hooks.emit('public-auth.userLoggedIn', { userId, sessionId: nanoid(), provider: adapter.id })
  return Response.redirect(stateRow.redirectTo, 302)
}

async function provisionNewUser(api: ApiCallContext, profile: SocialProfile, email: string | null): Promise<string> {
  const userId = `usr_${nanoid(10)}`
  const placeholderHash = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const normalizedEmail = email?.toLowerCase() ?? `${profile.providerUserId}@${profile.provider}.invalid`
  await api.db`
    insert into public_users (id, email, email_normalized, display_name, password_hash, status, email_verified_at, metadata_json)
    values (${userId}, ${email ?? normalizedEmail}, ${normalizedEmail}, ${profile.displayName},
            ${placeholderHash}, 'active',
            ${profile.emailVerified ? new Date().toISOString() : null},
            ${JSON.stringify({ social_provisioned: true, provider: profile.provider })}::jsonb)
    on conflict (email_normalized) do nothing
  `
  await api.hooks.emit('public-auth.userRegistered', {
    userId, email: email ?? normalizedEmail, displayName: profile.displayName,
  })
  return userId
}

export async function handleAdminListMyIdentities(api: ApiCallContext): Promise<Response> {
  const viewer = api.viewer as { userId?: string } | undefined
  if (!viewer?.userId) return Response.json({ identities: [] })
  const identities = await listIdentitiesForUser(api.db, viewer.userId)
  return Response.json({
    identities: identities.map(({ accessToken: _a, refreshToken: _r, rawProfile: _p, ...rest }) => rest),
  })
}

export async function handleAdminUnlinkIdentity(
  api: ApiCallContext, provider: string,
): Promise<Response> {
  const viewer = api.viewer as { userId?: string } | undefined
  if (!viewer?.userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
  await unlinkIdentity(api.db, viewer.userId, provider)
  return Response.json({ unlinked: true })
}