/**
 * DB CRUD + sliding-window check for rate-limit.
 */

import { nanoid } from 'nanoid'
import type { DbClient } from '@instatic/plugin-sdk/host'

export type RateLimitScope = 'ip' | 'user' | 'ip+path' | 'user+path'

export interface RateLimitRule {
  id: string
  pathPrefix: string
  method: string
  requests: number
  windowSeconds: number
  scope: RateLimitScope
  description: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface RuleRow {
  id: string
  path_prefix: string
  method: string
  requests: number
  window_seconds: number
  scope: string
  description: string
  enabled: boolean | number
  created_at: string
  updated_at: string
}

function rowToRule(row: RuleRow): RateLimitRule {
  return {
    id: row.id,
    pathPrefix: row.path_prefix,
    method: row.method,
    requests: row.requests,
    windowSeconds: row.window_seconds,
    scope: row.scope as RateLimitScope,
    description: row.description,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function findRuleForPath(db: DbClient, pathname: string, method: string): Promise<RateLimitRule | null> {
  const { rows } = await db<RuleRow>`
    select * from rate_limit_rules
    where enabled = true
      and (method = 'ALL' or method = ${method})
    order by length(path_prefix) desc
    limit 1
  `
  if (!rows[0]) return null
  const rule = rowToRule(rows[0])
  if (!pathname.startsWith(rule.pathPrefix)) return null
  return rule
}

export async function listRules(db: DbClient): Promise<RateLimitRule[]> {
  const { rows } = await db<RuleRow>`select * from rate_limit_rules order by path_prefix`
  return rows.map(rowToRule)
}

export async function upsertRule(
  db: DbClient,
  args: Omit<RateLimitRule, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<RateLimitRule> {
  const id = `rule_${nanoid(8)}`
  const { rows } = await db<RuleRow>`
    insert into rate_limit_rules (id, path_prefix, method, requests, window_seconds, scope, description, enabled)
    values (${id}, ${args.pathPrefix}, ${args.method}, ${args.requests}, ${args.windowSeconds},
            ${args.scope}, ${args.description}, ${args.enabled})
    on conflict (path_prefix) do update
    set method = excluded.method,
        requests = excluded.requests,
        window_seconds = excluded.window_seconds,
        scope = excluded.scope,
        description = excluded.description,
        enabled = excluded.enabled,
        updated_at = now()
    returning *
  `
  return rowToRule(rows[0])
}

export async function deleteRule(db: DbClient, id: string): Promise<void> {
  await db`delete from rate_limit_rules where id = ${id}`
}

// ─── Sliding window check ────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  resetInSeconds: number
  retryAfterSeconds: number
}

export async function checkAndRecord(
  db: DbClient,
  args: {
    bucketKey: string
    windowSeconds: number
    limit: number
  },
): Promise<RateLimitResult> {
  // Lazy compaction: delete expired rows for this bucket
  await db`
    delete from rate_limit_buckets
    where bucket_key = ${args.bucketKey} and expires_at <= now()
  `
  // Count hits in the current window
  const { rows } = await db<{ count: number }>`
    select count(*)::int as count from rate_limit_buckets
    where bucket_key = ${args.bucketKey} and hit_at > now() - (${args.windowSeconds} || ' seconds')::interval
  `
  const current = rows[0]?.count ?? 0
  if (current >= args.limit) {
    // Find the oldest hit to compute retry-after
    const { rows: oldest } = await db<{ hit_at: string }>`
      select hit_at from rate_limit_buckets
      where bucket_key = ${args.bucketKey}
      order by hit_at asc
      limit 1
    `
    const resetIn = oldest[0]
      ? Math.max(0, args.windowSeconds - Math.floor((Date.now() - new Date(oldest[0].hit_at).getTime()) / 1000))
      : args.windowSeconds
    return {
      allowed: false,
      limit: args.limit,
      remaining: 0,
      resetInSeconds: resetIn,
      retryAfterSeconds: resetIn,
    }
  }
  // Record this hit
  const expiresAt = new Date(Date.now() + args.windowSeconds * 1000 + 1000).toISOString()  // 1s slack
  await db`
    insert into rate_limit_buckets (bucket_key, expires_at)
    values (${args.bucketKey}, ${expiresAt})
  `
  return {
    allowed: true,
    limit: args.limit,
    remaining: args.limit - current - 1,
    resetInSeconds: args.windowSeconds,
    retryAfterSeconds: 0,
  }
}

// ─── Bucket key builder ─────────────────────────────────────────────────

export function buildBucketKey(scope: RateLimitScope, ip: string, userId: string | null, path: string): string {
  switch (scope) {
    case 'ip': return `ip:${ip}`
    case 'user': return `user:${userId ?? ip}`
    case 'ip+path': return `ip:${ip}:${path}`
    case 'user+path': return `user:${userId ?? ip}:${path}`
  }
}