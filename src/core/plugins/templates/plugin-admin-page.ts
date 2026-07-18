// ---------------------------------------------------------------------------
// plugin-admin-page — a plugin that ships a CMS admin page
// ---------------------------------------------------------------------------

import {
  definePlugin,
  permissions,
  PLUGIN_API_VERSION,
  type PluginAdminPage,
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
import type { TemplateParamSpec, TemplateManifest } from './types'

const EXTRA_PARAMS: TemplateParamSpec[] = [
  {
    id: 'adminPageKind',
    label: 'Admin page kind',
    type: 'select',
    default: 'markdown',
    options: [
      { label: 'Markdown (static content)', value: 'markdown' },
      { label: 'App (interactive UI)', value: 'app' },
    ],
    description:
      'Markdown pages render inline content; app pages load a bundled JS entry into the admin shell.',
  },
  {
    id: 'adminPageTitle',
    label: 'Admin page title',
    type: 'string',
    required: false,
    placeholder: 'Overview',
    description: 'Defaults to the display name when left blank.',
  },
]

export const pluginAdminPage: TemplateManifest = {
  id: 'plugin-admin-page',
  kind: 'plugin',
  label: 'Plugin with Admin Page',
  description: 'Registers a custom page in the CMS admin sidebar (markdown or app).',
  params: [...COMMON_PARAMS, ...EXTRA_PARAMS],
  generate(params) {
    const pluginId = String(params.pluginId ?? '')
    const name = String(params.name ?? '')
    const version = String(params.version ?? '0.1.0')
    const description = params.description ? String(params.description) : undefined
    const authorName = params.authorName ? String(params.authorName) : undefined
    const adminPageKind = String(params.adminPageKind ?? 'markdown') === 'app' ? 'app' : 'markdown'
    const adminPageTitle = params.adminPageTitle ? String(params.adminPageTitle) : name

    // 1. Build the admin page manifest entry.
    const adminPage: PluginAdminPage =
      adminPageKind === 'app'
        ? {
            id: 'overview',
            title: adminPageTitle,
            content: {
              kind: 'app',
              heading: adminPageTitle,
              entry: 'admin/index.js',
            },
          }
        : {
            id: 'overview',
            title: adminPageTitle,
            content: {
              kind: 'markdown',
              heading: adminPageTitle,
              body: `# ${adminPageTitle}\n\nWelcome to your plugin admin page. Edit this content in \`src/index.ts\`.`,
            },
          }

    // Use a conditional expression so TypeScript infers a union array type
    // (`('admin.navigation' | 'editor.code')[]`) assignable to PluginPermission[].
    // The push() pattern infers too narrowly ('admin.navigation'[]) and rejects
    // the 'editor.code' value at the call site.
    const perms =
      adminPageKind === 'app'
        ? [permissions.adminNavigation, permissions.editorCode]
        : [permissions.adminNavigation]

    const definition = definePlugin({
      id: pluginId,
      name,
      version,
      apiVersion: PLUGIN_API_VERSION,
      permissions: perms,
      adminPages: [adminPage],
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
      adminPageKind,
      adminPageTitle,
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

    if (adminPageKind === 'app') {
      files['admin/index.ts'] = ADMIN_APP_STUB
    }

    return { files, manifest, warnings: [] }
  },
}

interface IndexTsOpts {
  pluginId: string
  name: string
  version: string
  description?: string
  adminPageKind: 'markdown' | 'app'
  adminPageTitle: string
}

function generateIndexTs(opts: IndexTsOpts): string {
  const permLines =
    opts.adminPageKind === 'app'
      ? '  permissions: [permissions.adminNavigation, permissions.editorCode],'
      : '  permissions: [permissions.adminNavigation],'

  const adminPagesBlock =
    opts.adminPageKind === 'app'
      ? `  adminPages: [
    {
      id: "overview",
      title: ${safeStr(opts.adminPageTitle)},
      content: {
        kind: "app",
        heading: ${safeStr(opts.adminPageTitle)},
        entry: "admin/index.js",
      },
    },
  ],`
      : `  adminPages: [
    {
      id: "overview",
      title: ${safeStr(opts.adminPageTitle)},
      content: {
        kind: "markdown",
        heading: ${safeStr(opts.adminPageTitle)},
        body: "# ${escapeMarkdownHeading(opts.adminPageTitle)}\\n\\nWelcome to your plugin admin page.",
      },
    },
  ],`

  return `import {
  definePlugin,
  permissions,
  PLUGIN_API_VERSION,
} from '@instatic/plugin-sdk'

export default definePlugin({
  id: ${safeStr(opts.pluginId)},
  name: ${safeStr(opts.name)},
  version: ${safeStr(opts.version)},
  apiVersion: PLUGIN_API_VERSION,
${permLines}
${adminPagesBlock}${opts.description ? `\n  description: ${safeStr(opts.description)},` : ''}
})
`
}

/**
 * Escape a user-provided heading so it is safe inside a markdown body string
 * literal. The body is emitted as a double-quoted JS string, so we rely on
 * safeStr for the outer quoting and only need to prevent the heading text
 * from containing characters that would break the markdown rendering.
 */
function escapeMarkdownHeading(text: string): string {
  return text.replace(/"/g, '')
}

const ADMIN_APP_STUB = `// Admin app entry — dynamically imported into the admin window.
// Replace this stub with your admin UI component.
export default {
  mount(root: HTMLElement) {
    root.innerHTML = '<h1>Admin App</h1><p>Replace this with your UI.</p>'
  },
  unmount() {
    // Cleanup
  },
}
`
