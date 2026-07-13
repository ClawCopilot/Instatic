/**
 * Refactor plugin source files to use the proper SDK lifecycle pattern.
 *
 * Transform: `definePlugin({...activate, deactivate})` →
 *           `definePlugin({...})` + `export async function install/activate/deactivate`
 *
 * This is a one-time migration; subsequent plugin authors use the
 * new pattern from the start.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const PLUGINS_DIR = join(ROOT, 'plugins')

const plugins = [
  'public-auth',
  'membership',
  'commerce',
  'oidc-provider',
  'notifications',
  'social-login',
  'rate-limit',
]

/**
 * For each plugin, manually rewrite the index.ts with the correct
 * lifecycle pattern. (We don't try to auto-parse because the activate
 * function bodies are plugin-specific.)
 *
 * Strategy: read the file, identify the definePlugin call boundaries
 * and the activate/deactivate function bodies, then rewrite.
 *
 * Since each plugin has a different activate function, we use a manual
 * approach: load the source, find the "export default definePlugin({...})"
 * block, split it into the define call (no activate) + named exports.
 */

async function refactorPlugin(name: string): Promise<void> {
  const filePath = join(PLUGINS_DIR, name, 'src/index.ts')
  const source = await readFile(filePath, 'utf-8')

  // Find the definePlugin({...}) block
  // Pattern: export default definePlugin({ ... })
  const startMatch = source.match(/export default definePlugin\(\{/)
  if (!startMatch) {
    console.log(`  ${name.padEnd(20)} - no definePlugin found, skipping`)
    return
  }
  const startIdx = startMatch.index!
  // Find matching closing }) — the closing of the definePlugin({...}) call
  // The definePlugin call ends with `})` (no comma) followed by `;` or end.
  // We need to find the closing `})` that balances the opening `({`.
  let depth = 0
  let endIdx = -1
  for (let i = startIdx; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        endIdx = i + 1  // include the }
        break
      }
    }
  }
  if (endIdx === -1) {
    console.log(`  ${name.padEnd(20)} - could not find end of definePlugin`)
    return
  }
  // The definePlugin call is source[startIdx..endIdx+1] including `})` and `;`
  const fullCall = source.slice(startIdx, endIdx + 1)
  // Now extract the body between the outer `({` and the matching `})`
  const openBrace = fullCall.indexOf('{')
  const closeBrace = fullCall.lastIndexOf('}')
  const body = fullCall.slice(openBrace + 1, closeBrace)

  // The body has `id`, `name`, `version`, `permissions`, `migrations`, `async activate(api)`, `async deactivate(api)`
  // Strategy: find the comma BEFORE "async activate", and the comma AFTER "async deactivate"
  // That gives us the manifest portion.

  // Simpler: remove `migrations,` line, the `async activate(api) { ... }` block, and `async deactivate(api) { ... }` block.

  // Find "migrations," - it's the last property before activate
  const migrationsMatch = body.match(/,\s*migrations\s*,/)
  let manifestPart = ''
  if (migrationsMatch) {
    manifestPart = body.slice(0, migrationsMatch.index!)
  } else {
    // No migrations property — find the last property before activate
    const activateMatch = body.match(/,?\s*async\s+activate\(/)
    if (activateMatch) {
      manifestPart = body.slice(0, activateMatch.index!)
    } else {
      manifestPart = body
    }
  }

  // Find the activate function block
  const activateStart = body.indexOf('async activate(api)')
  if (activateStart === -1) {
    console.log(`  ${name.padEnd(20)} - no activate() found`)
    return
  }
  // Find matching closing brace
  let aDepth = 0
  let activateEnd = -1
  for (let i = activateStart; i < body.length; i++) {
    if (body[i] === '{') aDepth++
    else if (body[i] === '}') {
      aDepth--
      if (aDepth === 0) {
        activateEnd = i + 1
        break
      }
    }
  }
  if (activateEnd === -1) {
    console.log(`  ${name.padEnd(20)} - no end of activate`)
    return
  }
  const activateBody = body.slice(activateStart, activateEnd)

  // Find the deactivate function block
  let deactivateStart = -1
  const deactivateSearch = body.indexOf('async deactivate(api)', activateEnd)
  if (deactivateSearch !== -1) {
    let dDepth = 0
    let deactivateEnd = -1
    for (let i = deactivateSearch; i < body.length; i++) {
      if (body[i] === '{') dDepth++
      else if (body[i] === '}') {
        dDepth--
        if (dDepth === 0) {
          deactivateEnd = i + 1
          break
        }
      }
    }
    if (deactivateEnd !== -1) {
      // No-op, the find below gets the body
    }
  }

  // Extract just the function signature line + body for activate
  const activateFnMatch = body.slice(activateStart).match(/^async\s+activate\(api\)\s*\{/)
  if (!activateFnMatch) {
    console.log(`  ${name.padEnd(20)} - activate signature not found`)
    return
  }
  const activateHeader = activateFnMatch[0].replace(/\s*\{$/, '')
  // Find body between first { and matching }
  const openIdx = body.indexOf('{', activateStart)
  let d2 = 0
  let closeIdx = -1
  for (let i = openIdx; i < body.length; i++) {
    if (body[i] === '{') d2++
    else if (body[i] === '}') {
      d2--
      if (d2 === 0) {
        closeIdx = i
        break
      }
    }
  }
  const activateImpl = body.slice(openIdx + 1, closeIdx).trim()

  let deactivateImpl = ''
  if (deactivateSearch !== -1) {
    const dOpen = body.indexOf('{', deactivateSearch)
    let dd = 0
    let dClose = -1
    for (let i = dOpen; i < body.length; i++) {
      if (body[i] === '{') dd++
      else if (body[i] === '}') {
        dd--
        if (dd === 0) {
          dClose = i
          break
        }
      }
    }
    if (dClose !== -1) {
      deactivateImpl = body.slice(dOpen + 1, dClose).trim()
    }
  }

  // Now build the new source:
  // [prefix]export default definePlugin({manifestPart})
  // export async function install(api: any) {
  //   if (migrations present) {
  //     for (const m of migrations) await api.cms.migrations.register(m)
  //   }
  // }
  // export async function activate(api: any) {
  //   activateImpl
  // }
  // export async function deactivate(api: any) {
  //   deactivateImpl
  // }
  // [suffix]

  // Extract prefix (everything before export default definePlugin)
  const prefix = source.slice(0, startIdx)
  // Extract suffix (everything after the closing `})` + `;`)
  const suffix = source.slice(endIdx + 1).replace(/^\s*;?\s*/, '').trimStart()

  // Check if migrations property was in the body
  const hasMigrations = /,\s*migrations\s*,/.test(body) || /migrations\s*,?\s*\n/.test(body)

  const newManifest = `definePlugin({\n${manifestPart.trim()}\n})`

  let newSource = prefix + `export default ${newManifest}\n\n`
  if (hasMigrations) {
    newSource += `export async function install(api: any) {\n`
    newSource += `  for (const migration of migrations) {\n`
    newSource += `    await api.cms.migrations.register(migration)\n`
    newSource += `  }\n}\n\n`
  }
  newSource += `export async function activate(api: any) {\n${activateImpl}\n}\n\n`
  if (deactivateImpl) {
    newSource += `export async function deactivate(api: any) {\n${deactivateImpl}\n}\n\n`
  } else {
    newSource += `export async function deactivate(api: any) {\n  // Host automatically removes registered routes / migrations / gates.\n}\n\n`
  }
  newSource += suffix

  await writeFile(filePath, newSource, 'utf-8')
  console.log(`  ${name.padEnd(20)} - refactored`)
}

console.log('Refactoring plugins to use proper SDK lifecycle pattern:\n')
for (const name of plugins) {
  try {
    await refactorPlugin(name)
  } catch (err) {
    console.log(`  ${name.padEnd(20)} - ERROR: ${err instanceof Error ? err.message : err}`)
  }
}
console.log('\nDone')
