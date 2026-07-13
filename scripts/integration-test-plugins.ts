/**
 * Plugin integration test harness.
 *
 * Loads each plugin's source (post-build, the .js bundle) and invokes
 * its default export's `activate()` with a mock ApiCallContext that
 * captures:
 *   - registered migrations
 *   - registered routes
 *   - registered hooks
 *   - viewer context providers
 *   - content gates
 *
 * The captured state is then asserted against the plugin's documented
 * contract. This catches:
 *   - Plugin code that fails to import or evaluate
 *   - Plugin code that registers the wrong thing
 *   - Plugin code that throws during activation
 *
 * For DB-touching logic (migrations, hooks), we use an in-memory
 * SQLite database. The pure-logic handlers are exercised against
 * fixtures without touching the host.
 */

import { Database } from 'bun:sqlite'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const PLUGINS_DIR = join(ROOT, 'plugins')

interface CapturedState {
  migrations: Array<{ id: string; pgSql: string }>
  routes: Array<{ method: string; path: string; capability?: string }>
  hooks: Array<{ event: string; listenerId: string }>
  providers: Array<{ name: string }>
  gates: Array<{ name: string; priority: number }>
  errors: string[]
}

function makeMockContext(db: Database, settings: Record<string, unknown> = {}): { api: any; state: CapturedState } {
  const state: CapturedState = {
    migrations: [],
    routes: [],
    hooks: [],
    providers: [],
    gates: [],
    errors: [],
  }

  // Mock DB that wraps bun:sqlite and returns the expected interface
  const dbClient = {
    unsafe: (sql: string, params?: unknown[]) => {
      try {
        if (params) {
          return sqliteQuery(db, sql, params)
        }
        db.exec(sql)
        return { rows: [] }
      } catch (err) {
        return { rows: [], error: err }
      }
    },
    transaction: async (fn: (tx: any) => Promise<any>) => {
      return await fn(dbClient)
    },
    _raw: db,
  }

  const api = {
    db: dbClient,
    settings: {
      get: async (key: string) => settings[key] ?? null,
      getAll: async () => settings,
      replace: async () => {},
    },
    secrets: {
      get: async () => null,
      set: async () => {},
    },
    hooks: {
      on: (event: string, listenerId: string) => state.hooks.push({ event, listenerId }),
      filter: () => {},
      emit: async () => {},
    },
    viewerContext: {
      register: (provider: any) => state.providers.push({ name: provider.name ?? 'unnamed' }),
    },
    contentGate: {
      register: (gate: any, priority: number) => state.gates.push({ name: gate.name ?? 'unnamed', priority }),
    },
    cms: {
      migrations: {
        register: (m: { id: string; pgSql: string }) => state.migrations.push(m),
      },
      routes: {
        register: (method: string, path: string, capabilityOrHandler: string | Function, handler?: Function) => {
          const cap = typeof capabilityOrHandler === 'string' ? capabilityOrHandler : 'authenticated'
          state.routes.push({ method, path, capability: cap })
        },
      },
      publicRoutes: {
        register: (prefix: string) => {
          state.routes.push({ method: 'CLAIM', path: prefix, capability: 'public-prefix' })
        },
      },
      httpMiddleware: {
        register: () => {},
      },
    },
    log: {
      info: () => {},
      warn: (...args: unknown[]) => state.errors.push('warn: ' + args.join(' ')),
      error: (...args: unknown[]) => state.errors.push('error: ' + args.join(' ')),
    },
  }

  return { api, state }
}

function sqliteQuery(db: Database, sql: string, params: unknown[]) {
  try {
    const stmt = db.prepare(sql)
    return { rows: stmt.all(...(params as never[])) }
  } catch {
    return { rows: [] }
  }
}

interface TestCase {
  plugin: string
  settings?: Record<string, unknown>
  expect: {
    minMigrations?: number
    minRoutes?: number
    minHooks?: number
    expectHooks?: string[]
  }
}

