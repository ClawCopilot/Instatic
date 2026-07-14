/**
 * OIDC route handlers — the OAuth 2.0 / OpenID Connect Provider surface.
 *
 * Endpoints:
 *   GET  /.well-known/openid-configuration  — Discovery document
 *   GET  /.well-known/jwks.json             — Public signing keys (JWKS)
 *
 *   GET  /oauth/authorize                  — Authorization endpoint
 *   POST /oauth/authorize/consent          — User consent submission
 *   POST /oauth/token                      — Token endpoint
 *   POST /oauth/revoke                     — Token revocation
 *   GET  /oauth/userinfo                   — Userinfo endpoint
 *   GET  /oauth/logout                     — RP-initiated logout
 *   POST /oauth/introspect                 — Token introspection (RFC 7662)
 *
 *   Admin (requires users.manage):
 *     GET    /admin/api/oidc/clients
 *     POST   /admin/api/oidc/clients
 *     PATCH  /admin/api/oidc/clients/:id
 *     DELETE /admin/api/oidc/clients/:id
 *
 * Flow:
 *   1. Client redirects user → /oauth/authorize?client_id=...&redirect_uri=...&scope=...&state=...&code_challenge=...&code_challenge_method=S256
 *   2. If not logged in, redirect to /login?next=/oauth/authorize?... (handled by public-auth UI)
 *   3. Show consent screen (or auto-approve if previously consented)
 *   4. User clicks "Allow" → POST /oauth/authorize/consent
 *   5. Server stores auth code + redirects to client.redirect_uri?code=AUTH_CODE&state=...
 *   6. Client POSTs /oauth/token with code + client credentials + code_verifier
 *   7. Server returns { access_token, id_token, refresh_token?, expires_in, token_type: 'Bearer' }
 */

import { createHash, randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { ApiCallContext } from '@instatic/plugin-sdk'
import {
  consumeAuthCode,
  createAccessToken,
  createAuthCode,
  createClient,
  createRefreshToken,
  deleteClient,
  findAccessToken,
  findClientByClientId,
  findConsent,
  findRefreshToken,
  listClients,
  recordConsent,
  revokeTokenFamily,
  rotateRefreshToken,
  touchAccessToken,
  revokeAccessToken,
  type OidcClient,
} from './store'
import {
  generateAuthCode,
  generateKeyPair as _generateKeyPair,
  generateOpaqueToken,
  hashToken,
  publicKeyToJwk,
  signJwt,
  type KeyPair,
} from './jwt'

interface OidcSettings {
  issuer: string
  accessTokenTtlSeconds: number
  refreshTokenTtlSeconds: number
  idTokenTtlSeconds: number
  authCodeTtlSeconds: number
  requirePkce: boolean
}

// ─── Discovery ───────────────────────────────────────────────────────────

export async function handleDiscovery(api: ApiCallContext, settings: OidcSettings): Promise<Response> {
  const issuer = settings.issuer.replace(/\/$/, '')
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    introspection_endpoint: `${issuer}/oauth/introspect`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    end_session_endpoint: `${issuer}/oauth/logout`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    code_challenge_methods_supported: ['S256', 'plain'],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'email', 'email_verified', 'name', 'preferred_username'],
  }, {
    headers: {
      'cache-control': 'public, max-age=3600',
    },
  })
}

// ─── JWKS ────────────────────────────────────────────────────────────────

export async function handleJwks(api: ApiCallContext, keyPair: KeyPair): Promise<Response> {
  return Response.json({
    keys: [publicKeyToJwk(keyPair.publicPem, keyPair.kid)],
  }, {
    headers: { 'cache-control': 'public, max-age=86400' },
  })
}

// ─── Authorize ───────────────────────────────────────────────────────────

interface AuthorizeParams {
  client_id: string
  redirect_uri: string
  response_type: string
  scope: string
  state: string
  code_challenge?: string
  code_challenge_method?: string
  nonce?: string
}

