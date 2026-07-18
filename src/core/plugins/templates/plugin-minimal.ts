// ---------------------------------------------------------------------------
// plugin-minimal — the bare plugin skeleton
// ---------------------------------------------------------------------------

import {
  definePlugin,
  PLUGIN_API_VERSION,
  type PluginManifest,
} from '../../plugin-sdk'
import { parsePluginManifest } from '../manifest'
import {
  COMMON_PARAMS,
  generatePackageJson,
  generateReadme,
  generateTsconfig,
  GITIGNORE,
  safeStr,
} from './shared'
import type { TemplateManifest } from './types'

export const pluginMinimal: TemplateManifest = {
  id: 'plugin-minimal',
  kind: 'plugin',
  label: 'Minimal Plugin',
  description: 'A bare plugin skeleton with no permissions — a clean starting point.',
  params: COMMON_PARAMS,
  generate(params) {
    const pluginId = String(params.pluginId ?? '')
    const name = String(params.name ?? '')
    const version = String(params.version ?? '0.1.0')
    const description = params.description ? String(params.description) : undefined
    const authorName = params.authorName ? String(params.authorName) : undefined

    // 1. Build the manifest via the typed SDK helper.
    const definition = definePlugin({
      id: pluginId,
      name,
      version,
      apiVersion: PLUGIN_API_VERSION,
      permissions: [],
      ...(description ? { description } : {}),
      ...(authorName ? { author: { name: authorName } } : {}),
    })

    // 2. Round-trip validate through the host manifest parser so the
    //    GeneratedProject.manifest carries normalised defaults.
    const manifest: PluginManifest = parsePluginManifest(definition.manifest)

    // 3. Generate file contents.
    const indexTs = `import {
  definePlugin,
  PLUGIN_API_VERSION,
  type ServerPluginApi,
  type ServerPluginModule,
} from '@instatic/plugin-sdk'

export default definePlugin({
  id: ${safeStr(pluginId)},
  name: ${safeStr(name)},
  version: ${safeStr(version)},
  apiVersion: PLUGIN_API_VERSION,
  permissions: [],${description ? `\n  description: ${safeStr(description)},` : ''}
})

export const activate: ServerPluginModule['activate'] = async (api: ServerPluginApi) => {
  api.plugin.log("Plugin activated")
}
`

    const files: Record<string, string> = {
      'src/index.ts': indexTs,
      'package.json': generatePackageJson({
        pluginId,
        name,
        version,
        description,
        authorName,
        manifest,
      }),
      'tsconfig.json': generateTsconfig(),
      'README.md': generateReadme({ name, pluginId, kind: 'plugin', description }),
      '.gitignore': GITIGNORE,
    }

    return { files, manifest, warnings: [] }
  },
}
