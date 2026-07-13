/**
 * OAuth provider adapters — one per social identity provider.
 *
 * Each adapter implements:
 *   - `getAuthorizeUrl(state, redirectUri)` — build the provider's authorize URL
 *   - `exchangeCode(code, redirectUri)` — POST to provider's token endpoint
 *   - `fetchProfile(accessToken)` — fetch the user's identity
 *
 * The provider receives a redirect_uri built by the plugin (e.g.
 * `https://<host>/api/auth/social/google/callback`). The provider must
 * be configured with the EXACT same redirect_uri in its developer console.
 */

export interface SocialProfile {
  providerUserId: string
  email: string | null
  emailVerified: boolean
  displayName: string
  avatarUrl: string | null
  raw: Record<string, unknown>
}

export interface TokenResponse {
  accessToken: string
  refreshToken: string | null
  expiresIn: number | null
  scope: string
}

export interface ProviderAdapter {
  id: string
  name: string
  getAuthorizeUrl(args: { state: string; redirectUri: string; scopes: string[] }): string
  exchangeCode(args: { code: string; redirectUri: string }): Promise<TokenResponse>
  fetchProfile(accessToken: string): Promise<SocialProfile>
}

// ─── Google ──────────────────────────────────────────────────────────────

export function createGoogleAdapter(clientId: string, clientSecret: string): ProviderAdapter {
  return {
    id: 'google',
    name: 'Google',
    getAuthorizeUrl({ state, redirectUri, scopes }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        state,
        access_type: 'online',
        prompt: 'select_account',
      })
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
    },
    async exchangeCode({ code, redirectUri }) {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code',
        }),
      })
      if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`)
      const data = await res.json() as {
        access_token: string
        refresh_token?: string
        expires_in?: number
        scope: string
      }
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        expiresIn: data.expires_in ?? null,
        scope: data.scope,
      }
    },
    async fetchProfile(accessToken) {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new Error(`Google userinfo failed: ${res.status}`)
      const data = await res.json() as {
        id: string
        email: string
        verified_email?: boolean
        name: string
        picture?: string
      }
      return {
        providerUserId: data.id,
        email: data.email,
        emailVerified: !!data.verified_email,
        displayName: data.name,
        avatarUrl: data.picture ?? null,
        raw: data as Record<string, unknown>,
      }
    },
  }
}

// ─── GitHub ──────────────────────────────────────────────────────────────

export function createGitHubAdapter(clientId: string, clientSecret: string): ProviderAdapter {
  return {
    id: 'github',
    name: 'GitHub',
    getAuthorizeUrl({ state, redirectUri, scopes }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scopes.join(' '),
        state,
        allow_signup: 'true',
      })
      return `https://github.com/login/oauth/authorize?${params}`
    },
    async exchangeCode({ code, redirectUri }) {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'accept': 'application/json',
        },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
        }),
      })
      if (!res.ok) throw new Error(`GitHub token exchange failed: ${res.status}`)
      const data = await res.json() as {
        access_token: string
        refresh_token?: string
        expires_in?: number
        scope: string
      }
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        expiresIn: data.expires_in ?? null,
        scope: data.scope,
      }
    },
    async fetchProfile(accessToken) {
      const [userRes, emailsRes] = await Promise.all([
        fetch('https://api.github.com/user', {
          headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'instatic-social-login' },
        }),
        fetch('https://api.github.com/user/emails', {
          headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'instatic-social-login' },
        }),
      ])
      if (!userRes.ok) throw new Error(`GitHub user fetch failed: ${userRes.status}`)
      const user = await userRes.json() as {
        id: number
        login: string
        name: string | null
        email: string | null
        avatar_url: string | null
      }
      let email = user.email
      let emailVerified = false
      if (!email && emailsRes.ok) {
        const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>
        const primary = emails.find((e) => e.primary) ?? emails[0]
        if (primary) {
          email = primary.email
          emailVerified = primary.verified
        }
      } else if (email) {
        emailVerified = true  // GitHub only returns verified emails in this endpoint
      }
      return {
        providerUserId: String(user.id),
        email,
        emailVerified,
        displayName: user.name ?? user.login,
        avatarUrl: user.avatar_url,
        raw: { user, emails: emailsRes.ok ? await emailsRes.json() : null } as Record<string, unknown>,
      }
    },
  }
}

// ─── Apple (Sign in with Apple) ──────────────────────────────────────────
//
// Apple uses a JWT-based client_secret generated from a private key
// (ES256 algorithm). The token endpoint validates the secret signature.

import { createPrivateKey, sign as cryptoSign } from 'node:crypto'

