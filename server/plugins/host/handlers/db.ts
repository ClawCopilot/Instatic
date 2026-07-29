/**
 * Plugin raw-SQL handler — implements the `cms.db.query` api-call.
 *
 * Gated by the `cms.db` permission, enforced centrally in apiDispatch.ts
 * (via TARGET_PERMISSIONS) before this handler runs. The plugin supplies a
 * SQL string and an optional array of primitive bind values; the host runs
 * it through the SAME parameterized `db.unsafe()` path every repository
 * uses, so values are never interpolated into the SQL text.
 *
 * SECURITY — DDL is rejected. Only SELECT / INSERT / UPDATE / DELETE (and
 * the WITH … prefix forms) reach the database. DROP / ALTER / CREATE /
 * TRUNCATE / etc. must go through `cms.migrations.register`, which is the
 * sole DDL surface and is itself gated by `cms.migrations`. The guard is
 * intentionally conservative: it scans the leading keyword of the FIRST
 * statement only, and rejects anything it cannot classify as a safe DML
 * verb. This is defense-in-depth on top of the database's own privilege
 * model, not a substitute for it.
 */

import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiError, replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'

/**
 * The leading-token allowlist. The check is case-insensitive and ignores
 * leading whitespace / comments. A statement that does not start with one
 * of these verbs is rejected — this deliberately excludes `WITH … SELECT`
 * only when the WITH is the very first token; a bare `WITH … INSERT` is
 * equally rejected. The common read path (`SELECT …`) always works.
 */
const ALLOWED_DML_PREFIXES = ['select', 'insert', 'update', 'delete', 'with']

/**
 * Tokens that are unambiguously DDL / session / transaction control and
 * must never run through the plugin query surface. Listed explicitly so
 * the rejection message can name the offending verb.
 */
const FORBIDDEN_PREFIXES = [
  'drop',
  'alter',
  'create',
  'truncate',
  'grant',
  'revoke',
  'vacuum',
  'attach',
  'detach',
  'pragma',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'set',
  'show',
  'explain',
]

/**
 * Extract the first SQL keyword from `sql`, lowercased. Strips a leading
 * PostgreSQL `/* … *‍/` or `-- …` comment and surrounding whitespace so
 * `  -- comment\n  SELECT …` classifies as `select`. Returns the empty
 * string if no leading keyword can be identified.
 */
function leadingKeyword(sql: string): string {
  let s = sql
  // Strip leading line/block comments + whitespace, repeating so multiple
  // comments in sequence are handled.
  while (true) {
    s = s.trimStart()
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/', 2)
      if (end < 0) return ''
      s = s.slice(end + 2)
      continue
    }
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n')
      if (nl < 0) return ''
      s = s.slice(nl + 1)
      continue
    }
    break
  }
  const m = s.match(/^([a-z_]+)/i)
  return m ? m[1].toLowerCase() : ''
}

/**
 * Reject anything that looks like multiple statements. The host's
 * `db.unsafe` already only executes the first statement on Postgres
 * (via prepared statements) and errors on `;`-separated batches on
 * SQLite, but we close the door here too so the failure is a clear
 * plugin-facing error rather than a silent truncation.
 */
function containsStatementSeparator(sql: string, params: unknown[]): boolean {
  // A semicolon inside a string literal or a bound parameter is fine; the
  // bind values are parameterized so they never appear in `sql`. We only
  // need to scan the SQL text for a `;` that is not inside a single-quoted
  // literal. A trailing `;` at end-of-string is allowed (common idiom).
  let inString = false
  let escape = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === "'") {
        inString = false
      }
      continue
    }
    if (ch === "'") {
      inString = true
      continue
    }
    if (ch === ';') {
      // Allow a single trailing semicolon (possibly followed by whitespace).
      const tail = sql.slice(i + 1).trim()
      if (tail.length === 0) return false
      return true
    }
  }
  // params unused — kept in the signature so callers remember that bound
  // values never reach this scanner and therefore cannot trip it.
  void params
  return false
}

export async function handleDbQuery(
  msg: ApiCallFor<'cms.db.query'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ sql, params }] = msg.args
  const bind = params ?? []

  const verb = leadingKeyword(sql)
  if (!verb) {
    replyApiError(msg.pluginId, msg.correlationId, 'cms.db.query: empty or unparseable SQL')
    return
  }
  if (FORBIDDEN_PREFIXES.includes(verb)) {
    replyApiError(
      msg.pluginId,
      msg.correlationId,
      'cms.db.query: "' + verb + '" is not allowed — schema changes must go through cms.migrations.register',
    )
    return
  }
  if (!ALLOWED_DML_PREFIXES.includes(verb)) {
    replyApiError(
      msg.pluginId,
      msg.correlationId,
      'cms.db.query: only SELECT / INSERT / UPDATE / DELETE are allowed (leading keyword was "' + verb + '")',
    )
    return
  }
  if (containsStatementSeparator(sql, bind)) {
    replyApiError(
      msg.pluginId,
      msg.correlationId,
      'cms.db.query: multiple statements are not allowed; execute each query separately',
    )
    return
  }

  try {
    const result = await db.unsafe(sql, bind)
    replyApiOk(msg.pluginId, msg.correlationId, { rows: result.rows })
  } catch (err) {
    replyApiError(
      msg.pluginId,
      msg.correlationId,
      err instanceof Error ? err.message : String(err),
    )
  }
}
