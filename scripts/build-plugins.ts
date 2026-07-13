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

import { Glob } from 'bun'
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
      // Externalize the SDK so each plugin can declare its own pinned version
      // of @instatic/plugin-sdk if needed (forks with different SDK versions).
      external: ['@instatic/*'],
      format: 'esm',
      target: 'bun',
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
