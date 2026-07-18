// ---------------------------------------------------------------------------
// plugin-routes — a plugin that declares a storage resource + CRUD routes
// ---------------------------------------------------------------------------

import {
  definePlugin,
  permissions,
  PLUGIN_API_VERSION,
  type PluginManifest,
  type PluginResource,
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
import type { TemplateParamSpec, TemplateManifest } from './types'

const EXTRA_PARAMS: TemplateParamSpec[] = [
  {
    id: 'resourceId',
    label: 'Resource id',
    type: 'string',
    default: 'items',
    description: 'Lowercase kebab-case slug used as the storage collection key.',
    placeholder: 'items',
  },
  {
    id: 'resourceTitle',
    label: 'Resource title',
    type: 'string',
    default: 'Items',
    description: 'Human-readable label shown in the admin UI.',
    placeholder: 'Items',
  },
]

export const pluginRoutes: TemplateManifest = {
  id: 'plugin-routes',
  kind: 'plugin',
  label: 'Plugin with CRUD Routes',
  description: 'Declares a storage resource and registers list / create HTTP routes.',
  params: [...COMMON_PARAMS, ...EXTRA_PARAMS],
  generate(params) {
    const pluginId = String(params.pluginId ?? '')
    const name = String(params.name ?? '')
    const version = String(params.version ?? '0.1.0')
    const description = params.description ? String(params.description) : undefined
    const authorName = params.authorName ? String(params.authorName) : undefined
    const resourceId = String(params.resourceId ?? 'items')
    const resourceTitle = String(params.resourceTitle ?? 'Items')

    // 1. Build the resource + manifest.
    const resource: PluginResource = {
      id: resourceId,
      title: resourceTitle,
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
      ],
    }

    const definition = definePlugin({
      id: pluginId,
      name,
      version,
      apiVersion: PLUGIN_API_VERSION,
      permissions: [permissions.cmsRoutes, permissions.cmsStorage],
      resources: [resource],
      ...(description ? { description } : {}),
      ...(authorName ? { author: { name: authorName } } : {}),
    })

    // 2. Round-trip validate.
    const manifest: PluginManifest = parsePluginManifest(definition.manifest)

    // 3. Generate file contents.
    const indexTs = generateIndexTs({
      pluginId,
      name,
      version,
      description,
      resourceId,
      resourceTitle,
    })

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

interface IndexTsOpts {
  pluginId: string
  name: string
  version: string
  description?: string
  resourceId: string
  resourceTitle: string
}

function generateIndexTs(opts: IndexTsOpts): string {
  const resourcePath = '/' + opts.resourceId

  return `import {
  definePlugin,
  permissions,
  PLUGIN_API_VERSION,
  type ServerPluginApi,
  type ServerPluginModule,
} from '@instatic/plugin-sdk'

export default definePlugin({
  id: ${safeStr(opts.pluginId)},
  name: ${safeStr(opts.name)},
  version: ${safeStr(opts.version)},
  apiVersion: PLUGIN_API_VERSION,
  permissions: [permissions.cmsRoutes, permissions.cmsStorage],
  resources: [
    {
      id: ${safeStr(opts.resourceId)},
      title: ${safeStr(opts.resourceTitle)},
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
      ],
    },
  ],${opts.description ? `\n  description: ${safeStr(opts.description)},` : ''}
})

export const activate: ServerPluginModule['activate'] = async (api: ServerPluginApi) => {
  const collection = api.cms.storage.collection(${safeStr(opts.resourceId)})

  // List all records.
  api.cms.routes.get(${safeStr(resourcePath)}, "content.read", async () => {
    return await collection.list()
  })

  // Create a new record.
  api.cms.routes.post(${safeStr(resourcePath)}, "content.manage", async (ctx) => {
    const name = typeof ctx.body.name === "string" ? ctx.body.name : "untitled"
    return await collection.create({ name })
  })

  api.plugin.log("Plugin activated")
}
`
}
