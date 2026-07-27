/**
 * Verification script — activates all 8 main plugins inside a real QuickJS VM.
 *
 * This is NOT a unit test (it imports the VM + reads built bundles from disk,
 * which is too heavy for the unit test suite). Run it directly:
 *   bun run scripts/verify-plugin-activation.ts
 *
 * It exercises the full load path:
 *   1. Read the built ESM bundle from plugins/<name>/dist/index.js
 *   2. Run wrapEsmAsGlobal (the import + export rewriting shim)
 *   3. createPluginVm with a stub env (hostCall returns empty results)
 *   4. runLifecycle('activate')
 *
 * Success = activate completes without throwing.
 * Failure = the VM throws (SyntaxError, unsupported crypto op, etc.)
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginVm, type PluginVm } from '../server/plugins/quickjs/vm'
import { wrapEsmAsGlobal } from '../server/plugins/quickjs/esmShim'

const PLUGIN_NAMES = [
  'api-keys',
  'commerce',
  'membership',
  'notifications',
  'oidc-provider',
  'public-auth',
  'rate-limit',
  'social-login',
] as const

const ROOT = join(import.meta.dir, '..')

async function verifyPlugin(name: string): Promise<{ name: string; ok: boolean; error?: string; hooks?: string[] }> {
  const distPath = join(ROOT, 'plugins', name, 'dist', 'index.js')
  let rawSource: string
  try {
    rawSource = await readFile(distPath, 'utf-8')
  } catch (err) {
    return { name, ok: false, error: `Failed to read ${distPath}: ${(err as Error).message}` }
  }

  const pluginSource = wrapEsmAsGlobal(rawSource, '__plugin_exports')

  let vm: PluginVm | null = null
  try {
    vm = await createPluginVm({
      pluginSource,
      env: {
        pluginId: name,
        manifestVersion: '1.0.0',
        grantedPermissions: [
          'cms.routes',
          'cms.routes.public',
          'cms.migrations',
          'cms.publicRoutes',
          'cms.hooks',
          'cms.storage',
          'cms.settings',
          'cms.schedule',
          'cms.content.read',
          'cms.content.write',
          'cms.content.delete',
          'cms.content.publish',
          'cms.content.tables.manage',
          'cms.httpMiddleware',
        ],
        assetBasePath: `/uploads/plugins/${name}/1.0.0`,
        settings: {
          issuer: 'http://localhost:3000',
          accessTokenTtlSeconds: 3600,
          refreshTokenTtlSeconds: 2592000,
          idTokenTtlSeconds: 3600,
          authCodeTtlSeconds: 600,
          requirePkce: false,
        },
        // Stub hostCall — returns empty/null for everything. Activation
        // registers routes/migrations/hooks (which call hostCall) but the
        // return values are not critical for activation to succeed.
        hostCall: async (target: string, _args: unknown[]) => {
          if (target === 'cms.migrations.register') return { ok: true }
          if (target === 'cms.routes.register') return { ok: true }
          if (target === 'cms.publicRoutes.register') return { ok: true }
          if (target === 'cms.hooks.on') return { ok: true }
          if (target === 'cms.settings.replace') return { ok: true }
          if (target === 'cms.storage.list') return { items: [], totalItems: 0 }
          if (target === 'cms.storage.create') return { id: 'stub-id' }
          if (target === 'cms.storage.get') return null
          if (target === 'cms.schedule.register') return { ok: true }
          return undefined
        },
        log: (args: unknown[]) => {
          console.log(`  [${name}]`, ...args)
        },
      },
    })

    await vm.runLifecycle('activate')
    return { name, ok: true, hooks: [...vm.exportedHooks] }
  } catch (err) {
    return { name, ok: false, error: (err as Error).message }
  } finally {
    if (vm) vm.dispose()
  }
}

console.log('Verifying all 8 main plugins activate in the QuickJS sandbox...\n')

let passCount = 0
let failCount = 0
for (const name of PLUGIN_NAMES) {
  process.stdout.write(`  ${name.padEnd(20)} `)
  const result = await verifyPlugin(name)
  if (result.ok) {
    console.log(`PASS  (hooks: ${result.hooks?.join(', ') || 'none'})`)
    passCount++
  } else {
    console.log(`FAIL`)
    console.log(`         ${result.error}`)
    failCount++
  }
}

console.log(`\n${passCount}/${passCount + failCount} plugins activated successfully.`)
if (failCount > 0) {
  process.exit(1)
}
