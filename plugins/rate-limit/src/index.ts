/**
 * Rate Limit plugin — server entrypoint.
 *
 * Registers a single httpMiddleware that runs on EVERY request. It:
 *   1. Extracts the client IP (respects X-Forwarded-For when configured)
 *   2. Looks up a custom rule matching the path + method
 *   3. Falls back to the default per-IP limit
 *   4. Computes the bucket key (ip / user / ip+path / user+path)
 *   5. Calls checkAndRecord
 *   6. If denied, returns 429 with Retry-After + RateLimit-* headers
 *
 * Default rules (auto-installed):
 *   - /api/auth/login     — 10 req / 15 min / per IP
 *   - /api/auth/register  — 10 req / 15 min / per IP
 *   - /api/auth/password-reset/request — 5 req / 15 min / per IP
 *
 * Per-user rate limiting kicks in when the request carries a public-auth
 * session cookie / Bearer token. The middleware reads `api.viewer.userId`
 * to identify the user; anonymous traffic falls back to IP-only.
 *
 * HTTP response headers (draft-ietf-httpapi-ratelimit-headers):
 *   - RateLimit-Limit: <max>
 *   - RateLimit-Remaining: <remaining>
 *   - RateLimit-Reset: <seconds until reset>
 *   - Retry-After: <seconds>      (only on 429)
 */

import { definePlugin } from '@instatic/plugin-sdk'
import migrations from './migrations'
import {
  buildBucketKey,
  checkAndRecord,
  findRuleForPath,
  upsertRule,
} from './store'

interface RateLimitSettings {
  defaultLimit: number
  authLimit: number
  trustProxy: boolean
}

const DEFAULT_RULES: Array<{ path: string; method: string; requests: number; windowSeconds: number; description: string }> = [
  { path: '/api/auth/login', method: 'POST', requests: 10, windowSeconds: 900, description: 'Brute-force defense on login' },
  { path: '/api/auth/register', method: 'POST', requests: 10, windowSeconds: 900, description: 'Account spam defense' },
  { path: '/api/auth/password-reset/request', method: 'POST', requests: 5, windowSeconds: 900, description: 'Email enumeration defense' },
  { path: '/api/auth/verify-email', method: 'POST', requests: 10, windowSeconds: 900, description: 'Token brute-force defense' },
  { path: '/api/keys/me', method: 'GET', requests: 300, windowSeconds: 60, description: 'API key introspection' },
]

