#!/usr/bin/env bun
/**
 * Build all built-in plugins and skills as standalone .js bundles.
 *
 * Output:
 *   - plugins/<name>/dist/index.js   (main plugins)
 *   - plugins/skills/<name>/dist/index.js  (skills)
 *
 * Usage: bun run scripts/build-plugins.ts
 *
 * The plugins are SELF-CONTAINED: the SDK is inlined via esbuild's default
 * module resolution. Plugins can be uploaded to the host as `.tgz` packages
 * or run directly via `bun run plugins/<name>/dist/index.js`.
 */

import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const PLUGINS_DIR = join(ROOT, 'plugins')

const mainPlugins = [
  'api-keys',
  'public-auth',
  'membership',
  'commerce',
  'oidc-provider',
  'notifications',
  'social-login',
  'rate-limit',
]

const skills = [
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
]

type BuildEntry = { name: string; entry: string; outdir: string; kind: string }

const entries: BuildEntry[] = [
  ...mainPlugins.map((name) => ({
    name,
    entry: join(PLUGINS_DIR, name, 'src/index.ts'),
    outdir: join(PLUGINS_DIR, name, 'dist'),
    kind: 'plugin',
  })),
  ...skills.map((name) => ({
    name,
    entry: join(PLUGINS_DIR, 'skills', name, 'src/index.ts'),
    outdir: join(PLUGINS_DIR, 'skills', name, 'dist'),
    kind: 'skill',
  })),
]

let failed = 0

for (const { name, entry, outdir, kind } of entries) {
  process.stdout.write(`  [${kind}] ${name.padEnd(20)} `)
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
  console.error(`\n${failed} bundle(s) failed to build`)
  process.exit(1)
}
console.log(`\nAll ${entries.length} bundles built successfully (${mainPlugins.length} plugins + ${skills.length} skills)`)