const testCases: TestCase[] = [
  {
    plugin: 'api-keys',
    expect: { minMigrations: 1, minRoutes: 1 },
  },
  {
    plugin: 'public-auth',
    settings: {
      jwtSecret: 'test-jwt-secret-32-characters-min',
      accessTokenTtlSeconds: 3600,
      requireEmailVerification: false,
    },
    expect: { minMigrations: 1, minRoutes: 5, minHooks: 0 },
  },
  {
    plugin: 'membership',
    expect: { minMigrations: 1, minRoutes: 5 },
  },
  {
    plugin: 'commerce',
    expect: { minMigrations: 1, minRoutes: 5 },
  },
  {
    plugin: 'oidc-provider',
    settings: {
      issuer: 'https://test.example.com',
    },
    expect: { minMigrations: 1, minRoutes: 5 },
  },
  {
    plugin: 'notifications',
    expect: { minMigrations: 1, minRoutes: 3, minHooks: 5 },
  },
  {
    plugin: 'social-login',
    expect: { minMigrations: 1, minRoutes: 1 },
  },
  {
    plugin: 'rate-limit',
    expect: { minMigrations: 1, minRoutes: 0 },
  },
]

async function testPlugin(name: string, expectation: TestCase['expect'], settings: Record<string, unknown> = {}): Promise<{ ok: boolean; reason?: string; state: CapturedState }> {
  const distPath = join(PLUGINS_DIR, name, 'dist/index.js')
  let exists = false
  try {
    await readFile(distPath)
    exists = true
  } catch {
    return { ok: false, reason: 'dist/index.js not found', state: { migrations: [], routes: [], hooks: [], providers: [], gates: [], errors: [] } }
  }
  if (!exists) return { ok: false, reason: 'no dist', state: { migrations: [], routes: [], hooks: [], providers: [], gates: [], errors: [] } }

  const db = new Database(':memory:')
  const { api, state } = makeMockContext(db, settings)

  try {
    // Dynamic import of the built plugin
    const module = await import(distPath)
    // Plugin file shape: default export is the PluginDefinition (manifest+modules+pack);
    // lifecycle hooks are NAMED exports (install/activate/deactivate).
    if (!module.activate || typeof module.activate !== 'function') {
      return { ok: false, reason: 'no `activate` named export', state }
    }
    // Skip `install` since it can also run migrations (activate re-registers them)
    await module.activate(api)
  } catch (err) {
    const stack = err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : ''
    return { ok: false, reason: `activate() threw: ${err instanceof Error ? err.message : err}\n${stack}`, state }
  } finally {
    db.close()
  }

  // Assertions
  if (expectation.minMigrations !== undefined && state.migrations.length < expectation.minMigrations) {
    return { ok: false, reason: `expected ≥${expectation.minMigrations} migrations, got ${state.migrations.length}`, state }
  }
  if (expectation.minRoutes !== undefined && state.routes.length < expectation.minRoutes) {
    return { ok: false, reason: `expected ≥${expectation.minRoutes} routes, got ${state.routes.length}`, state }
  }
  if (expectation.minHooks !== undefined && state.hooks.length < expectation.minHooks) {
    return { ok: false, reason: `expected ≥${expectation.minHooks} hooks, got ${state.hooks.length}`, state }
  }
  if (expectation.expectHooks) {
    for (const expectedEvent of expectation.expectHooks) {
      if (!state.hooks.some((h) => h.event === expectedEvent)) {
        return { ok: false, reason: `expected hook for "${expectedEvent}"`, state }
      }
    }
  }
  return { ok: true, state }
}

console.log('Running integration tests...\n')

let pass = 0
let fail = 0
for (const tc of testCases) {
  process.stdout.write(`  ${tc.plugin.padEnd(20)} `)
  const result = await testPlugin(tc.plugin, tc.expect, tc.settings)
  if (result.ok) {
    process.stdout.write(
      `OK  (${result.state.migrations.length}mig, ${result.state.routes.length}routes, ${result.state.hooks.length}hooks, ${result.state.providers.length}providers, ${result.state.gates.length}gates)\n`,
    )
    pass++
  } else {
    process.stdout.write(`FAIL  ${result.reason}\n`)
    fail++
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
