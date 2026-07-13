/**
 * TypeScript strict check for all 8 plugin packages.
 *
 * Runs `tsc --noEmit` against each plugin's source with the project
 * reference mode that includes the SDK package. Reports all errors
 * with file:line:context so they can be fixed iteratively.
 */

import { spawn } from 'bun'
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

let totalErrors = 0
const allErrors: Array<{ plugin: string; file: string; line: number; message: string }> = []

for (const name of plugins) {
  const srcDir = join(PLUGINS_DIR, name, 'src')
  const tsconfigPath = join(PLUGINS_DIR, name, 'tsconfig.json')

  process.stdout.write(`  ${name.padEnd(20)} `)

  // Write a per-plugin tsconfig that includes SDK + the plugin source
  const tsconfig = {
    extends: '../../packages/plugin-sdk/tsconfig.base.json',
    compilerOptions: {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      target: 'esnext',
      lib: ['esnext', 'dom'],
      types: ['bun'],
      paths: {
        '@instatic/plugin-sdk': ['../../packages/plugin-sdk/index.ts'],
        '@instatic/plugin-sdk/*': ['../../packages/plugin-sdk/src/*'],
      },
    },
    include: [join(srcDir, '**/*.ts')],
  }
  await Bun.write(tsconfigPath, JSON.stringify(tsconfig, null, 2))

  // Run tsc and capture output
  const proc = spawn({
    cmd: ['npx', 'tsc', '-p', tsconfigPath, '--noEmit'],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const output: string[] = []
  for await (const chunk of proc.stdout) output.push(new TextDecoder().decode(chunk))
  for await (const chunk of proc.stderr) output.push(new TextDecoder().decode(chunk))
  const text = output.join('')
  const exitCode = await proc.exited

  if (exitCode === 0) {
    process.stdout.write(`OK\n`)
  } else {
    process.stdout.write(`${(text.match(/error TS/g) ?? []).length} errors\n`)
    // Parse and collect errors
    for (const line of text.split('\n')) {
      const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/)
      if (m) {
        allErrors.push({
          plugin: name,
          file: m[1].replace(ROOT + '/', '').replace(/\\/g, '/'),
          line: parseInt(m[2]),
          message: `${m[4]}: ${m[5]}`,
        })
      }
    }
    totalErrors += (text.match(/error TS/g) ?? []).length
  }
}

console.log(`\n${totalErrors} total type error(s) across ${plugins.length} plugins`)
if (allErrors.length > 0) {
  console.log('\nFirst 20 errors:')
  for (const e of allErrors.slice(0, 20)) {
    console.log(`  ${e.plugin}/${e.file}:${e.line}  ${e.message}`)
  }
}

process.exit(totalErrors > 0 ? 1 : 0)