function parseAuthorizeParams(url: URL): AuthorizeParams {
  return {
    client_id: url.searchParams.get('client_id') ?? '',
    redirect_uri: url.searchParams.get('redirect_uri') ?? '',
    response_type: url.searchParams.get('response_type') ?? '',
    scope: url.searchParams.get('scope') ?? 'openid',
    state: url.searchParams.get('state') ?? '',
    code_challenge: url.searchParams.get('code_challenge') ?? undefined,
    code_challenge_method: url.searchParams.get('code_challenge_method') ?? undefined,
    nonce: url.searchParams.get('nonce') ?? undefined,
  }
}

function validateRedirectUri(client: OidcClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri)
}

function authorizeError(
  redirectUri: string | null,
  error: string,
  description: string,
  state: string | null,
): Response {
  if (redirectUri) {
    const params = new URLSearchParams({ error, error_description: description })
    if (state) params.set('state', state)
    return Response.redirect(`${redirectUri}?${params}`, 302)
  }
  return Response.json({ error, error_description: description }, { status: 400 })
}

export async function handleAuthorize(
  api: ApiCallContext,
  req: Request,
  settings: OidcSettings,
): Promise<Response> {
  const url = new URL(req.url)
  const params = parseAuthorizeParams(url)
  const client = await findClientByClientId(api.db, params.client_id)
  if (!client) return authorizeError(null, 'invalid_client', 'Unknown client_id', params.state)
  if (!validateRedirectUri(client, params.redirect_uri)) {
    return authorizeError(null, 'invalid_request', 'redirect_uri not registered', params.state)
  }
  if (params.response_type !== 'code') {
    return authorizeError(params.redirect_uri, 'unsupported_response_type',
      'Only response_type=code is supported', params.state)
  }
  const scopes = params.scope.split(/\s+/).filter(Boolean)
  for (const s of scopes) {
    if (!client.allowedScopes.includes(s)) {
      return authorizeError(params.redirect_uri, 'invalid_scope',
        `Scope "${s}" not allowed for this client`, params.state)
    }
  }
  // PKCE validation
  if (client.requirePkce || settings.requirePkce || client.clientType === 'public') {
    if (!params.code_challenge) {
      return authorizeError(params.redirect_uri, 'invalid_request',
        'code_challenge required (PKCE)', params.state)
    }
    if (params.code_challenge_method && !['S256', 'plain'].includes(params.code_challenge_method)) {
      return authorizeError(params.redirect_uri, 'invalid_request',
        'code_challenge_method must be S256 or plain', params.state)
    }
  }

  // Check if user is logged in (via public-auth viewer)
  const viewer = api.viewer as { loggedIn?: boolean; userId?: string } | undefined
  if (!viewer?.loggedIn || !viewer.userId) {
    // Redirect to login, preserving the original authorize URL as `next`
    const loginUrl = `/login?next=${encodeURIComponent(url.pathname + url.search)}`
    return Response.redirect(loginUrl, 302)
  }

  // Check consent
  const existingConsent = await findConsent(api.db, viewer.userId, client.clientId)
  const needsConsent = client.requireConsent && (
    !existingConsent ||
    !scopes.every((s) => existingConsent.scopes.includes(s))
  )
  if (needsConsent) {
    // Render consent page (HTML) with hidden form that POSTs to /oauth/authorize/consent
    return renderConsentPage(client, params, viewer.userId, scopes)
  }

  // Auto-approve: issue auth code and redirect
  return await issueAuthCodeAndRedirect(api, settings, client, params, viewer.userId, scopes)
}

