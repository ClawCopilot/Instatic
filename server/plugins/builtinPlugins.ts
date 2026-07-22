import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import type { DbClient } from '../db/client'
import { parsePluginManifest } from '@core/plugins/manifest'
import type { PluginManifest, PluginPermission } from '@core/plugin-sdk'

// ---------------------------------------------------------------------------
// Built-in plugin directories
// ---------------------------------------------------------------------------

const MAIN_PLUGINS = [
  'api-keys',
  'public-auth',
  'membership',
  'commerce',
  'oidc-provider',
  'notifications',
  'social-login',
  'rate-limit',
] as const

const SKILLS = [
  'agent-bridge',
  'code-helper',
  'comment-system',
  'content-assistant',
  'design-advisor',
  'graphic-designer',
  'humanizer',
  'image-generator',
  'layout-builder',
  'site-api',
  'social-media',
  'weather',
  'web-research',
  'youtube-summarizer',
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, '..', '..')

function readPluginManifest(pluginDir: string): PluginManifest {
  const pkgPath = join(ROOT, 'plugins', pluginDir, 'package.json')
  const skillPath = join(ROOT, 'plugins', 'skills', pluginDir, 'package.json')

  const filePath = existsSync(pkgPath) ? pkgPath : skillPath

  if (!filePath || !existsSync(filePath)) {
    throw new Error(`[builtinPlugins] package.json not found for plugin "${pluginDir}"`)
  }

  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))

  if (!raw.instaticManifest) {
    throw new Error(`[builtinPlugins] no instaticManifest in package.json for "${pluginDir}"`)
  }

  return parsePluginManifest(raw.instaticManifest)
}

function writeJson(value: unknown): string {
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// seedBuiltinPlugins
// ---------------------------------------------------------------------------

/**
 * Ensure every built-in plugin (and skill) has a row in `installed_plugins`.
 *
 * Idempotent — safe to call on every server boot:
 *  - New plugins are inserted with `enabled = 1` and default settings.
 *  - Existing plugins have their `name`, `version`, `manifest_json`, and
 *    `granted_permissions_json` updated to match the on-disk manifest.
 *  - The user's `enabled` choice and `settings_json` are never overwritten.
 *  - `lifecycle_status` is reset to `'installed'` and `last_error` cleared
 *    so built-in plugins always start from a clean state after a reboot.
 */
export async function seedBuiltinPlugins(db: DbClient): Promise<void> {
  const dirs = [...MAIN_PLUGINS, ...SKILLS]

  for (const dir of dirs) {
    const manifest = readPluginManifest(dir)
    const grantedPermissions: PluginPermission[] = (manifest as any).grantedPermissions ?? (manifest as any).permissions ?? []
    const manifestToStore = { ...manifest, grantedPermissions }
    const now = new Date().toISOString()

    const sql = `
      INSERT INTO installed_plugins (id, name, version, source, enabled, granted_permissions_json, manifest_json, lifecycle_status, last_error, settings_json, installed_at, updated_at)
      VALUES (?, ?, ?, 'builtin', 1, ?, ?, 'installed', NULL, '{}', ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        version = excluded.version,
        source = 'builtin',
        manifest_json = excluded.manifest_json,
        granted_permissions_json = excluded.granted_permissions_json,
        lifecycle_status = 'installed',
        last_error = NULL,
        updated_at = current_timestamp
    `

    await db.unsafe(sql, [
      manifest.id,
      manifest.name,
      manifest.version,
      writeJson(grantedPermissions),
      writeJson(manifestToStore),
      now,
      now,
    ])
  }
}
