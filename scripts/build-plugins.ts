#!/usr/bin/env bun
/**
 * Build all 8 plugins as standalone .js bundles.
 *
 * Output: plugins/<name>/dist/index.js
 * Usage: bun run scripts/build-plugins.ts
 *
 * The plugins are SELF-CONTAINED: the SDK is inlined via esbuild's default
 * module resolution. Plugins can be uploaded to the host as `.tgz` packages
 * or run directly via `bun run plugins/<name>/dist/index.js`.
 */

import { Glob as _Glob } from 'bun'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const PLUGINS_DIR = join(ROOT, 'plugins')

const plugins = [
  'api-keys',
  'public-auth',
  'membership',
  'commerce',
  'oidc-provider',
  'notifications',
  'social-login',
  'rate-limit',
]

let failed = 0

for (const name of plugins) {
  const entry = join(PLUGINS_DIR, name, 'src/index.ts')
  const outdir = join(PLUGINS_DIR, name, 'dist')
  process.stdout.write(`  ${name.padEnd(20)} `)
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      target: 'bun',
      outdir,
      // Inline the SDK so the plugin is fully self-contained. A plugin's
      // .tgz can then be uploaded to a fresh host install with no
      // need to install @instatic/plugin-sdk separately.
      // (Forks with multiple SDK versions can override via plugin-level bundler config.)
      format: 'esm',
      minify: false,
      sourcemap: 'linked',
    })
    if (result.success) {
      const totalSize = result.outputs.reduce((s, o) => s + o.size, 0)
      process.stdout.write(`OK  ${(totalSize / 1024).toFixed(1)} KB\n`)
    } else {
      process.stdout.write(`FAIL\n`)
      for (const log of result.logs) {
        console.error(`    ${log.message}`)
      }
      failed++
    }
  } catch (err) {
    process.stdout.write(`FAIL  ${err instanceof Error ? err.message : err}\n`)
    failed++
  }
}

if (failed > 0) {
  console.error(`\n${failed} plugin(s) failed to build`)
  process.exit(1)
}
console.log(`\nAll ${plugins.length} plugins built successfully`)