function renderConsentPage(
  client: OidcClient,
  params: AuthorizeParams,
  userId: string,
  scopes: string[],
): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorize ${client.name}</title>
<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:20px;color:#222}
.scope{padding:8px 12px;background:#f5f5f5;margin:6px 0;border-radius:6px}
button{padding:10px 20px;margin:8px 6px 0 0;border:none;border-radius:6px;cursor:pointer}
.allow{background:#0a66c2;color:#fff}
.deny{background:#eee;color:#444}</style>
</head><body>
<h1>Authorize ${escapeHtml(client.name)}</h1>
<p>This application wants to access your account with the following permissions:</p>
${scopes.map((s) => `<div class="scope">${escapeHtml(s)}</div>`).join('')}
<form method="POST" action="/oauth/authorize/consent">
  <input type="hidden" name="client_id" value="${escapeHtml(params.client_id)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirect_uri)}">
  <input type="hidden" name="scope" value="${escapeHtml(params.scope)}">
  <input type="hidden" name="state" value="${escapeHtml(params.state)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(params.code_challenge ?? '')}">
  <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.code_challenge_method ?? '')}">
  <input type="hidden" name="nonce" value="${escapeHtml(params.nonce ?? '')}">
  <input type="hidden" name="user_id" value="${escapeHtml(userId)}">
  <button type="submit" name="action" value="allow" class="allow">Allow</button>
  <button type="submit" name="action" value="deny" class="deny">Deny</button>
</form>
</body></html>`
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c))
}

async function issueAuthCodeAndRedirect(
  api: ApiCallContext,
  settings: OidcSettings,
  client: OidcClient,
  params: AuthorizeParams,
  userId: string,
  scopes: string[],
): Promise<Response> {
  const code = generateAuthCode()
  await createAuthCode(api.db, {
    codeHash: hashToken(code),
    clientId: client.clientId,
    userId,
    redirectUri: params.redirect_uri,
    scopes,
    codeChallenge: params.code_challenge ?? null,
    codeChallengeMethod: params.code_challenge_method ?? null,
    nonce: params.nonce ?? null,
    authTime: new Date().toISOString(),
    expiresAt: new Date(Date.now() + settings.authCodeTtlSeconds * 1000).toISOString(),
  })
  const redirect = new URL(params.redirect_uri)
  redirect.searchParams.set('code', code)
  if (params.state) redirect.searchParams.set('state', params.state)
  return Response.redirect(redirect.toString(), 302)
}

// ─── Consent ─────────────────────────────────────────────────────────────

export async function handleConsent(
  api: ApiCallContext,
  req: Request,
  settings: OidcSettings,
): Promise<Response> {
  const form = await req.formData()
  const action = form.get('action')
  const clientId = String(form.get('client_id') ?? '')
  const redirectUri = String(form.get('redirect_uri') ?? '')
  const scope = String(form.get('scope') ?? '')
  const state = String(form.get('state') ?? '')
  const codeChallenge = (form.get('code_challenge') as string) || undefined
  const codeChallengeMethod = (form.get('code_challenge_method') as string) || undefined
  const nonce = (form.get('nonce') as string) || undefined
  const userId = String(form.get('user_id') ?? '')

  const client = await findClientByClientId(api.db, clientId)
  if (!client || !userId) return authorizeError(redirectUri || null, 'invalid_request', 'Invalid consent submission', state)
  if (action === 'deny') {
    return authorizeError(redirectUri, 'access_denied', 'User denied consent', state)
  }
  const scopes = scope.split(/\s+/).filter(Boolean)
  await recordConsent(api.db, { userId, clientId: client.clientId, scopes })
  return await issueAuthCodeAndRedirect(
    api, settings, client,
    { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, state, code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod, nonce },
    userId, scopes,
  )
}

// ─── Token endpoint ──────────────────────────────────────────────────────

function verifyCodeVerifier(verifier: string, challenge: string, method: string): boolean {
  if (method === 'plain' || !method) return verifier === challenge
  if (method === 'S256') {
    const computed = createHash('sha256').update(verifier).digest('base64url')
    return computed === challenge
  }
  return false
}

async function authenticateClient(api: ApiCallContext, req: Request): Promise<{ client: OidcClient; secret: string | null } | null> {
  const authHeader = req.headers.get('authorization')
  let clientId: string | null = null
  let clientSecret: string | null = null
  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8')
    const [id, secret] = decoded.split(':', 2)
    clientId = id
    clientSecret = secret ? decodeURIComponent(secret) : null
  } else {
    const body = await req.clone().formData().catch(() => null)
    if (body) {
      clientId = String(body.get('client_id') ?? '')
      clientSecret = (body.get('client_secret') as string) || null
    }
  }
  if (!clientId) return null
  const client = await findClientByClientId(api.db, clientId)
  if (!client) return null
  // Public clients authenticate with no secret (PKCE-only)
  if (client.clientType === 'public') return { client, secret: null }
  // Confidential clients must provide a secret
  if (!clientSecret || !client.clientSecretHash) return null
  if (hashToken(clientSecret) !== client.clientSecretHash) return null
  return { client, secret: clientSecret }
}

export async function handleToken(
  api: ApiCallContext,
  req: Request,
  settings: OidcSettings,
  keyPair: KeyPair,
): Promise<Response> {
  if (req.method !== 'POST') {
    return Response.json({ error: 'invalid_request', error_description: 'POST required' }, { status: 405 })
  }
  const auth = await authenticateClient(api, req)
  if (!auth) {
    return Response.json({ error: 'invalid_client' }, {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="oauth"' },
    })
  }
  const { client } = auth
  const body = await req.formData()
  const grantType = String(body.get('grant_type') ?? '')

  switch (grantType) {
    case 'authorization_code': {
      const code = String(body.get('code') ?? '')
      const redirectUri = String(body.get('redirect_uri') ?? '')
      const codeVerifier = String(body.get('code_verifier') ?? '')
      const consumed = await consumeAuthCode(api.db, hashToken(code))
      if (!consumed) {
        return Response.json({ error: 'invalid_grant', error_description: 'Invalid or expired code' }, { status: 400 })
      }
      if (consumed.clientId !== client.clientId) {
        return Response.json({ error: 'invalid_grant', error_description: 'Code was issued to a different client' }, { status: 400 })
      }
      if (consumed.redirectUri !== redirectUri) {
        return Response.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, { status: 400 })
      }
      if (consumed.codeChallenge) {
        if (!verifyCodeVerifier(codeVerifier, consumed.codeChallenge, consumed.codeChallengeMethod ?? 'plain')) {
          return Response.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, { status: 400 })
        }
      }
      const issued = await issueTokens(api, settings, keyPair, client, consumed.userId, consumed.scopes)
      if (consumed.nonce) issued.id_token_nonce = consumed.nonce
      return Response.json(issued, {
        headers: { 'cache-control': 'no-store', 'pragma': 'no-cache' },
      })
    }
    case 'refresh_token': {
      const refreshToken = String(body.get('refresh_token') ?? '')
      const tokenHash = hashToken(refreshToken)
      const existing = await findRefreshToken(api.db, tokenHash)
      if (!existing || existing.clientId !== client.clientId) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      // ── Replay detection ─────────────────────────────────────────────
      // The token hasn't been revoked yet AND hasn't expired. But we need
      // to also check if a NEWER token in the same family has been issued
      // (which would mean this token was already rotated). If so, this is
      // a replay — the legitimate user has moved on; this caller is the
      // attacker (or a misbehaving client).
      const newerInFamily = await api.db`
        select 1 from oidc_refresh_tokens
        where rotated_from = ${tokenHash}
          and revoked_at is null
        limit 1
      `
      if (newerInFamily.length > 0) {
        // REPLAY DETECTED — revoke the entire token family
        const revokedCount = await revokeTokenFamily(api.db, tokenHash)
        // Emit a hook so the security plugin can notify the user
        await api.hooks.emit('oidc.tokenReplayDetected', {
          userId: existing.userId,
          clientId: existing.clientId,
          tokenHashPrefix: tokenHash.slice(0, 8),
          revokedCount,
          clientIp: req.headers.get('x-forwarded-for'),
          userAgent: req.headers.get('user-agent'),
          detectedAt: new Date().toISOString(),
        })
        // 记录重放信号到审计表，用于追踪和限速检测
        await api.db`
          insert into oidc_token_replay_signals (id, client_id, user_id, token_hash_prefix, client_ip, detected_at)
          values (
            ${nanoid()},
            ${existing.clientId},
            ${existing.userId},
            ${tokenHash.slice(0, 8)},
            ${req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? ''},
            now()
          )
        `
        // 限速检测：如果该 client 在过去 1 小时内重放次数 >= 5，临时拒绝请求
        const { rows: recentReplays } = await api.db`
          select count(*)::int as cnt from oidc_token_replay_signals
          where client_id = ${existing.clientId}
            and detected_at > now() - interval '1 hour'
        `
        if ((recentReplays[0]?.cnt ?? 0) >= 5) {
          return Response.json({
            error: 'too_many_replay_attempts',
            error_description: 'Too many token replay attempts from this client. Access temporarily blocked.',
          }, { status: 429 })
        }
        return Response.json({
          error: 'invalid_grant',
          error_description: 'Token replay detected. All sessions for this client have been revoked.',
        }, { status: 400 })
      }
      const issued = await issueTokens(api, settings, keyPair, client, existing.userId ?? '', existing.scopes)
      // Rotate refresh token (one-time use)
      const newRefresh = generateOpaqueToken(32)
      const newAccessHash = hashToken(issued.access_token)
      await rotateRefreshToken(api.db, existing.tokenHash, hashToken(newRefresh), newAccessHash)
      issued.refresh_token = newRefresh
      return Response.json(issued, {
        headers: { 'cache-control': 'no-store' },
      })
    }
    case 'client_credentials': {
      if (!client.allowedGrantTypes.includes('client_credentials')) {
        return Response.json({ error: 'unauthorized_client' }, { status: 400 })
      }
      const issued = await issueTokens(api, settings, keyPair, client, null, ['api'])
      return Response.json(issued, { headers: { 'cache-control': 'no-store' } })
    }
    default:
      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
  }
}

async function issueTokens(
  api: ApiCallContext,
  settings: OidcSettings,
  keyPair: KeyPair,
  client: OidcClient,
  userId: string | null,
  scopes: string[],
): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000)
  const accessToken = generateOpaqueToken(32)
  const accessExpires = new Date(Date.now() + settings.accessTokenTtlSeconds * 1000).toISOString()
  await createAccessToken(api.db, {
    tokenHash: hashToken(accessToken),
    clientId: client.clientId,
    userId,
    scopes,
    expiresAt: accessExpires,
  })
  const out: Record<string, unknown> = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: settings.accessTokenTtlSeconds,
    scope: scopes.join(' '),
  }
  // Issue ID token if 'openid' scope is requested AND user is authenticated
  if (scopes.includes('openid') && userId) {
    const userProfile = await loadUserProfile(api, userId)
    if (userProfile) {
      const idTokenClaims = {
        iss: settings.issuer.replace(/\/$/, ''),
        sub: userId,
        aud: client.clientId,
        exp: now + settings.idTokenTtlSeconds,
        iat: now,
        auth_time: now,
        ...(scopes.includes('email') ? { email: userProfile.email, email_verified: !!userProfile.emailVerified } : {}),
        ...(scopes.includes('profile') ? { name: userProfile.displayName, preferred_username: userProfile.email } : {}),
      }
      out.id_token = signJwt(idTokenClaims, keyPair)
    }
  }
  // Issue refresh token if 'offline_access' scope is granted AND user is authenticated
  if (scopes.includes('offline_access') && userId) {
    const refreshToken = generateOpaqueToken(32)
    const refreshExpires = new Date(Date.now() + settings.refreshTokenTtlSeconds * 1000).toISOString()
    await createRefreshToken(api.db, {
      tokenHash: hashToken(refreshToken),
      accessTokenHash: hashToken(accessToken),
      clientId: client.clientId,
      userId,
      scopes,
      expiresAt: refreshExpires,
      rotatedFrom: null,
    })
    out.refresh_token = refreshToken
  }
  return out
}

async function loadUserProfile(api: ApiCallContext, userId: string): Promise<{ email: string; emailVerified: boolean | null; displayName: string } | null> {
  const { rows } = await api.db`
    select email, email_verified_at, display_name from public_users where id = ${userId} limit 1
  `
  if (!rows[0]) return null
  return {
    email: rows[0].email,
    emailVerified: rows[0].email_verified_at,
    displayName: rows[0].display_name,
  }
}

// ─── Userinfo ────────────────────────────────────────────────────────────

export async function handleUserinfo(api: ApiCallContext, req: Request): Promise<Response> {
  const token = extractBearerToken(req)
  if (!token) return Response.json({ error: 'invalid_token' }, { status: 401 })
  const access = await findAccessToken(api.db, hashToken(token))
  if (!access) return Response.json({ error: 'invalid_token' }, { status: 401 })
  await touchAccessToken(api.db, access.tokenHash)
  if (!access.userId) return Response.json({ error: 'insufficient_scope' }, { status: 403 })
  const profile = await loadUserProfile(api, access.userId)
  if (!profile) return Response.json({ error: 'user_not_found' }, { status: 404 })
  const claims: Record<string, unknown> = { sub: access.userId }
  if (access.scopes.includes('email')) {
    claims.email = profile.email
    claims.email_verified = !!profile.emailVerified
  }
  if (access.scopes.includes('profile')) {
    claims.name = profile.displayName
    claims.preferred_username = profile.email
  }
  return Response.json(claims)
}

function extractBearerToken(req: { headers: { get(name: string): string | null } }): string | null {
  const auth = req.headers.get('authorization')?.trim()
  if (!auth) return null
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || null
  return null
}

// ─── Revoke / Introspect ─────────────────────────────────────────────────

export async function handleRevoke(api: ApiCallContext, req: Request): Promise<Response> {
  const auth = await authenticateClient(api, req)
  if (!auth) return new Response(null, { status: 401 })
  const body = await req.formData()
  const token = String(body.get('token') ?? '')
  if (!token) return new Response(null, { status: 200 })  // RFC 7009: ignore invalid
  await revokeAccessToken(api.db, hashToken(token))
  return new Response(null, { status: 200 })
}

export async function handleIntrospect(api: ApiCallContext, req: Request): Promise<Response> {
  const auth = await authenticateClient(api, req)
  if (!auth) return Response.json({ error: 'invalid_client' }, { status: 401 })
  const body = await req.formData()
  const token = String(body.get('token') ?? '')
  if (!token) return Response.json({ active: false })
  const access = await findAccessToken(api.db, hashToken(token))
  if (!access) return Response.json({ active: false })
  return Response.json({
    active: true,
    scope: access.scopes.join(' '),
    client_id: access.clientId,
    sub: access.userId,
    exp: Math.floor(new Date(access.expiresAt).getTime() / 1000),
    iat: Math.floor(new Date(access.createdAt).getTime() / 1000),
  })
}

// ─── Logout ──────────────────────────────────────────────────────────────

export async function handleLogout(api: ApiCallContext, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const postLogoutRedirect = url.searchParams.get('post_logout_redirect_uri')
  const state = url.searchParams.get('state')
  // Clear public-auth cookie (delegated to public-auth plugin)
  const response = new Response(null, {
    status: 302,
    headers: {
      location: postLogoutRedirect ?? '/',
      'set-cookie': 'public_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    },
  })
  if (state) response.headers.set('location', `${postLogoutRedirect ?? '/'}?state=${state}`)
  return response
}

// ─── Admin client CRUD ───────────────────────────────────────────────────

export async function handleAdminListClients(api: ApiCallContext): Promise<Response> {
  const clients = await listClients(api.db)
  // Strip secrets from response
  return Response.json({ clients: clients.map(({ clientSecretHash: _, ...c }) => c) })
}

export async function handleAdminCreateClient(
  api: ApiCallContext,
  req: Request,
): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const clientType = (body.clientType as string) ?? 'confidential'
  const clientSecret = clientType === 'confidential' ? generateOpaqueToken(32) : null
  const client = await createClient(api.db, {
    id: nanoid(),
    clientId: String(body.clientId ?? `client_${randomBytes(8).toString('hex')}`),
    clientSecretHash: clientSecret ? hashToken(clientSecret) : null,
    name: String(body.name ?? ''),
    description: String(body.description ?? ''),
    redirectUris: (body.redirectUris as string[]) ?? [],
    allowedScopes: (body.allowedScopes as string[]) ?? ['openid', 'profile', 'email'],
    allowedGrantTypes: (body.allowedGrantTypes as ('authorization_code' | 'refresh_token' | 'client_credentials')[]) ?? ['authorization_code', 'refresh_token'],
    clientType: clientType as 'confidential' | 'public',
    requirePkce: body.requirePkce !== false,
    requireConsent: body.requireConsent !== false,
    logoUrl: (body.logoUrl as string) ?? null,
    homepageUrl: (body.homepageUrl as string) ?? null,
    metadata: (body.metadata as Record<string, unknown>) ?? {},
  })
  return Response.json({
    client: { ...client, clientSecretHash: undefined },
    ...(clientSecret ? { clientSecret } : {}),  // shown only at creation
  }, { status: 201 })
}

export async function handleAdminDeleteClient(
  api: ApiCallContext,
  clientId: string,
): Promise<Response> {
  await deleteClient(api.db, clientId)
  return Response.json({ deleted: true })
}