export default definePlugin({
id: 'instatic.rate-limit',
  name: 'Rate Limit',
  version: '0.1.0',
  permissions: ['cms.migrations', 'cms.httpMiddleware']
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
    const settings: RateLimitSettings = {
      defaultLimit: Number(await api.settings.get('defaultLimit')) || 60,
      authLimit: Number(await api.settings.get('authLimit')) || 10,
      trustProxy: !!(await api.settings.get('trustProxy')),
    }

    // Install default rules
    for (const rule of DEFAULT_RULES) {
      try {
        await upsertRule(api.db, {
          id: `rule_default_${rule.path.replace(/[^a-z0-9]/gi, '_')}`,
          pathPrefix: rule.path,
          method: rule.method,
          requests: rule.requests,
          windowSeconds: rule.windowSeconds,
          scope: 'ip',
          description: rule.description,
          enabled: true,
        })
      } catch (err) {
        api.log.warn(`Failed to install default rule ${rule.path}`, err)
      }
    }

    // Register middleware
    await api.cms.httpMiddleware.register(async (ctx) => {
      const url = new URL(ctx.req.url)
      const pathname = url.pathname
      const method = ctx.req.method

      // Skip middleware for non-throttled paths
      if (method === 'OPTIONS') return null
      if (pathname.startsWith('/_instatic/')) return null  // host assets
      if (pathname.startsWith('/admin/')) return null  // admin UI

      // Extract IP
      const ip = extractIp(ctx.req, settings.trustProxy) ?? '0.0.0.0'

      // Extract user id (if available)
      const viewer = (ctx.state.viewer ?? {}) as { userId?: string; loggedIn?: boolean }
      const userId = viewer.loggedIn ? viewer.userId : null

      // Find rule (most specific path prefix wins)
      const rule = await findRuleForPath(ctx.db, pathname, method)
      let limit: number
      let windowSeconds: number
      let scope: 'ip' | 'user' | 'ip+path' | 'user+path'
      if (rule) {
        limit = rule.requests
        windowSeconds = rule.windowSeconds
        scope = rule.scope
      } else {
        limit = settings.defaultLimit
        windowSeconds = 60
        scope = 'ip'
      }

      // 分片策略：bucketKey 天然按 (scope, ip/userId, path) 组合分片，
      // 使得不同路径、不同用户的计数存储在不同的行中，避免单一热点。
      // 数据库层面，checkAndRecord 通过 UPSERT 操作 rate_limit_counters 表，
      // 每个 bucketKey 对应一行，按 bucket_key 索引快速定位。
      // 高流量场景下，同一 IP 的大量请求集中在同一 bucketKey 上；
      // 可通过将 windowSeconds 细分为更小的时间分片（子桶）来进一步分散写入压力。
      const bucketKey = buildBucketKey(scope, ip, userId ?? null, pathname)
      const result = await checkAndRecord(ctx.db, {
        bucketKey, windowSeconds, limit,
      })

      if (!result.allowed) {
        const headers = new Headers({
          'content-type': 'application/json',
          'retry-after': String(result.retryAfterSeconds),
          'ratelimit-limit': String(result.limit),
          'ratelimit-remaining': '0',
          'ratelimit-reset': String(result.resetInSeconds),
        })
        return new Response(JSON.stringify({
          error: 'rate_limited',
          message: `Too many requests. Try again in ${result.retryAfterSeconds} seconds.`,
          retryAfter: result.retryAfterSeconds,
        }), { status: 429, headers })
      }

      // Don't block; let downstream handler continue
      return null
    })

    // ─── Admin: rule CRUD ──────────────────────────────────────────────────
    await api.cms.publicRoutes.register('/api/admin/rate-limit', { exclusive: true })
    await api.cms.routes.register('GET', '/api/admin/rate-limit/rules', 'users.manage', async (ctx) => {
      const { rows } = await ctx.db`select * from rate_limit_rules order by path_prefix`
      return Response.json({ rules: rows })
    })
    await api.cms.routes.register('POST', '/api/admin/rate-limit/rules', 'users.manage', async (ctx, req) => {
      const body = await req.json() as Record<string, unknown>
      const { upsertRule } = await import('./store')
      const rule = await upsertRule(ctx.db, {
        id: `rule_${Math.random().toString(36).slice(2, 10)}`,
        pathPrefix: String(body.pathPrefix ?? ''),
        method: String(body.method ?? 'ALL'),
        requests: Number(body.requests ?? 60),
        windowSeconds: Number(body.windowSeconds ?? 60),
        scope: (body.scope as 'ip' | 'user' | 'ip+path' | 'user+path') ?? 'ip',
        description: String(body.description ?? ''),
        enabled: body.enabled !== false,
      })
      return Response.json({ rule })
    })
    await api.cms.routes.register('DELETE', '/api/admin/rate-limit/rules/:id', 'users.manage', async (ctx, _req, params) => {
      await ctx.db`delete from rate_limit_rules where id = ${params.id}`
      return Response.json({ deleted: true })
    })

    api.log.info('rate-limit plugin activated')
}

export async function deactivate(api: any) {
api.log.info('rate-limit plugin deactivated')
}

function extractIp(req: Request, trustProxy: boolean): string | null {
  if (trustProxy) {
    const xff = req.headers.get('x-forwarded-for')
    if (xff) return xff.split(',')[0].trim()
  }
  // The host stamps `clientIp` via stampSocketIp; we look it up from
  // a custom header set by the host's request pipeline.
  const stamped = req.headers.get('x-instatic-client-ip')
  if (stamped) return stamped
  return null
}

/**
 * 分片清理函数：删除已过期的计数器分片，释放存储空间。
 *
 * 分片策略说明：
 *   rate_limit_counters 表中每个 bucketKey 对应一行计数记录。
 *   高流量场景下，同一 IP 可能在不同时间窗口产生多个分片行。
 *   此函数定期清理已超过窗口期的旧分片，避免表无限膨胀。
 *
 * 建议通过宿主的定时任务机制（如 setInterval 或 cron）每隔
 * windowSeconds * 2 的间隔调用一次，以平衡清理频率与性能开销。
 *
 * @param db        数据库客户端
 * @param maxAgeMs  最大保留时长（毫秒），超过此时间的分片将被删除
 * @returns         被清理的分片行数
 */
export async function cleanupExpiredShards(db: { [key: string]: unknown }, maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
  const result = await (db as any)`
    delete from rate_limit_counters
    where updated_at < ${cutoff}
    returning id
  `
  return (result.rows as unknown[])?.length ?? 0
}