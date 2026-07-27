/**
 * Smoke-test that every built-in main plugin's compiled `dist/index.js`
 * loads cleanly inside the QuickJS sandbox.
 *
 * The dist bundles are produced by `bun build` and contain bare ESM
 * `import { ... } from "crypto"` / `from "net"` statements. The
 * `wrapEsmAsGlobal` shim in `server/plugins/quickjs/esmShim.ts` rewrites
 * those into `const { ... } = globalThis.__module_crypto` references that
 * the bootstrap provides. If the rewrite is incomplete or a plugin pulls
 * in a module the bootstrap doesn't shim, QuickJS throws a SyntaxError at
 * eval time — which this test surfaces as a failure.
 *
 * Built-in plugins are loaded directly from disk (not via the zip install
 * path), so the textual `assertSandboxSafe` scan is NOT applied to them —
 * the scan would false-positive on data structures like
 * `NODE_BUILTIN_PACKAGES` that contain module names as string literals.
 * The QuickJS eval itself is the authoritative gate: if a forbidden API is
 * actually *invoked*, the VM throws.
 *
 * This is a STRUCTURAL gate: it does not exercise plugin behavior, only
 * that the bundle is sandbox-loadable. Behavioral tests live alongside
 * each plugin under `plugins/<name>/tests/`.
 */
import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginVm, type PluginVmEnv } from '../../../server/plugins/quickjs/vm'
import { wrapEsmAsGlobal } from '../../../server/plugins/quickjs/esmShim'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const MAIN_PLUGINS = [
  'api-keys',
  'commerce',
  'membership',
  'notifications',
  'oidc-provider',
  'public-auth',
  'rate-limit',
  'social-login',
] as const

const SKILLS = [
  'agent-bridge',
  'code-helper',
  'comment-system',
  'content-assistant',
  'design-advisor',
  'graphic-designer',
  'huggingface',
  'humanizer',
  'image-generator',
  'layout-builder',
  'site-api',
  'social-media',
  'weather',
  'web-research',
  'youtube-summarizer',
] as const

/**
 * Read a plugin's compiled dist bundle from disk.
 * Returns the raw source (before ESM shim rewriting).
 */
async function readPluginDist(pluginDir: string, isSkill: boolean): Promise<string> {
  const subPath = isSkill ? join('skills', pluginDir) : pluginDir
  return await readFile(join(ROOT, 'plugins', subPath, 'dist', 'index.js'), 'utf-8')
}

/**
 * Read a plugin's manifest from its package.json.
 */
async function readPluginManifest(pluginDir: string, isSkill: boolean): Promise<{ id: string; permissions: string[]; version: string }> {
  const subPath = isSkill ? join('skills', pluginDir) : pluginDir
  const pkg = JSON.parse(await readFile(join(ROOT, 'plugins', subPath, 'package.json'), 'utf-8'))
  const m = pkg.instaticManifest
  return {
    id: m.id,
    permissions: m.grantedPermissions ?? m.permissions ?? [],
    version: m.version,
  }
}

/**
 * Build a permissive env that grants all declared permissions and
 * swallows host calls (we only test loading, not behavior).
 */
function makePermissiveEnv(pluginId: string, permissions: string[]): PluginVmEnv {
  return {
    pluginId,
    manifestVersion: '1.0.0',
    grantedPermissions: permissions,
    assetBasePath: `/builtin/${pluginId}/0.1.0`,
    settings: {},
    hostCall: async () => null,
    log: () => { /* swallow */ },
  }
}

describe('built-in main plugins: QuickJS sandbox loadability', () => {
  for (const pluginDir of MAIN_PLUGINS) {
    it(`${pluginDir}/dist/index.js loads in QuickJS sandbox after ESM rewrite`, async () => {
      const rawSource = await readPluginDist(pluginDir, false)
      const manifest = await readPluginManifest(pluginDir, false)

      // 1. The ESM shim rewrites `import { ... } from "crypto"` etc. into
      //    `const { ... } = globalThis.__module_crypto`. If the source
      //    still contains a bare `import` after rewriting, QuickJS would
      //    throw a SyntaxError — the createPluginVm call below exercises
      //    that path.
      const pluginSource = wrapEsmAsGlobal(rawSource, '__plugin_exports')

      // Sanity: the wrapper must have produced an IIFE that assigns
      // globalThis.__plugin_exports.
      expect(pluginSource).toContain('globalThis.__plugin_exports')

      // 2. Actually create a QuickJS VM and evaluate the rewritten bundle.
      //    A SyntaxError or runtime error during eval propagates as a
      //    thrown exception, failing the test. This is the authoritative
      //    gate — if a forbidden API is actually invoked at load time,
      //    the VM throws.
      const env = makePermissiveEnv(manifest.id, manifest.permissions)
      const vm = await createPluginVm({ pluginSource, env })

      try {
        // The plugin must have at least one lifecycle hook exported
        // (activate is the minimum). Plugins without hooks are inert.
        // This proves the bundle evaluated successfully and the IIFE
        // attached its exports to globalThis.__plugin_exports.
        expect(vm.exportedHooks.length).toBeGreaterThan(0)

        // We do NOT run activate/install here — those hooks call
        // api.routes.register(), api.cms.migrations.register(), etc.,
        // which require a real hostCall implementation. The load-time
        // gate (SyntaxError-free eval + hook discovery) is what this
        // test asserts; behavioral coverage lives in each plugin's
        // own test suite under plugins/<name>/tests/.
      } finally {
        vm.dispose()
      }
    })
  }
})

describe('built-in skills: QuickJS sandbox loadability', () => {
  for (const skillDir of SKILLS) {
    it(`skills/${skillDir}/dist/index.js loads in QuickJS sandbox after ESM rewrite`, async () => {
      const rawSource = await readPluginDist(skillDir, true)
      const manifest = await readPluginManifest(skillDir, true)

      // Skills use the same ESM shim pipeline as main plugins.
      const pluginSource = wrapEsmAsGlobal(rawSource, '__plugin_exports')
      expect(pluginSource).toContain('globalThis.__plugin_exports')

      const env = makePermissiveEnv(manifest.id, manifest.permissions)
      const vm = await createPluginVm({ pluginSource, env })

      try {
        // Skills must export at least one lifecycle hook.
        expect(vm.exportedHooks.length).toBeGreaterThan(0)
      } finally {
        vm.dispose()
      }
    })
  }
})