export function createAppleAdapter(args: {
  clientId: string
  teamId: string
  keyId: string
  privateKeyPem: string
}): ProviderAdapter {
  return {
    id: 'apple',
    name: 'Apple',
    getAuthorizeUrl({ state, redirectUri, scopes }) {
      const params = new URLSearchParams({
        client_id: args.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        state,
        response_mode: 'form_post',
      })
      return `https://appleid.apple.com/auth/authorize?${params}`
    },
    async exchangeCode({ code, redirectUri }) {
      const clientSecret = generateAppleClientSecret(args)
      const res = await fetch('https://appleid.apple.com/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: args.clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      })
      if (!res.ok) throw new Error(`Apple token exchange failed: ${res.status} ${await res.text()}`)
      const data = await res.json() as {
        access_token: string
        refresh_token?: string
        id_token?: string
        expires_in: number
      }
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        expiresIn: data.expires_in,
        scope: 'name email',
      }
    },
    async fetchProfile(accessToken) {
      // Apple Sign In doesn't have a userinfo endpoint; identity comes
      // from the id_token returned alongside the access token. For this
      // simplified implementation, the caller passes the id_token claims
      // via a separate path (see handleAppleCallback).
      throw new Error('Apple profile must be extracted from id_token (use handleAppleCallback)')
    },
  }
}

function generateAppleClientSecret(args: {
  clientId: string
  teamId: string
  keyId: string
  privateKeyPem: string
}): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', kid: args.keyId }
  const payload = {
    iss: args.teamId,
    iat: now,
    exp: now + 86400 * 180,  // 6 months
    aud: 'https://appleid.apple.com',
    sub: args.clientId,
  }
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const headerEnc = enc(header)
  const payloadEnc = enc(payload)
  const signingInput = `${headerEnc}.${payloadEnc}`
  const keyObj = createPrivateKey(args.privateKeyPem)
  const signature = cryptoSign('sha256', Buffer.from(signingInput), keyObj)
  return `${signingInput}.${signature.toString('base64url')}`
}

// ─── WeChat (Open Platform / 网页授权) ───────────────────────────────────

export function createWeChatAdapter(appId: string, appSecret: string): ProviderAdapter {
  return {
    id: 'wechat',
    name: 'WeChat',
    getAuthorizeUrl({ state, redirectUri, scopes }) {
      const params = new URLSearchParams({
        appid: appId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(','),
        state,
      })
      return `https://open.weixin.qq.com/connect/oauth2/authorize?${params}#wechat_redirect`
    },
    async exchangeCode({ code, redirectUri }) {
      const res = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appId}&secret=${appSecret}&code=${code}&grant_type=authorization_code`)
      if (!res.ok) throw new Error(`WeChat token exchange failed: ${res.status}`)
      const data = await res.json() as {
        access_token: string
        refresh_token: string
        expires_in: number
        scope: string
        openid: string
        unionid?: string
      }
      if (!data.access_token) {
        throw new Error(`WeChat token exchange failed: ${JSON.stringify(data)}`)
      }
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        scope: data.scope,
      }
    },
    async fetchProfile(accessToken) {
      const res = await fetch(`https://api.weixin.qq.com/sns/userinfo?access_token=${accessToken}&lang=en`)
      if (!res.ok) throw new Error(`WeChat userinfo failed: ${res.status}`)
      const data = await res.json() as {
        openid: string
        unionid?: string
        nickname: string
        headimgurl?: string
        sex?: number
        country?: string
        province?: string
        city?: string
      }
      return {
        providerUserId: data.unionid ?? data.openid,
        email: null,  // WeChat Open Platform doesn't expose email
        emailVerified: false,
        displayName: data.nickname,
        avatarUrl: data.headimgurl ?? null,
        raw: data as Record<string, unknown>,
      }
    },
  }
}

export function getProviderAdapters(settings: {
  googleClientId: string; googleClientSecret: string
  githubClientId: string; githubClientSecret: string
  appleClientId: string; appleTeamId: string; appleKeyId: string; applePrivateKey: string
  wechatAppId: string; wechatAppSecret: string
  enabledProviders: string
}): Map<string, ProviderAdapter> {
  const enabled = new Set(settings.enabledProviders.split(',').map((s) => s.trim()).filter(Boolean))
  const map = new Map<string, ProviderAdapter>()
  if (enabled.has('google') && settings.googleClientId && settings.googleClientSecret) {
    map.set('google', createGoogleAdapter(settings.googleClientId, settings.googleClientSecret))
  }
  if (enabled.has('github') && settings.githubClientId && settings.githubClientSecret) {
    map.set('github', createGitHubAdapter(settings.githubClientId, settings.githubClientSecret))
  }
  if (enabled.has('apple') && settings.appleClientId && settings.applePrivateKey) {
    map.set('apple', createAppleAdapter({
      clientId: settings.appleClientId,
      teamId: settings.appleTeamId,
      keyId: settings.appleKeyId,
      privateKeyPem: settings.applePrivateKey,
    }))
  }
  if (enabled.has('wechat') && settings.wechatAppId && settings.wechatAppSecret) {
    map.set('wechat', createWeChatAdapter(settings.wechatAppId, settings.wechatAppSecret))
  }
  return map
}